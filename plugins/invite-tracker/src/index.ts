import {
  InteropError,
  command,
  definePlugin,
  query,
  type Context,
  type Json,
  type RouteResponse,
} from "@cicord/sdk";
import {
  changeMember,
  count,
  ranking,
  progress,
  migrate,
  initializeIndex,
  related,
  type Entry,
} from "./storage.ts";
import type { InviteAttribution } from "./contracts.ts";
import {
  attribute,
  baseline,
  forget,
  snapshot,
  type Snapshot,
  type Tracker,
} from "./attribution.ts";

const caches = new WeakMap<Context, Tracker>();
const locks = new WeakMap<Context, Promise<void>>();
function serial(ctx: Context, work: () => Promise<void>) {
  const next = (locks.get(ctx) ?? Promise.resolve()).then(work);
  locks.set(
    ctx,
    next.catch(() => {}),
  );
  return next;
}
const STATUS = "invite-counters";
const forbidden = (e: unknown) =>
  /missing permissions|missing access|forbidden|50013|50001/i.test(String(e));
/**
 * The current invite counters, or undefined when Discord refuses them (P10: the status line
 * names the missing Manage Server permission). Joins are still recorded, without an inviter.
 */
async function refresh(ctx: Context): Promise<Map<string, Snapshot> | undefined> {
  try {
    const fresh = new Map((await ctx.server.invites()).map((i) => [i.code, snapshot(i)]));
    ctx.status.set(STATUS, null);
    return fresh;
  } catch (e) {
    ctx.status.set(
      STATUS,
      forbidden(e)
        ? "Invite attribution paused: the bot needs the Manage Server permission to read invite counters. Joins are recorded without an inviter."
        : "Invite attribution paused: invite counters could not be read. Check that the bot has the Manage Server permission. Joins are recorded without an inviter.",
    );
    ctx.log.warn("Invite counters unavailable", { error: String(e) });
    return undefined;
  }
}
/** Takes a new baseline: uses seen before it are never attributed. */
async function rebase(ctx: Context) {
  const fresh = await refresh(ctx);
  if (fresh) caches.set(ctx, baseline(fresh, Date.now()));
  else caches.delete(ctx);
}
async function publishJoined(
  ctx: Context,
  userId: string,
  at: number,
  a: InviteAttribution,
  fake: boolean,
) {
  await ctx.events.publish(
    "joined",
    {
      userId,
      ...(a.inviterId ? { inviterId: a.inviterId } : {}),
      ...(a.code ? { code: a.code } : {}),
      fake,
    },
    { version: 1, idempotencyKey: `join:${userId}:${at}` },
  );
}
export default definePlugin({
  async onStart(ctx) {
    await serial(ctx, () => rebase(ctx));
    await initializeIndex(ctx);
  },
  tasks: { migrate },
  events: {
    inviteCreate(ctx, invite) {
      return serial(ctx, async () => {
        caches.get(ctx)?.invites.set(invite.code, snapshot(invite));
      });
    },
    inviteDelete(ctx, invite) {
      return serial(ctx, async () => {
        const tracker = caches.get(ctx);
        if (tracker) forget(tracker, invite.code, Date.now());
      });
    },
    // After a gateway gap events may have been missed: start from fresh counters.
    serverAvailable(ctx) {
      return serial(ctx, () => rebase(ctx));
    },
    // Recovers attribution once the bot regains Manage Server (a role change grants it).
    roleUpdate(ctx) {
      return serial(ctx, async () => {
        if (!caches.has(ctx)) await rebase(ctx);
      });
    },
    memberUpdate(ctx, m) {
      return serial(ctx, async () => {
        if (m.id === ctx.bot.user.id && !caches.has(ctx)) await rebase(ctx);
      });
    },
    memberJoin(ctx, m) {
      return serial(ctx, async () => {
        const at = m.joinedAt?.getTime() ?? Date.now();
        const previous = await ctx.kv.get<Entry>("member:" + m.id);
        if (previous?.at === at) {
          await publishJoined(ctx, m.id, at, previous, previous.fake);
          return;
        }
        const fresh = await refresh(ctx),
          tracker = caches.get(ctx),
          now = Date.now();
        let a: InviteAttribution = {};
        // Without counters, or without a baseline to compare with, the join stays unknown.
        if (!fresh) caches.delete(ctx);
        else if (tracker) a = attribute(tracker, fresh, now, at);
        else caches.set(ctx, baseline(fresh, now));
        const fake = at - m.user.createdAt.getTime() < ctx.config.minAccountDays * 86400000;
        await changeMember(ctx, m.id, () => ({ ...a, at, fake, left: false }));
        await publishJoined(ctx, m.id, at, a, fake);
      });
    },
    memberLeave(ctx, user) {
      return serial(ctx, async () => {
        await changeMember(ctx, user.id, (e) =>
          e && !e.left
            ? {
                ...e,
                left: true,
                fake: e.fake || Date.now() - e.at < ctx.config.minStayDays * 86400000,
              }
            : e,
        );
      });
    },
  },
  commands: {
    invites: command({
      description: "Count invitations for a member",
      ephemeral: true,
      options: { user: { type: "user", description: "Member" } },
      async run(ctx, it) {
        const state = await progress(ctx);
        if (!state?.ready) {
          await it.reply(ctx.i18n.t("indexing", { n: state?.processed ?? 0 }));
          return;
        }
        const c = await count(ctx, it.options.user?.id ?? it.user.id);
        await it.reply(ctx.i18n.t("counts", c));
      },
    }),
    "invite-leaderboard": command({
      description: "Top inviters by valid invitations",
      ephemeral: true,
      async run(ctx, it) {
        const state = await progress(ctx);
        if (!state?.ready) {
          await it.reply(ctx.i18n.t("indexing", { n: state?.processed ?? 0 }));
          return;
        }
        const top = await ranking(ctx, 10);
        await it.reply(
          top.map((r, i) => `${i + 1}. <@${r.userId}> · ${r.valid}`).join("\n") ||
            ctx.i18n.t("empty"),
        );
      },
    }),
  },
  queries: {
    inviterOf: query({
      async run(ctx, input: { userId: string }, call) {
        const viewer = call.onBehalfOf;
        if (
          viewer?.access === "scoped" ||
          (viewer?.access === "member" && viewer.userId !== input.userId)
        )
          throw new InteropError("denied", "Invite attribution requires access to this member.");
        const e = await ctx.kv.get<Entry>("member:" + input.userId);
        return {
          ...(e?.code ? { code: e.code } : {}),
          ...(e?.inviterId ? { inviterId: e.inviterId } : {}),
        };
      },
    }),
    count: query({
      async run(ctx, input: { userId: string }, call) {
        if (call.onBehalfOf?.access === "scoped")
          throw new InteropError("denied", "A case-scoped session cannot read invite counts.");
        return count(ctx, input.userId);
      },
    }),
  },
  routes: {
    "GET /leaderboard": {
      access: "member",
      async handler(ctx, req): Promise<RouteResponse> {
        const limit = Number(req.query.limit ?? 100),
          offset = Number(req.query.offset ?? 0);
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        )
          return { status: 400, body: { error: "Expected limit 1–100 and a nonnegative offset" } };
        const state = await progress(ctx);
        if (!state?.ready)
          return { status: 503, body: { error: "indexing", processed: state?.processed ?? 0 } };
        return ranking(ctx, limit, offset);
      },
    },
  },
  privacy: {
    async export(ctx, id) {
      const records: Json[] = [];
      for (const uid of await related(ctx, id)) {
        const entry = await ctx.kv.get<Entry>("member:" + uid);
        if (entry && (uid === id || entry.inviterId === id)) {
          const { indexed: _indexed, ...data } = entry;
          records.push({ id: uid, entry: data });
        }
      }
      return records;
    },
    async erase(ctx, id) {
      let erased = 0;
      for (const uid of await related(ctx, id)) {
        const entry = await ctx.kv.get<Entry>("member:" + uid);
        if (!entry || (uid !== id && entry.inviterId !== id)) continue;
        await changeMember(ctx, uid, (e) => {
          if (uid === id) return undefined;
          if (e?.inviterId !== id) return e;
          const { inviterId: _inv, code: _code, ...rest } = e;
          return rest;
        });
        erased++;
      }
      return { erased };
    },
  },
});
