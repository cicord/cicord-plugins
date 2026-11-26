import type { Context, Json } from "@cicord/sdk";
import { allTickets, authorKey, openKey, ticketChannel, saveTicket } from "./tickets.ts";
import { readPage, writePage, removeLogCopy } from "./transcript.ts";

export const privacy = {
  async export(ctx: Context, userId: string): Promise<Json> {
    const records: Json[] = [];
    for (const t of await allTickets(ctx)) {
      const own = t.author.id === userId;
      const notes = t.notes.filter((n) => n.by.id === userId);
      const events = t.events
        .filter((e) => e.by.id === userId)
        .map((e) => ({ type: e.type, at: e.at }));
      const messages: { at: string; text: string }[] = [];
      const live = ticketChannel(ctx, t);
      if (live) {
        const ids = new Set([
          ...(t.copies ?? []).filter((c) => c.userId === userId).map((c) => c.messageId),
          ...(t.directCopies ?? [])
            .filter((c) => c.authorId === userId && c.sourceMessageId)
            .map((c) => c.sourceMessageId!),
        ]);
        for (const id of ids) {
          const m = await live.message(id);
          if (m)
            messages.push({
              at: m.createdAt.toISOString(),
              text: m.content || (m.embeds ?? []).map((e) => e.description ?? "").join("\n"),
            });
        }
      }
      for (let p = 0; p < (t.transcriptPages ?? 0); p++)
        for (const l of await readPage(ctx, t, p))
          if (l.author.id === userId) messages.push({ at: l.at, text: l.text });
      if (
        own ||
        notes.length ||
        events.length ||
        messages.length ||
        t.assignee?.id === userId ||
        t.closedBy?.id === userId
      )
        records.push({
          ticket: t.id,
          ...(own
            ? { subject: t.subject, description: t.description, rating: t.rating ?? null }
            : {}),
          assigned: t.assignee?.id === userId,
          notes: notes.map((n) => ({ at: n.at, content: n.content })),
          events,
          messages,
        });
    }
    return records;
  },
  async erase(ctx: Context, userId: string) {
    const anonymous = {
      id: await ctx.privacy.pseudonym(userId),
      displayName: ctx.i18n.t("deletedMember"),
    };
    const mentions = new RegExp("<@!?" + userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ">", "g");
    const names = new Set<string>();
    const member = await ctx.server.member(userId);
    if (member) names.add(member.displayName);
    const tickets = await allTickets(ctx);
    for (const t of tickets)
      for (const p of [
        t.author,
        t.assignee,
        t.closedBy,
        ...t.events.map((e) => e.by),
        ...(t.summary?.participants ?? []),
      ])
        if (p?.id === userId) names.add(p.displayName);
    let erased = 0;
    for (const t of tickets) {
      let changed = false;
      const clean = (s: string) => {
        const v = s.replace(mentions, ctx.i18n.t("deletedMember"));
        if (s !== v) changed = true;
        return v;
      };
      t.subject = clean(t.subject);
      t.description = clean(t.description);
      if (t.closeReason) t.closeReason = clean(t.closeReason);
      const own = t.author.id === userId;
      const live = ticketChannel(ctx, t);
      if (t.closedAudience) {
        const a = t.closedAudience;
        if (a.members.includes(userId) || a.denied.includes(userId)) changed = true;
        a.members = a.members.filter((id) => id !== userId);
        a.denied = a.denied.filter((id) => id !== userId);
      }
      if (own) {
        delete t.appeal;
        delete t.request;
        if (live && t.welcomeId)
          await (await live.message(t.welcomeId))?.delete("Member privacy request");
        if (live)
          await ctx.server.editChannel(live, {
            name: "ticket-" + t.number,
            topic: "Ticket #" + t.number,
            overwrites: { ["member:" + userId]: null },
          });
        await ctx.kv.delete(authorKey(userId, t.number));
        await ctx.kv.delete(openKey(userId, t.number));
        t.author = anonymous;
        t.subject = ctx.i18n.t("deletedSubject");
        t.description = "";
        delete t.rating;
        changed = true;
      }
      if (t.assignee?.id === userId) {
        t.assignee = null;
        changed = true;
      }
      if (t.closedBy?.id === userId) {
        t.closedBy = anonymous;
        delete t.closeReason;
        changed = true;
      }
      for (const event of t.events) {
        if (event.by.id === userId) {
          event.by = anonymous;
          delete event.detail;
          changed = true;
        }
        if (event.type === "assigned" && event.detail && names.has(event.detail)) {
          delete event.detail;
          changed = true;
        }
      }
      for (const n of t.notes) {
        n.content = clean(n.content);
        if (n.by.id === userId) {
          n.by = anonymous;
          n.content = "";
          changed = true;
        }
      }
      if (t.summary)
        t.summary.participants = t.summary.participants.map((p) => {
          if (p.id !== userId) return p;
          changed = true;
          return anonymous;
        });
      for (const c of t.copies ?? [])
        if (c.userId === userId) {
          if (live) await (await live.message(c.messageId))?.delete("Member privacy request");
          changed = true;
        }
      t.copies = t.copies?.filter((c) => c.userId !== userId);
      for (let p = 0; p < (t.transcriptPages ?? 0); p++) {
        const lines = await readPage(ctx, t, p);
        let edited = false;
        for (const line of lines) {
          const cleaned = clean(line.text);
          if (cleaned !== line.text) {
            line.text = cleaned;
            edited = true;
          }
          if (line.author.id === userId) {
            line.author = anonymous;
            line.text = "";
            edited = true;
          }
        }
        if (edited) {
          await writePage(ctx, t, p, lines);
          changed = true;
        }
      }
      for (const copy of t.directCopies ?? [])
        if (own || copy.authorId === userId) {
          await ctx.server.retractDM(copy.messageId);
          changed = true;
        }
      t.directCopies = t.directCopies?.filter((copy) => !own && copy.authorId !== userId);
      for (const notice of t.notices ?? [])
        if (notice.users.includes(userId)) {
          if (live) await (await live.message(notice.messageId))?.delete("Member privacy request");
          changed = true;
        }
      t.notices = t.notices?.filter((n) => !n.users.includes(userId));
      // Keep only source message IDs. The host pseudonym service is restricted to
      // the current erasure subject and cannot be used when reading a later transcript.
      if (live) {
        const hidden = new Set(t.redactedMessageIds ?? []);
        let before: string | undefined;
        for (;;) {
          const batch = await live.messages({ limit: 100, ...(before ? { before } : {}) });
          for (const m of batch) if (m.author.id === userId) hidden.add(m.id);
          if (batch.length < 100) break;
          const next = batch[batch.length - 1]!.id;
          if (before === next) throw new Error("Discord message cursor did not advance");
          before = next;
        }
        if (hidden.size !== (t.redactedMessageIds?.length ?? 0)) {
          t.redactedMessageIds = [...hidden];
          changed = true;
        }
      }
      if (changed) {
        await removeLogCopy(ctx, t);
        await saveTicket(ctx, t);
        erased++;
      }
    }
    return { erased };
  },
};
