import type { Context, Json } from "@cicord/sdk";
import {
  normalize,
  authorNames,
  redactLive,
  saveTicket,
  ticketChannel,
  ticketType,
  verifyReaders,
  type Ticket,
} from "./tickets.ts";
import type { Person } from "./routes.ts";
import { mentioned, whoKey } from "./indexes.ts";

declare const TextEncoder: { new (): { encode(value: string): Uint8Array } };

export type Line = { author: Person; at: string; text: string };
const pageKey = (t: Ticket, page: number) => `transcript:${t.number}:${page}`;

export async function readPage(ctx: Context, t: Ticket, page: number): Promise<Line[]> {
  return ((await ctx.kv.get(pageKey(t, page))) ?? []) as unknown as Line[];
}

export async function writePage(ctx: Context, t: Ticket, page: number, lines: Line[]) {
  await ctx.kv.set(pageKey(t, page), lines as unknown as Json, {
    ttlSeconds: Math.max(1, Math.ceil(((t.expiresAt ?? Date.now()) - Date.now()) / 1000)),
  });
}

/** Read Discord history newest first; store pages separately so a long channel fits the KV limit. */
export async function archive(ctx: Context, t: Ticket) {
  const channel = ticketChannel(ctx, t);
  if (!channel) throw new Error("Ticket channel unavailable");
  t.expiresAt = Date.now() + ctx.config.transcriptRetentionDays * 86400000;
  const participants = new Map<string, Person>();
  const copied = new Map((t.copies ?? []).map((c) => [c.messageId, c.userId]));
  let before: string | undefined;
  let messages = 0;
  let pages = 0;
  // Fetched messages carry no member: server display names come from the record or a bounded lookup.
  const nameOf = authorNames(ctx, t);
  for (;;) {
    const batch = await channel.messages({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.length) break;
    const lines: Line[] = [];
    for (const m of redactLive(t, batch)) {
      const userId = copied.get(m.id);
      if (m.author.bot && !userId) continue;
      const by = userId ? personForCopy(t, userId) : await nameOf(m.author);
      participants.set(by.id, by);
      messages++;
      lines.push({
        author: by,
        at: m.createdAt.toISOString(),
        text: [
          m.content,
          ...(m.embeds ?? []).map((e) => e.description ?? ""),
          ...(m.attachments ?? []).map((a) => a.filename),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
    // Archived lines can name members the record does not: index them for privacy hooks
    // for as long as the pages themselves live.
    const named = new Set<string>();
    for (const l of lines) {
      named.add(l.author.id);
      mentioned(l.text, named);
    }
    const ttlSeconds = Math.max(1, Math.ceil((t.expiresAt - Date.now()) / 1000));
    for (const id of named) await ctx.kv.set(whoKey(id, t.number), true, { ttlSeconds });
    // Up to 20 messages per KV value, even when embeds are unusually large.
    for (let start = 0; start < lines.length; start += 20)
      await writePage(ctx, t, pages++, lines.slice(start, start + 20));
    if (batch.length < 100) break;
    const next = batch[batch.length - 1]!.id;
    if (next === before) throw new Error("Discord history cursor did not advance");
    before = next;
  }
  t.transcriptPages = pages;
  return { messages, participants };
}

function personForCopy(t: Ticket, id: string): Person {
  return (
    [t.author, ...t.events.map((e) => e.by)].find((p) => p.id === id) ?? { id, displayName: id }
  );
}

function html(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export async function renderTranscript(ctx: Context, t: Ticket, format: "html" | "markdown") {
  if (!t.expiresAt || Date.now() >= t.expiresAt) return undefined;
  const heading = ctx.i18n.t("archiveHeading", { number: t.number, subject: t.subject });
  const lines: Line[] = [{ author: t.author, at: t.createdAt, text: t.description }];
  for (let page = (t.transcriptPages ?? 0) - 1; page >= 0; page--)
    lines.push(...(await readPage(ctx, t, page)).reverse());
  const encoder = new TextEncoder();
  const markdown = (s: string) => html(s).replace(/[\\*_`[\]()#!|]/g, (c) => "\\" + c);
  const wrap = (body: string) =>
    format === "markdown"
      ? "# " + markdown(heading) + "\n\n" + body
      : '<!doctype html><html lang="' +
        html(ctx.i18n.t("language")) +
        '"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><meta name="viewport" content="width=device-width"><style>body{max-width:52rem;margin:2rem auto;font:1rem system-ui;padding:1rem}p{white-space:pre-wrap;overflow-wrap:anywhere}time{color:#555}</style><title>' +
        html(heading) +
        "</title><h1>" +
        html(heading) +
        "</h1>" +
        body +
        "</html>";
  const row = (l: Line, text: string) =>
    format === "markdown"
      ? `**${markdown(l.author.displayName)}** · ${l.at}\n\n${text
          .split("\n")
          .map((s) => "    " + s)
          .join("\n")}\n\n`
      : `<article><b>${html(l.author.displayName)}</b> <time>${html(l.at)}</time><p>${html(text)}</p></article>`;
  const full = wrap(lines.map((l) => row(l, l.text)).join(""));
  const maxBytes = 2 * 1024 * 1024 - 1;
  if (encoder.encode(full).length <= maxBytes) return full;
  // A pathological 500-message channel can exceed 2 MiB even without markup. Keep every
  // timestamp and speaker, mark shortened lines, and retain the original in KV until expiry.
  const budget = Math.floor((maxBytes - encoder.encode(wrap("")).length) / lines.length);
  return wrap(
    lines
      .map((l) => {
        if (encoder.encode(row(l, l.text)).length <= budget) return row(l, l.text);
        const chars = Array.from(l.text);
        let lo = 0,
          hi = chars.length;
        while (lo < hi) {
          const n = Math.ceil((lo + hi) / 2);
          if (encoder.encode(row(l, chars.slice(0, n).join("") + "…")).length <= budget) lo = n;
          else hi = n - 1;
        }
        return row(l, chars.slice(0, lo).join("") + "…");
      })
      .join(""),
  );
}

const mentions = { everyone: false, users: false, roles: false } as const;

/** Only attachment edits can expose private content. Always know which message to delete
 * before attempting the edit. A lost acknowledgement leaves a durable "attaching" receipt. */
export async function removeLogCopy(ctx: Context, t: Ticket) {
  const receipt = t.logDelivery;
  const filed = !!t.logCopy || receipt?.phase === "attached" || receipt?.phase === "attaching";
  if (filed && !ctx.features.enabled("managedMessages")) {
    // Overwriting text keeps Discord attachments: only deletion withdraws the files.
    ctx.status.set(
      "transcriptFiles",
      "Attached transcript files cannot be withdrawn without discord.messages.manage",
    );
    throw new Error("Transcript copy withdrawal needs discord.messages.manage");
  }
  if (
    receipt &&
    (receipt.phase === "attached" || receipt.phase === "attaching") &&
    receipt.messageId
  ) {
    const m = await ctx.server.channel({ id: receipt.channelId }).message(receipt.messageId);
    if (m) await m.delete("Ticket transcript withdrawn");
    delete receipt.messageId;
    receipt.phase = "pending";
  }
  if (t.logCopy) {
    const m = await ctx.server.channel({ id: t.logCopy.channelId }).message(t.logCopy.messageId);
    if (m) await m.delete("Ticket transcript withdrawn");
    delete t.logCopy;
  }
}

export async function purgeArchive(ctx: Context, t: Ticket) {
  await removeLogCopy(ctx, t);
  if (t.archivePolicy) {
    await ctx.server.deleteChannel({ id: t.channelId }, "Ticket transcript retention");
    t.channelRemoved = true;
    delete t.archivePolicy;
    delete t.archiveRoles;
  }
  for (let p = 0; p < (t.transcriptPages ?? 0); p++) await ctx.kv.delete(pageKey(t, p));
  delete t.logDelivery;
  delete t.transcriptPages;
  delete t.expiresAt;
}

async function copyAllowed(ctx: Context, t: Ticket) {
  const dest = t.logDelivery;
  const type = ticketType(ctx, t.type);
  if (
    !dest ||
    !type ||
    // A file-bearing copy is only posted when the bot may also delete it later.
    !ctx.features.enabled("managedMessages") ||
    !("retainSourceForTranscript" in type) ||
    !type.retainSourceForTranscript ||
    !type.logChannel ||
    !t.archivePolicy ||
    !t.expiresAt ||
    Date.now() >= t.expiresAt ||
    t.channelRemoved
  )
    return false;
  if (JSON.stringify([...type.staffRoles].sort()) !== JSON.stringify(t.archiveRoles)) return false;
  try {
    if (ctx.server.channel(type.logChannel).id !== dest.channelId) return false;
    const checked = await verifyReaders(ctx, t, { destination: dest.channelId });
    return (
      !!checked?.known &&
      checked.confined &&
      checked.fingerprint === t.archivePolicy &&
      (checked.destination === "same" || checked.destination === "narrower")
    );
  } catch {
    return false;
  }
}

async function files(ctx: Context, t: Ticket) {
  const result = [];
  for (const f of ["html", "markdown"] as const) {
    const content = await renderTranscript(ctx, t, f);
    if (content === undefined) return [];
    result.push({
      name: `ticket-${t.id}.${f === "html" ? "html" : "md"}`,
      contentType: f === "html" ? "text/html" : "text/markdown",
      data: new TextEncoder().encode(content),
    });
  }
  return result;
}

export async function reconcileCopy(ctx: Context, t: Ticket) {
  // Pre-ledger Discord copies cannot be authorized once their source has disappeared.
  if (t.logCopy) {
    await removeLogCopy(ctx, t);
    await saveTicket(ctx, t);
  }
  const delivery = t.logDelivery;
  if (!delivery) return;
  const destination = ctx.server.channel({ id: delivery.channelId });
  if (
    (delivery.phase === "attached" || delivery.phase === "attaching") &&
    !(await copyAllowed(ctx, t))
  ) {
    await removeLogCopy(ctx, t);
    await saveTicket(ctx, t);
  }
  const footer = { text: delivery.marker };
  const summary = { content: delivery.content, embeds: [{ footer }], allowedMentions: mentions };
  let target = delivery.messageId ? await destination.message(delivery.messageId) : undefined;
  if (!target) {
    // The only send without a stored Discord ID is a content-free shell. Recover its
    // deterministic receipt before any upload. Extra shells can never contain files.
    let before: string | undefined;
    do {
      const page = await destination.messages({ limit: 100, ...(before ? { before } : {}) });
      target = page.find(
        (m) =>
          m.author.id === ctx.bot.user.id && m.embeds.some((e) => e.footer?.text === footer.text),
      );
      if (
        target ||
        page.length < 100 ||
        page[page.length - 1]!.createdAt.getTime() < Date.parse(t.closedAt ?? t.createdAt)
      )
        break;
      const next = page[page.length - 1]!.id;
      if (next === before) throw new Error("Log history cursor did not advance");
      before = next;
    } while (true);
    target ??= await destination.send(summary);
    delivery.messageId = target.id;
    delivery.phase = "summary";
    await saveTicket(ctx, t);
  }
  if (!(await copyAllowed(ctx, t)) || delivery.phase === "attached") return;
  const uploads = await files(ctx, t);
  if (!uploads.length || !(await copyAllowed(ctx, t))) return;
  delivery.phase = "attaching";
  await saveTicket(ctx, t);
  if (!(await copyAllowed(ctx, t))) return;
  await target.edit({ ...summary, files: uploads });
  if (!(await copyAllowed(ctx, t))) {
    await removeLogCopy(ctx, t);
  } else {
    delivery.phase = "attached";
  }
  await saveTicket(ctx, t);
}

export async function postArchive(ctx: Context, t: Ticket) {
  const key = ticketType(ctx, t.type)?.logChannel;
  if (!t.logDelivery && !key) return;
  if (!t.logDelivery && key) {
    let link = "";
    try {
      link = (await ctx.portal.link("/tickets?ticket=" + t.number)).replace(
        /([?&])cicord_token=[^&#]+(&?)/g,
        (_match, sep: string, next: string) => (next ? sep : ""),
      );
    } catch {
      ctx.log.warn("Portal link unavailable", { ticket: t.number });
    }
    const marker = [ctx.bot.key, ctx.plugin.instance, ctx.server.id, t.id, t.closedAt].join("/");
    t.logDelivery = {
      channelId: ctx.server.channel(key).id,
      marker,
      content: ctx.i18n.t("summary", { number: t.number, link }),
      phase: "pending",
    };
    await saveTicket(ctx, t);
  }
  await reconcileCopy(ctx, t);
}

const SWEEP = "sweep:copies";
const SWEEP_PAGE = 10;

/**
 * Rechecks every tracked log copy after a permission or availability change, a bounded page
 * per invocation: the first page runs inline, the rest in `sweepCopies` tasks. A newer
 * request restarts the sweep from the beginning and retires the older one.
 */
export async function requestSweep(ctx: Context) {
  const gen = await ctx.kv.increment(SWEEP);
  await sweepCopies(ctx, { gen });
}

export async function sweepCopies(ctx: Context, payload: unknown) {
  const p = payload as { gen?: unknown; cursor?: unknown } | undefined;
  if (typeof p?.gen !== "number" || (await ctx.kv.get<number>(SWEEP)) !== p.gen) return;
  const cursor = typeof p.cursor === "string" ? p.cursor : undefined;
  const next = await reconcilePage(ctx, cursor, SWEEP_PAGE);
  if (next) await ctx.schedule.after(50, "sweepCopies", { gen: p.gen, cursor: next });
}

/** Reconciles one page of tracked copies; returns the cursor of the next page. */
export async function reconcilePage(ctx: Context, cursor: string | undefined, limit: number) {
  const page = await ctx.kv.list<number>({ prefix: "copy:", limit, ...(cursor ? { cursor } : {}) });
  for (const { key } of page.items) {
    const record = "ticket:" + key.slice("copy:".length);
    const entry = await ctx.kv.getEntry(record);
    const raw = entry?.value as unknown as Ticket | undefined;
    if (!raw?.logDelivery && !raw?.logCopy) {
      // A stale entry; the version check keeps a copy recorded by a concurrent save.
      await ctx.kv.atomic().check(record, entry?.version).delete(key).commit();
      continue;
    }
    const t = normalize(raw);
    try {
      await reconcileCopy(ctx, t);
    } catch (error) {
      ctx.log.warn("Transcript reconciliation deferred", { ticket: t.id, error: String(error) });
    }
  }
  return page.cursor;
}
