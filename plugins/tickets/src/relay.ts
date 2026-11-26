import type { Context, Json, Member, MessagePayload } from "@cicord/sdk";
import {
  addEvent,
  getTicket,
  lastActivityKey,
  relayAllowed,
  relayRecipient,
  saveTicket,
  ticketChannel,
  ticketKey,
  isStaff,
  verifyReaders,
  type Ticket,
} from "./tickets.ts";
import type { Person } from "./routes.ts";
import { whoKey } from "./indexes.ts";
import { removeOwn } from "./messages.ts";

type Kind = "inbound" | "outbound" | "portal";
type Target = { kind: "channel" | "dm"; id?: string; delivered?: boolean };
type Relay = {
  origin: string;
  ticket: number;
  kind: Kind;
  author: Person;
  text: string;
  at: string;
  targets: Target[];
};
const noMentions = { users: false, roles: false, everyone: false } as const;
const prefix = (n: number) => "relay:" + n + ":";
const keyOf = (r: Relay) => prefix(r.ticket) + r.kind + ":" + r.origin;
const token = (s: string) => {
  let h = 14695981039346656037n;
  for (const ch of s) h = BigInt.asUintN(64, (h ^ BigInt(ch.codePointAt(0)!)) * 1099511628211n);
  return h.toString(36);
};

async function pending(ctx: Context, key: string) {
  const entry = await ctx.kv.getEntry(key);
  return entry ? { relay: entry.value as unknown as Relay, version: entry.version } : undefined;
}

async function activeMember(ctx: Context, t: Ticket, r: Relay): Promise<Member | undefined> {
  if (t.erasing || t.status !== "open" || !t.channelId) return undefined;
  if (r.kind === "inbound") {
    if (t.author.id !== r.author.id) return undefined;
    const member = await ctx.server.member(t.author.id);
    return member && (await relayAllowed(ctx, t, member)) ? member : undefined;
  }
  if (r.kind === "portal" && t.source !== "modmail") {
    const staff = await ctx.server.member(r.author.id);
    if (!staff || !isStaff(ctx, staff, t.type)) return undefined;
    const proof = await verifyReaders(ctx, t, { viewer: staff.id });
    return proof?.confined && proof.viewerCanRead ? staff : undefined;
  }
  return relayRecipient(ctx, t, r.author.id);
}

function payload(ctx: Context, r: Relay, target: Target): MessagePayload {
  if (r.kind === "portal" && target.kind === "channel")
    return {
      embeds: [
        {
          description: r.text,
          color: ctx.config.panel.color,
          footer: { text: ctx.i18n.t("replyAuthor", { staff: r.author.displayName }) },
        },
      ],
      allowedMentions: noMentions,
    };
  return { content: r.text, allowedMentions: noMentions };
}

async function retract(ctx: Context, t: Ticket, target: Target) {
  if (!target.id) return;
  if (target.kind === "dm") {
    await ctx.server.retractDM(target.id);
    return;
  }
  const channel = ticketChannel(ctx, t);
  if (channel) await removeOwn(ctx, await channel.message(target.id), "Ticket relay removed");
}

async function abort(ctx: Context, t: Ticket, r: Relay, version: string) {
  // Removing a reserved message invalidates even an already in-flight edit. Edits cannot
  // recreate deleted messages. An unacknowledged send contained only a neutral placeholder.
  for (const target of r.targets) await retract(ctx, t, target);
  const removed = await ctx.kv.atomic().check(keyOf(r), version).delete(keyOf(r)).commit();
  if (!removed.ok && (await ctx.kv.get(keyOf(r))))
    throw new Error("Relay changed during withdrawal");
}

