import {
  command,
  definePlugin,
  defineRoutes,
  type Context,
  type Member,
  type MessagePayload,
  type TextChannel,
} from "@cicord/sdk";
import type { Status } from "./contracts.ts";
import type { Routes, Proposal } from "./routes.ts";

type Suggestion = {
  id: string;
  authorId: string;
  source: string;
  messageId: string;
  thread?: string;
  archiveId?: string;
  archiveChannel?: string;
  body?: string;
  reason: string;
  score: number;
  status: Status;
  anonymous: boolean;
  revision: number;
  nextRefresh: number;
  withdrawing?: boolean;
};
const key = (id: string) => "suggestion:" + id;
const choices: Status[] = ["open", "considered", "approved", "denied", "implemented"];
const mayRead = (ctx: Context, row: Suggestion, m?: Member) =>
  !row.withdrawing &&
  (m ? m.canView({ id: row.source }) : ctx.server.audience({ id: row.source }).public);
const view = (s: Suggestion, staff = false): Proposal => ({
  id: s.id,
  status: s.status,
  score: s.score,
  ...(s.body ? { body: s.body } : {}),
  ...(s.reason ? { reason: s.reason } : {}),
  ...(!s.anonymous || staff ? { authorId: s.authorId } : {}),
});
const allowed = (ctx: Context, m?: Member) =>
  !!m &&
  (["admin", "moderator"].includes(m.access ?? "") ||
    m.permissions?.some((p) => p === "ManageServer" || p === "Administrator") ||
    ctx.config.managerRoles.some((r) => m.hasRole(r)));
