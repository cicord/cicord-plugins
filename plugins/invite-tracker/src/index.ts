import {
  command,
  definePlugin,
  query,
  type Context,
  type Json,
  type ServerInvite,
} from "@cicord/sdk";
import type { InviteAttribution, InviteCounts } from "./contracts.ts";

type Entry = InviteAttribution & { at: number; fake: boolean; left: boolean };
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
async function entries(ctx: Context) {
  const all: { id: string; entry: Entry }[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<Entry>({ prefix: "member:", limit: 1000, cursor });
    for (const i of page.items) all.push({ id: i.key.slice(7), entry: i.value });
    cursor = page.cursor;
  } while (cursor);
  return all;
}
async function ranking(ctx: Context) {
  const counts = new Map<string, InviteCounts>();
  for (const { entry: e } of await entries(ctx)) {
    if (!e.inviterId) continue;
    const row = counts.get(e.inviterId) ?? { valid: 0, fake: 0, left: 0 };
    if (e.fake) row.fake++;
    else if (!e.left) row.valid++;
    if (e.left) row.left++;
    counts.set(e.inviterId, row);
  }
  return [...counts]
    .map(([userId, c]) => ({ userId, ...c }))
    .sort((a, b) => b.valid - a.valid || a.userId.localeCompare(b.userId));
}
async function count(ctx: Context, id: string) {
  const row = (await ranking(ctx)).find((x) => x.userId === id);
  return { valid: row?.valid ?? 0, fake: row?.fake ?? 0, left: row?.left ?? 0 };
}
export default definePlugin({
  async onStart(ctx) {
    caches.set(ctx, { invites: await refresh(ctx), pending: [] });
  },
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
        const fresh = await refresh(ctx),
          cache = caches.get(ctx);
        let a: InviteAttribution = {};
        if (cache) a = attribute(cache, fresh);
        else caches.set(ctx, { invites: fresh, pending: [] });
        const at = m.joinedAt?.getTime() ?? Date.now();
        const previous = await ctx.kv.get<Entry>("member:" + m.id);
        if (previous?.at === at) return;
        const fake = at - m.user.createdAt.getTime() < ctx.config.minAccountDays * 86400000;
        await ctx.kv.set("member:" + m.id, { ...a, at, fake, left: false });
        await ctx.events.publish(
          "joined",
          { userId: m.id, ...a, fake },
          { version: 1, idempotencyKey: `join:${m.id}:${at}` },
        );
      });
    },
    memberLeave(ctx, user) {
      return serial(ctx, async () => {
        const key = "member:" + user.id,
          e = await ctx.kv.get<Entry>(key);
        if (e && !e.left)
          await ctx.kv.set(key, {
            ...e,
            left: true,
            fake: e.fake || Date.now() - e.at < ctx.config.minStayDays * 86400000,
          });
      });
    },
  },
  commands: {
    invites: command({
      description: "Count invitations for a member",
      ephemeral: true,
      options: { user: { type: "user", description: "Member" } },
      async run(ctx, it) {
        const c = await count(ctx, it.options.user?.id ?? it.user.id);
        await it.reply(ctx.i18n.t("counts", c));
      },
    }),
    "invite-leaderboard": command({
      description: "Top inviters by valid invitations",
      ephemeral: true,
      async run(ctx, it) {
        const top = (await ranking(ctx)).slice(0, 10);
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
  routes: { "GET /leaderboard": { access: "member", handler: (ctx) => ranking(ctx) } },
  privacy: {
    async export(ctx, id) {
      return (await entries(ctx)).filter(
        (x) => x.id === id || x.entry.inviterId === id,
      ) as unknown as Json;
    },
    async erase(ctx, id) {
      let erased = 0;
      for (const { id: user, entry } of await entries(ctx)) {
        if (user === id) {
          await ctx.kv.delete("member:" + user);
          erased++;
        } else if (entry.inviterId === id) {
          delete entry.inviterId;
          delete entry.code;
          await ctx.kv.set("member:" + user, entry);
          erased++;
        }
      }
      return { erased };
    },
  },
});