export async function deliverRelay(ctx: Context, key: string): Promise<string | undefined> {
  for (;;) {
    const entry = await pending(ctx, key);
    if (!entry) return undefined;
    const r = entry.relay;
    const t = await getTicket(ctx, r.ticket);
    if (!t) {
      throw new Error("Relay ticket is missing");
    }
    if (t.erasing) return undefined;
    const member = await activeMember(ctx, t, r);
    if (!member) {
      await abort(ctx, t, r, entry.version);
      return undefined;
    }
    const channel = ticketChannel(ctx, t);
    if (!channel) return undefined;
    const target = r.targets.find((x) => !x.delivered);
    if (!target) {
      const ch = r.targets.find((v) => v.kind === "channel")?.id;
      const dm = r.targets.find((v) => v.kind === "dm")?.id;
      if (ch && !(t.copies ?? []).some((c) => c.messageId === ch))
        t.copies = [...(t.copies ?? []), { userId: r.author.id, messageId: ch, origin: r.origin }];
      if (dm && !(t.directCopies ?? []).some((c) => c.messageId === dm))
        t.directCopies = [
          ...(t.directCopies ?? []),
          {
            authorId: r.author.id,
            messageId: dm,
            sourceMessageId: r.kind === "outbound" ? r.origin : ch,
            origin: r.origin,
          },
        ];
      if (
        r.kind === "portal" &&
        ch &&
        !t.events.some((e) => e.type === "replied" && e.detail === ch)
      )
        addEvent(t, "replied", r.author, ch, r.at);
      if (r.kind !== "inbound") t.firstResponseAt ??= r.at;
      delete t.warningAt;
      await saveTicket(ctx, t);
      const done = await ctx.kv
        .atomic()
        .check(key, entry.version)
        .delete(key)
        .set(lastActivityKey(t.number), r.at)
        .increment("activity:" + t.number)
        .commit();
      if (!done.ok) continue;
      return ch ?? dm;
    }
    if (!target.id) {
      const marker =
        "relay-" +
        token(
          ctx.bot.key +
            "/" +
            ctx.plugin.instance +
            "/" +
            ctx.server.id +
            "/" +
            key +
            "/" +
            target.kind,
        );
      const shell: MessagePayload = {
        content: ctx.i18n.t("relayPending"),
        nonce: marker,
        enforceNonce: true,
        allowedMentions: noMentions,
      };
      const sent =
        target.kind === "channel"
          ? await channel.send(shell)
          : await member.send(shell, { retractable: true });
      target.id = sent.id;
      const kept = await ctx.kv
        .atomic()
        .check(key, entry.version)
        .set(key, r as unknown as Json)
        .commit();
      if (!kept) {
        const newest = await pending(ctx, key);
        if (!newest || !newest.relay.targets.some((x) => x.id === sent.id))
          await retract(ctx, t, target);
      }
      continue;
    }
    // Its ID is durable before this first private edit. Replays edit the same ID.
    if (target.kind === "dm")
      await ctx.server.editRetractableDM(target.id, payload(ctx, r, target));
    else {
      const sent = await channel.message(target.id);
      if (!sent) {
        await abort(ctx, t, r, entry.version);
        return undefined;
      }
      await sent.edit(payload(ctx, r, target));
    }
    target.delivered = true;
    await ctx.kv
      .atomic()
      .check(key, entry.version)
      .set(key, r as unknown as Json)
      .commit();
  }
}

export async function relay(
  ctx: Context,
  t: Ticket,
  kind: Kind,
  author: Person,
  text: string,
  origin: string,
  at: Date,
) {
  const prior =
    kind === "outbound"
      ? t.directCopies?.find((c) => c.origin === origin)
      : t.copies?.find((c) => c.origin === origin);
  if (prior) return prior.messageId;
  const r: Relay = {
    ticket: t.number,
    origin,
    kind,
    author,
    text,
    at: at.toISOString(),
    targets:
      kind === "portal" && t.source === "modmail"
        ? [{ kind: "channel" }, { kind: "dm" }]
        : [{ kind: kind === "outbound" ? "dm" : "channel" }],
  };
  const key = keyOf(r);
  if (!(await activeMember(ctx, t, r))) return undefined;
  // Pending relay text is personal data before the ticket record names its author.
  await ctx.kv.set(whoKey(author.id, t.number), true);
  const ticketEntry = await ctx.kv.getEntry(ticketKey(t.number));
  const current = ticketEntry?.value as unknown as Ticket | undefined;
  if (!ticketEntry || !current || current.erasing || (current.revision ?? 0) !== (t.revision ?? 0))
    throw new Error("Ticket changed before relay");
  const accepted = await ctx.kv
    .atomic()
    .check(ticketKey(t.number), ticketEntry.version)
    .check(key, null)
    .set(key, r as unknown as Json)
    .commit();
  if (!accepted.ok && !(await pending(ctx, key))) throw new Error("Ticket changed before relay");
  return deliverRelay(ctx, key);
}

export async function pendingRelays(ctx: Context, n: number) {
  const rows: Relay[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list({
      prefix: prefix(n),
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.items.map((i) => i.value as unknown as Relay));
    cursor = page.cursor;
  } while (cursor);
  return rows;
}
/** Resumes one page of pending relays (every ticket); returns the next page's cursor. */
export async function repairRelayPage(ctx: Context, cursor: string | undefined, limit: number) {
  const page = await ctx.kv.list({ prefix: "relay:", limit, ...(cursor ? { cursor } : {}) });
  for (const { key } of page.items) {
    try {
      await deliverRelay(ctx, key);
    } catch (error) {
      ctx.log.warn("Relay repair deferred", { key, error: String(error) });
    }
  }
  return page.cursor;
}

export async function eraseRelays(ctx: Context, t: Ticket, userId: string) {
  let erased = 0;
  for (const row of await pendingRelays(ctx, t.number)) {
    if (row.author.id !== userId && t.author.id !== userId) continue;
    const entry = await pending(ctx, keyOf(row));
    if (!entry) continue;
    await abort(ctx, t, entry.relay, entry.version);
    erased++;
  }
  return erased;
}