function card(ctx: Context, s: Suggestion, body: string): MessagePayload {
  return {
    embeds: [
      {
        title: ctx.i18n.t("thread", { id: s.id }),
        description: body,
        footer: { text: "suggestion/" + s.id },
        fields: [
          { name: ctx.i18n.t("score"), value: String(s.score), inline: true },
          { name: ctx.i18n.t("state." + s.status), value: s.reason || "—", inline: true },
        ],
        author: { name: s.anonymous ? ctx.i18n.t("anonymous") : s.authorId },
      },
    ],
    components:
      s.status === "open" || s.status === "considered"
        ? [
            {
              type: "row",
              components: [
                { type: "button", id: "up:" + s.id, emoji: "👍" },
                { type: "button", id: "down:" + s.id, emoji: "👎" },
              ],
            },
          ]
        : [],
    allowedMentions: { roles: [], users: [], everyone: false },
  };
}
async function create(ctx: Context, id: string, uid: string, channel: TextChannel, body: string) {
  const prior = await ctx.kv.get<Suggestion>(key(id));
  if (prior) return prior;
  let s: Suggestion = {
    id,
    authorId: uid,
    source: channel.id,
    messageId: "",
    reason: "",
    score: 0,
    status: "open",
    anonymous: ctx.config.anonymous,
    revision: 0,
    nextRefresh: 0,
    ...(ctx.config.retainText ? { body } : {}),
  };
  const posted = await channel.send({ ...card(ctx, s, body), nonce: id, enforceNonce: true });
  s = { ...s, messageId: posted.id };
  if (
    !(
      await ctx.kv
        .atomic()
        .check(key(id), null)
        .set(key(id), s)
        .rankSet("votes", id, 0)
        .rankSet("votes:open", id, 0)
        .commit()
    ).ok
  )
    return (await ctx.kv.get<Suggestion>(key(id)))!;
  if (ctx.features.enabled("discussion") && channel.type !== "thread") {
    const thread = await channel.createThread(ctx.i18n.t("thread", { id }), {
      fromMessage: posted.id,
    });
    for (;;) {
      const now = await ctx.kv.getEntry<Suggestion>(key(id));
      if (!now) break;
      if (
        (
          await ctx.kv
            .atomic()
            .check(key(id), now.version)
            .set(key(id), { ...now.value, thread: thread.id })
            .commit()
        ).ok
      )
        break;
    }
  }
  if (ctx.config.retainText && ctx.features.enabled("duplicateSearch"))
    await ctx.index("suggestions").upsert(id, { text: body });
  await ctx.events.publish(
    "created",
    { id, authorId: uid, status: "open", score: 0 },
    { idempotencyKey: "created:" + id },
  );
  return s;
}
async function refresh(ctx: Context, s: Suggestion) {
  if (s.withdrawing) return;
  const source = ctx.server.channel({ id: s.source }),
    post = await source.message(s.messageId);
  if (!post) return;
  const body = s.body ?? post.embeds[0]?.description ?? "";
  await post.edit(card(ctx, s, body));
  if (s.archiveId && s.archiveChannel) {
    const ch = ctx.server.channel({ id: s.archiveChannel }),
      copy = await ch.message(s.archiveId),
      rel = ctx.server.compareAudience(source, ch);
    if (copy) {
      if (rel === "same" || rel === "narrower") await copy.edit(card(ctx, s, body));
      else await copy.edit({ content: ctx.i18n.t("erased"), embeds: [], components: [] });
    }
  }
}
async function vote(ctx: Context, id: string, uid: string, delta: number, m?: Member) {
  for (;;) {
    const k = key(id),
      vk = `vote:${id}:${uid}`,
      [s, old] = await Promise.all([ctx.kv.getEntry<Suggestion>(k), ctx.kv.getEntry<number>(vk)]);
    if (
      !ctx.config.enabled ||
      !s ||
      !mayRead(ctx, s.value, m) ||
      !["open", "considered"].includes(s.value.status)
    )
      return false;
    if (old?.value === delta) return true;
    const score = s.value.score + delta - (old?.value ?? 0),
      due = s.value.nextRefresh <= Date.now();
    if (due) await ctx.schedule.after(5000, "refresh", { id });
    const tx = ctx.kv
      .atomic()
      .check(k, s.version)
      .check(vk, old?.version ?? null)
      .set(vk, delta)
      .set(k, { ...s.value, score, nextRefresh: due ? Date.now() + 5000 : s.value.nextRefresh })
      .rankSet("votes", id, score)
      .rankSet("votes:" + s.value.status, id, score);
    if ((await tx.commit()).ok) return true;
  }
}
async function decide(ctx: Context, id: string, status: Status, reason: string, m?: Member) {
  for (;;) {
    const old = await ctx.kv.getEntry<Suggestion>(key(id));
    if (!ctx.config.enabled || !old || !allowed(ctx, m) || !mayRead(ctx, old.value, m)) return;
    if (old.value.status === status && old.value.reason === reason) return old.value;
    const s = { ...old.value, status, reason, revision: old.value.revision + 1 };
    // Scheduling before the CAS covers a process exit immediately after the state change.
    await ctx.schedule.after(100, "decision", { id, revision: s.revision });
    if (
      (
        await ctx.kv
          .atomic()
          .check(key(id), old.version)
          .set(key(id), s)
          .rankRemove("votes:" + old.value.status, id)
          .rankSet("votes:" + status, id, s.score)
          .commit()
      ).ok
    )
      return s;
  }
}
async function notify(ctx: Context, s: Suggestion) {
  if (s.withdrawing) return;
  await refresh(ctx, s);
  const note = ctx.i18n.t("decision", {
      status: ctx.i18n.t("state." + s.status),
      reason: s.reason,
    }),
    nonce = s.id.slice(0, 17) + s.revision;
  if (s.thread)
    await ctx.server.channel({ id: s.thread }).send({
      content: note,
      nonce,
      enforceNonce: true,
      allowedMentions: { users: [], roles: [], everyone: false },
    });
  if (
    ctx.config.archive &&
    !s.archiveId &&
    ["approved", "denied", "implemented"].includes(s.status)
  ) {
    const source = ctx.server.channel({ id: s.source }),
      archive = ctx.server.channel(ctx.config.archive),
      rel = ctx.server.compareAudience(source, archive);
    if ((rel === "same" || rel === "narrower") && archive.id !== s.source) {
      const original = await source.message(s.messageId);
      if (original) {
        const copy = await archive.send({
          ...card(ctx, s, s.body ?? original.embeds[0]?.description ?? ""),
          nonce: s.id,
          enforceNonce: true,
          components: [],
        });
        for (;;) {
          const row = await ctx.kv.getEntry<Suggestion>(key(s.id));
          if (!row) {
            await copy.edit({ content: ctx.i18n.t("erased"), embeds: [], components: [] });
            break;
          }
          if (
            (
              await ctx.kv
                .atomic()
                .check(key(s.id), row.version)
                .set(key(s.id), { ...row.value, archiveId: copy.id, archiveChannel: archive.id })
                .commit()
            ).ok
          )
            break;
        }
      }
    }
  }
  if (ctx.features.enabled("authorNotice")) {
    try {
      await (
        await ctx.server.member(s.authorId)
      )?.send({
        content: note,
        nonce,
        enforceNonce: true,
        allowedMentions: { users: [], roles: [] },
      });
    } catch (e) {
      ctx.log.warn("Author notification failed", { id: s.id, error: String(e) });
    }
  }
  await ctx.events.publish(
    "statusChanged",
    { id: s.id, authorId: s.authorId, status: s.status, score: s.score },
    { idempotencyKey: `status:${s.id}:${s.revision}` },
  );
}
async function list(ctx: Context, offset: number, status?: string, member?: Member, staff = false) {
  if (!ctx.config.enabled || (status && !choices.includes(status as Status))) return { items: [] };
  const top = await ctx.kv
    .ranking(status ? "votes:" + status : "votes")
    .top({ limit: 100, offset: Math.max(0, Math.floor(offset) || 0) });
  const items: Proposal[] = [];
  for (const e of top) {
    const s = await ctx.kv.get<Suggestion>(key(e.member));
    if (s && mayRead(ctx, s, member)) items.push(view(s, staff));
  }
  return {
    items,
    ...(top.length === 100 ? { nextOffset: Math.max(0, Math.floor(offset) || 0) + 100 } : {}),
  };
}
async function audit(ctx: Context, cursor?: string) {
  const page = await ctx.kv.list<Suggestion>({ prefix: "suggestion:", limit: 50, cursor });
  for (const { value: s } of page.items)
    if (s.archiveId) await ctx.schedule.after(1, "refresh", { id: s.id });
  if (page.cursor) await ctx.schedule.after(1, "audit", { cursor: page.cursor });
}
export default definePlugin({
  commands: {
    suggest: command({
      description: "Submit a community suggestion",
      ephemeral: true,
      async run(ctx, i) {
        if (!ctx.config.enabled) return i.reply(ctx.i18n.t("off"));
        if (!ctx.config.channel || !i.member?.canView(ctx.config.channel))
          return i.reply(ctx.i18n.t("missing"));
        await i.showModal({
          id: "suggest",
          title: ctx.i18n.t("submit"),
          fields: [
            {
              id: "body",
              label: ctx.i18n.t("body"),
              style: "paragraph",
              required: true,
              minLength: 4,
              maxLength: 1800,
            },
          ],
        });
      },
    }),
  },
  modals: {
    async suggest(ctx, i) {
      if (!ctx.config.enabled || !ctx.config.channel || !i.member?.canView(ctx.config.channel))
        return i.reply(ctx.i18n.t("missing"));
      const body = i.fields.body?.trim();
      if (!body || body.length < 4) return i.reply(ctx.i18n.t("missing"));
      const duplicates: string[] = [];
      if (ctx.config.retainText && ctx.features.enabled("duplicateSearch")) {
        const peers = await ctx.index("suggestions").search(body.slice(0, 160), { limit: 5 });
        for (const p of peers) {
          const s = await ctx.kv.get<Suggestion>(key(p.id));
          if (s && mayRead(ctx, s, i.member)) duplicates.push(s.id);
        }
      }
      await create(
        ctx,
        i.id,
        i.user.id,
        ctx.server.channel(ctx.config.channel),
        body.slice(0, 1800),
      );
      await i.reply({
        content:
          ctx.i18n.t("created") +
          (duplicates.length ? "\n" + ctx.i18n.t("similar") + " · " + duplicates.join(", ") : ""),
        ephemeral: true,
      });
    },
  },
  events: {
    async messageCreate(ctx, m) {
      if (
        !ctx.config.enabled ||
        !ctx.config.forum ||
        !ctx.features.enabled("forumInput") ||
        m.author.bot ||
        m.channel.type !== "thread" ||
        m.channel.categoryId !== ctx.server.channel(ctx.config.forum).id ||
        m.id !== m.channel.id
      )
        return;
      if (m.content.trim())
        await create(ctx, m.id, m.author.id, m.channel, m.content.slice(0, 1800));
    },
  },
  components: Object.fromEntries(
    [
      ["up", 1],
      ["down", -1],
    ].map(([name, d]) => [
      name,
      async (ctx: Context, i: import("@cicord/sdk").ComponentInteraction) => {
        const ok = await vote(ctx, i.componentId.split(":")[1]!, i.user.id, Number(d), i.member);
        await i.reply({ content: ctx.i18n.t(ok ? "saved" : "restricted"), ephemeral: true });
      },
    ]),
  ),
  tasks: {
    async refresh(ctx, p) {
      const s = await ctx.kv.get<Suggestion>(key((p as { id: string }).id));
      if (s) await refresh(ctx, s);
    },
    async decision(ctx, p) {
      const { id, revision } = p as { id: string; revision: number };
      const s = await ctx.kv.get<Suggestion>(key(id));
      if (ctx.config.enabled && s?.revision === revision) await notify(ctx, s);
    },
    async audit(ctx, p) {
      await audit(ctx, (p as { cursor?: string } | undefined)?.cursor);
    },
  },
  schedules: { audit: { cron: "0 2 * * *", run: (ctx) => audit(ctx) } },
  routes: defineRoutes<Routes>({
    "GET /suggestions": {
      access: "public",
      handler: (ctx, r) => list(ctx, Number(r.query.offset), r.query.status, r.viewer?.member),
    },
    "GET /suggestions/moderation": {
      access: "moderator",
      handler: (ctx, r) => list(ctx, Number(r.query.offset), undefined, r.viewer?.member, true),
    },
    "POST /suggestions/:id/status": {
      access: "moderator",
      async handler(ctx, r) {
        const b = r.body;
        if (
          !b ||
          !choices.includes(b.status as Status) ||
          typeof b.reason !== "string" ||
          !b.reason.trim() ||
          b.reason.length > 500
        )
          return { status: 400 };
        const s = await decide(ctx, r.params.id, b.status as Status, b.reason, r.viewer?.member);
        return s ? view(s, true) : { status: 403 };
      },
    },
  }),
  privacy: {
    export: (ctx, uid) => personal(ctx, uid, false),
    async erase(ctx, uid) {
      return { erased: (await personal(ctx, uid, true)).length };
    },
  },
});
async function personal(ctx: Context, uid: string, erase: boolean) {
  const out: ({ proposal: Proposal } | { id: string; vote: number })[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<Suggestion>({ prefix: "suggestion:", limit: 100, cursor });
    for (const { value: s } of page.items) {
      if (s.authorId === uid) {
        out.push({ proposal: view(s, true) });
        if (erase) {
          for (;;) {
            const old = await ctx.kv.getEntry<Suggestion>(key(s.id));
            if (!old || old.value.withdrawing) break;
            if (
              (
                await ctx.kv
                  .atomic()
                  .check(key(s.id), old.version)
                  .set(key(s.id), { ...old.value, withdrawing: true })
                  .commit()
              ).ok
            )
              break;
          }
          for (const [cid, mid] of [
            [s.source, s.messageId],
            [s.archiveChannel, s.archiveId],
          ])
            if (cid && mid)
              await (
                await ctx.server.channel({ id: cid }).message(mid)
              )?.edit({ content: ctx.i18n.t("erased"), embeds: [], components: [] });
          if (ctx.features.enabled("duplicateSearch")) await ctx.index("suggestions").remove(s.id);
          await ctx.kv
            .atomic()
            .rankRemove("votes", s.id)
            .rankRemove("votes:" + s.status, s.id)
            .commit();
          let vc: string | undefined;
          do {
            const votes = await ctx.kv.list({
              prefix: "vote:" + s.id + ":",
              limit: 1000,
              cursor: vc,
            });
            for (const v of votes.items) {
              const voter = v.key.slice(("vote:" + s.id + ":").length);
              if (voter === uid) await ctx.kv.delete(v.key);
              else {
                const current = await ctx.kv.getEntry(v.key);
                if (current)
                  await ctx.kv
                    .atomic()
                    .check(v.key, current.version)
                    .delete(v.key)
                    .set("past-vote:" + voter + ":" + s.id, current.value, {
                      ttlSeconds: 365 * 86400,
                    })
                    .commit();
              }
            }
            vc = votes.cursor;
          } while (vc);
          await ctx.kv.delete(key(s.id));
        }
      } else {
        const vk = `vote:${s.id}:${uid}`;
        for (;;) {
          const [v, latest] = await Promise.all([
            ctx.kv.getEntry<number>(vk),
            ctx.kv.getEntry<Suggestion>(key(s.id)),
          ]);
          if (!v || !latest) break;
          if (erase) {
            const score = latest.value.score - v.value;
            if (
              !(
                await ctx.kv
                  .atomic()
                  .check(vk, v.version)
                  .check(key(s.id), latest.version)
                  .delete(vk)
                  .set(key(s.id), { ...latest.value, score })
                  .rankSet("votes", s.id, score)
                  .rankSet("votes:" + latest.value.status, s.id, score)
                  .commit()
              ).ok
            )
              continue;
            await refresh(ctx, { ...latest.value, score });
          }
          out.push({ id: s.id, vote: v.value });
          break;
        }
      }
    }
    cursor = page.cursor;
  } while (cursor);
  do {
    const page = await ctx.kv.list<number>({
      prefix: "past-vote:" + uid + ":",
      cursor,
      limit: 1000,
    });
    for (const row of page.items) {
      out.push({ id: row.key.slice(("past-vote:" + uid + ":").length), vote: row.value });
      if (erase) await ctx.kv.delete(row.key);
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}
