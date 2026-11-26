import {
  command,
  definePlugin,
  query,
  type Context,
  type Json,
  type RouteResponse,
  type ServerInvite,
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

type Snapshot = { uses: number; code: string; inviterId?: string; vanity?: boolean };
type Cache = {
  invites: Map<string, Snapshot>;
  pending: { attribution: InviteAttribution; remaining: number }[];
};
const caches = new WeakMap<Context, Cache>();
const locks = new WeakMap<Context, Promise<void>>();
function serial(ctx: Context, work: () => Promise<void>) {
  const next = (locks.get(ctx) ?? Promise.resolve()).then(work);
  locks.set(
    ctx,
    next.catch(() => {}),
  );
  return next;
}
function snapshot(inv: ServerInvite): Snapshot {
  return {
    uses: inv.uses ?? 0,
    code: inv.code,
    ...(inv.inviter ? { inviterId: inv.inviter.id } : {}),
    vanity: inv.vanity,
  };
}
async function refresh(ctx: Context) {
  return new Map((await ctx.server.invites()).map((i) => [i.code, snapshot(i)]));
}
function attribute(cache: Cache, fresh: Map<string, Snapshot>): InviteAttribution {
  let total = 0;
  const increments: Snapshot[] = [];
  let uncertain = false;
  for (const [code, entry] of fresh) {
    const prev = cache.invites.get(code);
    if (!prev) {
      if (entry.uses > 0) uncertain = true;
      continue;
    }
    const diff = entry.uses - prev.uses;
    if (diff > 0) {
      increments.push(entry);
      total += diff;
    }
  }
  cache.invites = fresh;
  // Discord does not associate a member ID with an invite-use delta. Preserve
  // multiple uses of a single code; two distinct codes in one snapshot are ambiguous.
  if (uncertain || increments.length > 1) {
    cache.pending = [];
    cache.pending.push({ attribution: {}, remaining: Math.max(1, total + (uncertain ? 1 : 0)) });
  } else if (total) {
    const i = increments[0]!;
    cache.pending.push({
      remaining: total,
      attribution: {
        code: i.vanity ? "vanity" : i.code,
        ...(i.inviterId ? { inviterId: i.inviterId } : {}),
      },
    });
  }
  const pending = cache.pending[0];
  if (!pending) return {};
  if (--pending.remaining === 0) cache.pending.shift();
  return pending.attribution;
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
    caches.set(ctx, { invites: await refresh(ctx), pending: [] });
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
        caches.get(ctx)?.invites.delete(invite.code);
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
          cache = caches.get(ctx);
        let a: InviteAttribution = {};
        if (cache) a = attribute(cache, fresh);
        else caches.set(ctx, { invites: fresh, pending: [] });
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
        if (
          call.onBehalfOf &&
          call.onBehalfOf.userId !== input.userId &&
          call.onBehalfOf.access === "member"
        )
          throw new Error("denied");
        const e = await ctx.kv.get<Entry>("member:" + input.userId);
        return {
          ...(e?.code ? { code: e.code } : {}),
          ...(e?.inviterId ? { inviterId: e.inviterId } : {}),
        };
      },
    }),
    count: query({
      async run(ctx, input: { userId: string }) {
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
