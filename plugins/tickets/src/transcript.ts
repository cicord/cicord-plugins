import type { Context, Json } from "@cicord/sdk";
import {
  allTickets,
  person,
  redactLive,
  saveTicket,
  ticketChannel,
  ticketType,
  type Ticket,
} from "./tickets.ts";
import type { Person } from "./routes.ts";

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
  for (;;) {
    const batch = await channel.messages({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.length) break;
    const lines: Line[] = [];
    for (const m of await redactLive(ctx, t, batch)) {
      const userId = copied.get(m.id);
      if (m.author.bot && !userId) continue;
      const by = userId ? personForCopy(t, userId) : person(m.author, m.member);
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
  const heading = `Ticket #${t.number}: ${t.subject}`;
  const lines: Line[] = [{ author: t.author, at: t.createdAt, text: t.description }];
  for (let page = (t.transcriptPages ?? 0) - 1; page >= 0; page--)
    lines.push(...(await readPage(ctx, t, page)).reverse());
  const encoder = new TextEncoder();
  const markdown = (s: string) => html(s).replace(/[\\*_`[\]()#!|]/g, (c) => "\\" + c);
  const wrap = (body: string) =>
    format === "markdown"
      ? "# " + markdown(heading) + "\n\n" + body
      : '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><meta name="viewport" content="width=device-width"><style>body{max-width:52rem;margin:2rem auto;font:1rem system-ui;padding:1rem}p{white-space:pre-wrap;overflow-wrap:anywhere}time{color:#555}</style><title>' +
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

export async function removeLogCopy(ctx: Context, t: Ticket) {
  if (!t.logCopy) return;
  const channel = ctx.server.channel({ id: t.logCopy.channelId });
  const message = await channel.message(t.logCopy.messageId);
  if (message) await message.delete("Ticket transcript retention or privacy request");
  delete t.logCopy;
}

export async function purgeArchive(ctx: Context, t: Ticket) {
  await removeLogCopy(ctx, t);
  for (let p = 0; p < (t.transcriptPages ?? 0); p++) await ctx.kv.delete(pageKey(t, p));
  delete t.transcriptPages;
  delete t.expiresAt;
}

export async function postArchive(ctx: Context, t: Ticket) {
  const key = ticketType(ctx, t.type)?.logChannel;
  if (!key) return;
  const channel = ctx.server.channel(key);
  const audience = ctx.server.compareAudience({ id: t.channelId }, channel);
  let link = "";
  try {
    link = await ctx.portal.link("/tickets?ticket=" + t.number);
  } catch {
    ctx.log.warn("Portal link unavailable", { ticket: t.number });
  }
  const files = [];
  if (audience === "same" || audience === "narrower") {
    for (const format of ["html", "markdown"] as const) {
      const content = await renderTranscript(ctx, t, format);
      if (content !== undefined)
        files.push({
          name: `ticket-${t.id}.${format === "html" ? "html" : "md"}`,
          contentType: format === "html" ? "text/html" : "text/markdown",
          data: new TextEncoder().encode(content),
        });
    }
  }
  const log = await channel.send({
    content: `Ticket #${t.number} closed. ${link}`,
    ...(files.length ? { files } : {}),
    allowedMentions: { everyone: false, roles: false, users: false },
  });
  if (files.length) {
    t.logCopy = { channelId: channel.id, messageId: log.id };
    await saveTicket(ctx, t);
  }
}

/** Discord attachment URLs can remain readable to the current audience of their log
 * message. Withdraw the message when its permission context changes after closing. */
export async function withdrawCopies(ctx: Context, channelId?: string) {
  for (const t of await allTickets(ctx)) {
    if (!t.logCopy) continue;
    if (
      channelId &&
      t.logCopy.channelId !== channelId &&
      ctx.server.channel({ id: t.logCopy.channelId }).categoryId !== channelId
    )
      continue;
    t.withdrawLog = true;
    await saveTicket(ctx, t);
    await removeLogCopy(ctx, t);
    delete t.withdrawLog;
    await saveTicket(ctx, t);
  }
}
