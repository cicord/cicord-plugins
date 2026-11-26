import {
  command,
  definePlugin,
  defineRoutes,
  subcommand,
  type Context,
  type Json,
  type Member,
  type MessagePayload,
  type Interaction,
} from "@cicord/sdk";
import { canonical, commitment, draw, entrantsHash, hex, type Entry } from "./draw.ts";
import type { DrawView, Routes } from "./routes.ts";

type Giveaway = {
  id: string;
  prize: string;
  description: string;
  channelId: string;
  messageId: string;
  closesAt: number;
  seed: string;
  commitment: string;
  entrants: number;
  slots: number;
  state: "open" | "ended" | "cancelled";
  history: string[];
  winners: string[];
  claimed: string[];
  round: number;
  claimBy: number;
  entrantsHash?: string;
  redacted?: boolean;
  refreshAt: number;
  image?: string;
  expiresAt?: number;
  /** Set when the draw starts: entries stop before the entrant list is read. */
  closing?: true;
};
const key = (id: string) => "gw:" + id;
// Entries never write the giveaway record: each click changes its own entry key and this
// counter, so a popular giveaway has no hot key. `entrants` holds the count that predates
// the counter (records of earlier versions) and, after the draw, the final count.
const countKey = (id: string) => "entrants:" + id;
const refreshKey = (id: string) => "refreshing:" + id;
async function entrantCount(ctx: Context, g: Giveaway) {
  return g.state === "open"
    ? g.entrants + ((await ctx.kv.get<number>(countKey(g.id))) ?? 0)
    : g.entrants;
}
const t = (ctx: Context, id: string, vars: Record<string, string> = {}) => ctx.i18n.t(id, vars);
function manager(ctx: Context, member?: Member) {
  return (
    !!member &&
    (["admin", "moderator"].includes(member.access ?? "") ||
      member.permissions?.some((p) => p === "Administrator" || p === "ManageServer") ||
      ctx.config.managerRoles.some((role) => member.hasRole(role)))
  );
}
const entryKey = (id: string, userId = "") => `entry:${id}:${userId}`;
async function entries(ctx: Context, id: string) {
  const result: Entry[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<number>({ prefix: entryKey(id), limit: 1000, cursor });
    for (const { key, value } of page.items)
      result.push({ userId: key.slice(entryKey(id).length), weight: value });
    cursor = page.cursor;
  } while (cursor);
  return canonical(result);
}
/**
 * One page of the entrant list, in storage order: an anonymous request reads at most one KV
 * page. Concatenate the pages and sort by numeric ID (as the verifier does) to hash them.
 */
const ENTRY_PAGE = 1000;
async function entryPage(ctx: Context, id: string, cursor?: string) {
  const page = await ctx.kv.list<number>({ prefix: entryKey(id), limit: ENTRY_PAGE, cursor });
  return {
    entries: canonical(
      page.items.map(({ key, value }) => ({
        userId: key.slice(entryKey(id).length),
        weight: value,
      })),
    ),
    ...(page.cursor ? { entriesCursor: page.cursor } : {}),
  };
}
function canRead(ctx: Context, g: Giveaway, member?: Member) {
  const source = { id: g.channelId };
  // A missing snapshot or channel must never turn a private drawing into a public proof.
  const audience = ctx.server.audience(source);
  return audience.known && (member ? member.canView(source) : audience.public);
}
function view(g: Giveaway, entrants: number): DrawView {
  return {
    id: g.id,
    prize: g.prize,
    state: g.state,
    closesAt: g.closesAt,
    commitment: g.commitment,
    entrants,
    winners: g.winners,
    ...(g.state === "ended"
      ? {
          seed: g.seed,
          entrantsHash: g.entrantsHash,
          history: g.history,
          round: g.round,
          redacted: g.redacted,
        }
      : {}),
  };
}
function panel(ctx: Context, g: Giveaway, entrants: number): MessagePayload {
  return {
    embeds: [
      {
        title: g.prize,
        description: g.description,
        ...(g.image ? { image: { url: g.image } } : {}),
        footer: { text: `gw/${g.id}` },
        fields: [
          { name: t(ctx, "commit"), value: g.commitment },
          { name: t(ctx, "entrants"), value: String(entrants) },
          { name: t(ctx, "end"), value: `<t:${Math.floor(g.closesAt / 1000)}:R>` },
          { name: t(ctx, "status"), value: t(ctx, "state." + g.state) },
          ...(g.state === "ended"
            ? [
                {
                  name: t(ctx, "winners"),
                  value:
                    g.winners
                      .map((id) => `<@${id}>`)
                      .join(", ")
                      .slice(0, 1024) || t(ctx, "none"),
                },
              ]
            : []),
        ],
      },
    ],
    allowedMentions: { users: [], roles: [], everyone: false },
    components:
      g.state === "open"
        ? [
            {
              type: "row",
              components: [
                { type: "button", id: "enter:" + g.id, label: t(ctx, "join"), style: "success" },
                { type: "button", id: "leave:" + g.id, label: t(ctx, "leave") },
              ],
            },
          ]
        : g.state === "ended" && g.claimBy > Date.now()
          ? [
              {
                type: "row",
                components: [{ type: "button", id: "claim:" + g.id, label: t(ctx, "claim") }],
              },
            ]
          : [],
  };
}
async function refresh(ctx: Context, g: Giveaway) {
  const ch = ctx.server.channel({ id: g.channelId }),
    entrants = await entrantCount(ctx, g);
  if (g.messageId) {
    await (await ch.message(g.messageId))?.edit(panel(ctx, g, entrants));
    return;
  }
  // Discord honours the nonce for recent retries; the marker recovers older deliveries.
  let before: string | undefined, existing;
  do {
    const page = await ch.messages({ limit: 100, before });
    existing = page.find(
      (m) =>
        m.author.id === ctx.bot.user.id && m.embeds.some((e) => e.footer?.text === "gw/" + g.id),
    );
    before =
      !existing &&
      page.length === 100 &&
      page.at(-1)!.createdAt.getTime() >= Number((BigInt(g.id) >> 22n) + 1420070400000n)
        ? page.at(-1)!.id
        : undefined;
  } while (before);
  const message =
    existing ?? (await ch.send({ ...panel(ctx, g, entrants), nonce: g.id, enforceNonce: true }));
  for (;;) {
    const current = await ctx.kv.getEntry<Giveaway>(key(g.id));
    if (!current || current.value.messageId) break;
    if (
      (
        await ctx.kv
          .atomic()
          .check(key(g.id), current.version)
          .set(key(g.id), { ...current.value, messageId: message.id })
          .commit()
      ).ok
    )
      break;
  }
  g.messageId = message.id;
}
function requiredProviders(ctx: Context) {
  const c = ctx.config.conditions;
  return [
    [c.level, "level", "levels"],
    [c.invites, "invites", "invite-tracker"],
    [c.noWarnings, "standing", "moderation"],
  ] as const;
}
/** The refusal message for an entry, naming the unmet condition, or undefined. */
async function eligibility(ctx: Context, m: Member): Promise<string | undefined> {
  const c = ctx.config.conditions;
  if (c.requiredRole && !m.hasRole(c.requiredRole)) return t(ctx, "role");
  if (c.excludedRoles.some((r) => m.hasRole(r))) return t(ctx, "excluded");
  const birth = Number((BigInt(m.id) >> 22n) + 1420070400000n);
  if (Date.now() - birth < c.accountDays * 86400000) return t(ctx, "age");
  if (Date.now() - m.joinedAt.getTime() < c.memberDays * 86400000) return t(ctx, "tenure");
  for (const [needed, feature, provider] of requiredProviders(ctx)) {
    if (!needed) continue;
    // A provider that was unbound, disabled or failing since launch: name the condition.
    const missing = () => t(ctx, "missing", { condition: t(ctx, "condition." + feature) });
    if (!ctx.features.enabled(feature) || !ctx.plugins.has(provider)) return missing();
    const method =
      feature === "level" ? "memberLevel" : feature === "invites" ? "count" : "standing";
    let res: Record<string, number>;
    try {
      res = (await ctx.plugins.query(provider, method, { userId: m.id })) as Record<string, number>;
    } catch (error) {
      ctx.log.warn("Entry condition could not be verified", { provider, error: String(error) });
      return missing();
    }
    if (feature === "level" && !(res.level! >= c.level)) return t(ctx, "level");
    if (feature === "invites" && !(res.valid! >= c.invites)) return t(ctx, "invites");
    if (feature === "standing" && res.activeWarnings !== 0) return t(ctx, "standing");
  }
}
async function enter(ctx: Context, i: Interaction, id: string, leave: boolean) {
  if (!ctx.config.enabled || !i.member) return i.reply({ content: t(ctx, "off"), ephemeral: true });
  const fail = leave ? undefined : await eligibility(ctx, i.member);
  if (fail) return i.reply({ content: fail, ephemeral: true });
  const ek = entryKey(id, i.user.id);
  const weight =
    1 + ctx.config.bonus.reduce((s, r) => s + (i.member!.hasRole(r.role) ? r.entries : 0), 0);
  for (;;) {
    const [g, e] = await Promise.all([ctx.kv.getEntry<Giveaway>(key(id)), ctx.kv.getEntry(ek)]);
    if (
      !g ||
      !canRead(ctx, g.value, i.member) ||
      g.value.state !== "open" ||
      g.value.closing ||
      Date.now() >= g.value.closesAt
    )
      return i.reply({ content: t(ctx, "closed"), ephemeral: true });
    if (leave === !e) break;
    // The record is only checked: the draw's closing write makes an in-flight entry retry
    // and see the giveaway closed, so every stored entry is part of the draw.
    const tx = ctx.kv
      .atomic()
      .check(key(id), g.version)
      .check(ek, e?.version ?? null)
      .increment(countKey(id), leave ? -1 : 1);
    if (leave) tx.delete(ek);
    else tx.set(ek, weight);
    if ((await tx.commit()).ok) {
      // One panel refresh per 10 s, whoever clicks first.
      const claimed = await ctx.kv
        .atomic()
        .check(refreshKey(id), null)
        .set(refreshKey(id), true, { ttlSeconds: 10 })
        .commit();
      if (claimed.ok) await ctx.schedule.after(10000, "refresh", { id });
      break;
    }
  }
  await i.reply({ content: t(ctx, leave ? "left" : "joined"), ephemeral: true });
}
function rewardProviders(ctx: Context) {
  const r = ctx.config.rewards;
  return [
    [r.xp, "xpReward", "levels", "grantXp"],
    [r.coins, "coinReward", "economy", "credit"],
    [r.role, "roleReward", "member-roles", "grantTemporary"],
  ] as const;
}
const rewardUnavailable = (plugin: string, method: string) =>
  "Reward unavailable: " + plugin + "." + method;
async function payout(ctx: Context, g: Giveaway, userId: string) {
  const r = ctx.config.rewards;
  const calls: {
    enabled: number | string | undefined;
    feature: string;
    plugin: string;
    method: string;
    input: Record<string, Json>;
  }[] = [
    {
      enabled: r.xp,
      feature: "xpReward",
      plugin: "levels",
      method: "grantXp",
      input: { amount: r.xp },
    },
    {
      enabled: r.coins,
      feature: "coinReward",
      plugin: "economy",
      method: "credit",
      input: { amount: r.coins },
    },
    {
      enabled: r.role,
      feature: "roleReward",
      plugin: "member-roles",
      method: "grantTemporary",
      input: { role: r.role ?? "", durationSeconds: r.durationSeconds },
    },
  ];
  for (const c of calls)
    if (c.enabled) {
      if (!ctx.features.enabled(c.feature) || !ctx.plugins.has(c.plugin)) {
        ctx.status.set("reward-" + c.feature, rewardUnavailable(c.plugin, c.method));
        continue;
      }
      await ctx.plugins.call(
        c.plugin,
        c.method,
        { userId, ...c.input, reason: "giveaway " + g.id } as Json,
        { idempotencyKey: `gw:${g.id}:${userId}:${c.method}` },
      );
      ctx.status.set("reward-" + c.feature, null);
    }
}
async function settle(ctx: Context, id: string, round: number, count?: number) {
  if (!ctx.config.enabled) return;
  for (;;) {
    const cur = await ctx.kv.getEntry<Giveaway>(key(id));
    if (
      !cur ||
      cur.value.state === "cancelled" ||
      cur.value.round > round ||
      (cur.value.expiresAt && cur.value.expiresAt <= Date.now())
    )
      return;
    let g = cur.value;
    if (g.round < round) {
      if (round !== g.round + 1) return;
      if (g.state === "open" && !g.closing) {
        // Close entries first: this write fails every entry still in flight.
        await ctx.kv
          .atomic()
          .check(key(id), cur.version)
          .set(key(id), { ...g, closing: true })
          .commit();
        continue;
      }
      const data = await entries(ctx, id);
      const winners = draw(g.seed, g.id, data, g.history, count ?? g.slots);
      const kept = round === 1 ? [] : g.winners.filter((w) => g.claimed.includes(w));
      const { closing: _closing, ...rest } = g;
      g = {
        ...rest,
        state: "ended",
        entrants: g.state === "open" ? data.length : g.entrants,
        round,
        expiresAt: Date.now() + ctx.config.historyDays * 86400000,
        entrantsHash: g.entrantsHash ?? entrantsHash(data),
        history: [...g.history, ...winners],
        winners: [...kept, ...winners],
        claimBy:
          ctx.config.claim.enabled && winners.length
            ? Date.now() + ctx.config.claim.hours * 3600000
            : 0,
      };
      const tx = ctx.kv.atomic().check(key(id), cur.version).set(key(id), g);
      if (cur.value.state === "open") tx.delete(countKey(id)).delete(refreshKey(id));
      if (!(await tx.commit()).ok) continue;
    }
    await refresh(ctx, g);
    await ctx.events.publish(
      "ended",
      {
        id,
        prize: g.prize,
        winners: g.winners,
        entrants: g.entrants,
        channelId: g.channelId,
        messageId: g.messageId,
      },
      { idempotencyKey: `end:${id}:${round}` },
    );
    for (const uid of g.winners) {
      if (!g.claimBy || g.claimed.includes(uid)) await payout(ctx, g, uid);
      const marker = `notice:${id}:${uid}`;
      if ((await ctx.kv.atomic().check(marker, null).set(marker, true).commit()).ok) {
        try {
          const winner = await ctx.server.member(uid);
          if (winner && canRead(ctx, g, winner))
            await winner.send(
              t(ctx, "winner", {
                prize: g.prize,
                link: `https://discord.com/channels/${ctx.server.id}/${g.channelId}/${g.messageId}`,
              }),
            );
        } catch (error) {
          ctx.log.warn("Winner notification failed", { id, error: String(error) });
        }
      }
    }
    await ctx.schedule.after(Math.max(1, g.expiresAt! - Date.now()), "purge", { id });
    if (g.claimBy)
      await ctx.schedule.after(Math.max(1, g.claimBy - Date.now()), "expire", { id, round });
    return;
  }
}
async function kickoff(ctx: Context, g: Giveaway) {
  await refresh(ctx, g);
  await ctx.events.publish(
    "started",
    {
      id: g.id,
      prize: g.prize,
      winners: [],
      entrants: await entrantCount(ctx, g),
      channelId: g.channelId,
      messageId: g.messageId,
    },
    { idempotencyKey: "start:" + g.id },
  );
  await ctx.schedule.after(Math.max(1, g.closesAt - Date.now()), "finish", { id: g.id });
}
const opts = {
  id: {
    type: "string",
    description: "Giveaway ID",
    required: true,
    async autocomplete(
      ctx: Context,
      i: import("@cicord/sdk").AutocompleteInteraction,
      focused: import("@cicord/sdk").FocusedOption,
    ) {
      if (!ctx.config.enabled || !manager(ctx, i.member)) return [];
      const q = focused.value.toLowerCase(),
        p = await ctx.kv.list<Giveaway>({ prefix: "gw:", limit: 100 });
      return p.items
        .filter((e) => canRead(ctx, e.value, i.member))
        .filter((e) => e.value.id.startsWith(q) || e.value.prize.toLowerCase().includes(q))
        .slice(0, 25)
        .map((e) => ({
          name: (e.value.prize + " · " + e.value.id).slice(0, 100),
          value: e.value.id,
        }));
    },
  },
} as const;
const actionCommand = (mode: "end" | "cancel" | "reroll") =>
  subcommand({
    description: mode + " a giveaway",
    options: opts,
    async run(ctx, i) {
      if (!ctx.config.enabled || !manager(ctx, i.member)) return i.reply(t(ctx, "staff"));
      const cur = await ctx.kv.getEntry<Giveaway>(key(i.options.id));
      if (!cur || !canRead(ctx, cur.value, i.member)) return i.reply(t(ctx, "closed"));
      if (mode === "cancel" && cur.value.state === "open") {
        const counter = await ctx.kv.getEntry<number>(countKey(cur.value.id));
        const { closing: _closing, ...open } = cur.value;
        const g = {
          ...open,
          state: "cancelled" as const,
          entrants: cur.value.entrants + (counter?.value ?? 0),
          expiresAt: Date.now() + ctx.config.historyDays * 86400000,
        };
        await ctx.schedule.after(ctx.config.historyDays * 86400000, "purge", { id: g.id });
        const tx = ctx.kv
          .atomic()
          .check(key(g.id), cur.version)
          .check(countKey(g.id), counter?.version ?? null)
          .set(key(g.id), g)
          .delete(countKey(g.id));
        if ((await tx.commit()).ok) await refresh(ctx, g);
      } else if (mode === "end" && cur.value.state === "open") await settle(ctx, cur.value.id, 1);
      else if (mode === "reroll" && cur.value.state === "ended")
        await settle(
          ctx,
          cur.value.id,
          cur.value.round + 1,
          Math.max(0, cur.value.winners.filter((w) => !cur.value.claimed.includes(w)).length),
        );
      await i.reply(t(ctx, "saved"));
    },
  });
async function reconcile(ctx: Context, cursor?: string) {
  if (!ctx.config.enabled) return;
  const page = await ctx.kv.list<Giveaway>({ prefix: "gw:", limit: 100, cursor });
  for (const { value: g } of page.items) {
    if (g.state === "open") await ctx.schedule.after(1, "start", { id: g.id });
    else if (g.expiresAt && g.expiresAt <= Date.now())
      await ctx.schedule.after(1, "purge", { id: g.id });
    else if (g.state === "ended" && g.claimBy && g.winners.some((w) => !g.claimed.includes(w)))
      await ctx.schedule.after(Math.max(1, g.claimBy - Date.now()), "expire", {
        id: g.id,
        round: g.round,
      });
  }
  if (page.cursor) await ctx.schedule.after(1, "recover", { cursor: page.cursor });
}
export default definePlugin({
  async onStart(ctx) {
    if (ctx.config.enabled)
      for (const [required, feature, provider] of requiredProviders(ctx)) {
        if (required)
          ctx.status.set(
            "condition-" + feature,
            ctx.features.enabled(feature) && ctx.plugins.has(provider)
              ? null
              : "Configured condition cannot be verified: " + provider,
          );
      }
    if (ctx.config.enabled)
      for (const [amount, feature, provider, method] of rewardProviders(ctx))
        ctx.status.set(
          "reward-" + feature,
          !amount || (ctx.features.enabled(feature) && ctx.plugins.has(provider))
            ? null
            : rewardUnavailable(provider, method),
        );
    if (ctx.config.enabled) await ctx.schedule.after(1, "recover");
  },
  commands: {
    giveaway: command({
      description: "Community giveaways",
      ephemeral: true,
      subcommands: {
        start: subcommand({
          description: "Start a giveaway",
          options: {
            seconds: { type: "integer", description: "Duration in seconds", min: 30, max: 2592000 },
            winners: { type: "integer", description: "Number of winners", min: 1, max: 100 },
          },
          async run(ctx, i) {
            if (!ctx.config.enabled) return i.reply(t(ctx, "off"));
            if (!manager(ctx, i.member)) return i.reply(t(ctx, "staff"));
            if (
              !i.channel ||
              (ctx.config.channels.length &&
                !ctx.config.channels.some((k) => ctx.server.channel(k).id === i.channel!.id))
            )
              return i.reply(t(ctx, "channel"));
            for (const [needed, f, p] of requiredProviders(ctx))
              if (needed && (!ctx.features.enabled(f) || !ctx.plugins.has(p)))
                return i.reply(t(ctx, "missing", { condition: p }));
            await i.showModal({
              id: `create:${i.options.seconds ?? ctx.config.defaultDurationHours * 3600}:${Math.min(i.options.winners ?? 1, ctx.config.maxWinners)}`,
              title: t(ctx, "start"),
              fields: [
                { id: "prize", label: t(ctx, "prize"), required: true, maxLength: 200 },
                {
                  id: "description",
                  label: t(ctx, "details"),
                  style: "paragraph",
                  required: false,
                  maxLength: 2000,
                },
                { id: "image", label: t(ctx, "image"), required: false, maxLength: 500 },
              ],
            });
          },
        }),
        end: actionCommand("end"),
        cancel: actionCommand("cancel"),
        reroll: actionCommand("reroll"),
        list: subcommand({
          description: "List recent giveaways",
          async run(ctx, i) {
            if (!ctx.config.enabled || !manager(ctx, i.member)) return i.reply(t(ctx, "staff"));
            const { items } = await ctx.kv.list<Giveaway>({ prefix: "gw:", limit: 25 });
            await i.reply(
              items
                .filter((e) => canRead(ctx, e.value, i.member))
                .map((e) => e.value.id + " · " + e.value.prize)
                .join("\n")
                .slice(0, 1900) || t(ctx, "no"),
            );
          },
        }),
      },
    }),
  },
  modals: {
    async create(ctx, i) {
      if (!ctx.config.enabled || !manager(ctx, i.member) || !i.channel)
        return i.reply(t(ctx, "staff"));
      for (const [needed, f, p] of requiredProviders(ctx))
        if (needed && (!ctx.features.enabled(f) || !ctx.plugins.has(p)))
          return i.reply(t(ctx, "missing", { condition: p }));
      const [, seconds, slots] = i.modalId.split(":");
      if (
        ctx.config.channels.length &&
        !ctx.config.channels.some((k) => ctx.server.channel(k).id === i.channel!.id)
      )
        return i.reply(t(ctx, "channel"));
      const seed = hex(crypto.getRandomValues(new Uint8Array(32)));
      const g: Giveaway = {
        id: i.id,
        prize: i.fields.prize!.slice(0, 200),
        description: (i.fields.description ?? "").slice(0, 2000),
        seed,
        commitment: commitment(seed),
        channelId: i.channel.id,
        messageId: "",
        ...(/^https:\/\/[a-z0-9.-]+\//i.test(i.fields.image ?? "")
          ? { image: i.fields.image }
          : {}),
        closesAt: Date.now() + Math.max(30, Math.min(2592000, Number(seconds))) * 1000,
        slots: Math.min(ctx.config.maxWinners, Math.max(1, Number(slots))),
        entrants: 0,
        state: "open",
        history: [],
        winners: [],
        claimed: [],
        round: 0,
        claimBy: 0,
        refreshAt: 0,
      };
      await ctx.kv.atomic().check(key(i.id), null).set(key(i.id), g).commit();
      await ctx.schedule.after(1, "start", { id: i.id });
      await i.reply(t(ctx, "saved"));
    },
  },
  components: {
    enter: (ctx, i) => enter(ctx, i, i.componentId.split(":")[1]!, false),
    leave: (ctx, i) => enter(ctx, i, i.componentId.split(":")[1]!, true),
    async claim(ctx, i) {
      const id = i.componentId.split(":")[1]!;
      if (!ctx.config.enabled) return i.reply(t(ctx, "off"));
      for (;;) {
        const c = await ctx.kv.getEntry<Giveaway>(key(id));
        if (
          !c ||
          !canRead(ctx, c.value, i.member) ||
          !c.value.winners.includes(i.user.id) ||
          c.value.claimBy <= Date.now()
        )
          return i.reply({ content: t(ctx, "unclaimed"), ephemeral: true });
        if (
          c.value.claimed.includes(i.user.id) ||
          (
            await ctx.kv
              .atomic()
              .check(key(id), c.version)
              .set(key(id), { ...c.value, claimed: [...c.value.claimed, i.user.id] })
              .commit()
          ).ok
        ) {
          await payout(ctx, c.value, i.user.id);
          return i.reply({ content: t(ctx, "claimed"), ephemeral: true });
        }
      }
    },
  },
  tasks: {
    async recover(ctx, p) {
      await reconcile(ctx, (p as { cursor?: string } | undefined)?.cursor);
    },
    async purge(ctx, p) {
      const { id } = p as { id: string };
      const row = await ctx.kv.get<Giveaway>(key(id));
      if (!row || !row.expiresAt || row.expiresAt > Date.now()) return;
      if (row.messageId)
        await (
          await ctx.server.channel({ id: row.channelId }).message(row.messageId)
        )?.edit({ content: t(ctx, "expired"), embeds: [], components: [] });
      for (const prefix of [entryKey(id), "notice:" + id + ":"]) {
        const page = await ctx.kv.list({ prefix, limit: 100 });
        const tx = ctx.kv.atomic();
        for (const item of page.items) tx.delete(item.key);
        if (page.items.length) await tx.commit();
        if (page.cursor) {
          await ctx.schedule.after(1, "purge", { id });
          return;
        }
      }
      await ctx.kv.atomic().delete(countKey(id)).delete(refreshKey(id)).delete(key(id)).commit();
    },
    async start(ctx, p) {
      const g = await ctx.kv.get<Giveaway>(key((p as { id: string }).id));
      if (ctx.config.enabled && g?.state === "open") await kickoff(ctx, g);
    },
    async finish(ctx, p) {
      await settle(ctx, (p as { id: string }).id, 1);
    },
    async expire(ctx, p) {
      const { id, round } = p as { id: string; round: number };
      const g = await ctx.kv.get<Giveaway>(key(id));
      if (g?.round === round && Date.now() >= g.claimBy) {
        const missing = g.winners.filter((w) => !g.claimed.includes(w));
        if (missing.length) await settle(ctx, id, round + 1, missing.length);
      }
    },
    async refresh(ctx, p) {
      const g = await ctx.kv.get<Giveaway>(key((p as { id: string }).id));
      if (ctx.config.enabled && g) await refresh(ctx, g);
    },
  },
  routes: defineRoutes<Routes>({
    "GET /giveaways/:id": {
      access: "public",
      async handler(ctx, r) {
        const g = await ctx.kv.get<Giveaway>(key(r.params.id));
        if (!g || !ctx.config.enabled || !canRead(ctx, g, r.viewer?.member)) return { status: 404 };
        return {
          ...view(g, await entrantCount(ctx, g)),
          ...(ctx.config.publishEntrants && g.state === "ended"
            ? await entryPage(ctx, g.id, r.query.cursor)
            : {}),
        };
      },
    },
    "GET /giveaways/:id/entries": {
      access: "moderator",
      async handler(ctx, r) {
        const g = await ctx.kv.get<Giveaway>(key(r.params.id));
        if (!g || !ctx.config.enabled || !canRead(ctx, g, r.viewer?.member)) return { status: 404 };
        return entryPage(ctx, g.id, r.query.cursor);
      },
    },
    "GET /giveaways": {
      access: "moderator",
      async handler(ctx, r) {
        if (!ctx.config.enabled) return { items: [] };
        const items: DrawView[] = [];
        let cursor = r.query.cursor;
        do {
          const page = await ctx.kv.list<Giveaway>({ prefix: "gw:", limit: 250, cursor });
          for (const row of page.items)
            if (canRead(ctx, row.value, r.viewer?.member)) {
              items.push(view(row.value, await entrantCount(ctx, row.value)));
              if (items.length === 50) return { items, cursor: row.key };
            }
          cursor = page.cursor;
        } while (cursor);
        return { items };
      },
    },
  }),
  privacy: {
    async export(ctx, uid) {
      return inspect(ctx, uid, false);
    },
    async erase(ctx, uid) {
      return { erased: (await inspect(ctx, uid, true)).length };
    },
  },
});
async function inspect(ctx: Context, uid: string, erase: boolean) {
  let cursor: string | undefined;
  const out: { id: string; weight: number; winner: boolean }[] = [];
  do {
    const page = await ctx.kv.list<Giveaway>({ prefix: "gw:", cursor, limit: 100 });
    for (const {
      value: { id },
    } of page.items) {
      for (;;) {
        const g = await ctx.kv.getEntry<Giveaway>(key(id)),
          e = await ctx.kv.getEntry<number>(entryKey(id, uid));
        if (!g || (!e && !g.value.history.includes(uid))) break;
        if (erase) {
          const v = g.value,
            counted = v.state === "open"; // an open giveaway counts entries in countKey
          const next = {
            ...v,
            entrants: v.entrants - (e && !counted ? 1 : 0),
            history: v.history.map((x, j) => (x === uid ? "deleted-" + j : x)),
            winners: v.winners.filter((x) => x !== uid),
            claimed: v.claimed.filter((x) => x !== uid),
            redacted: true,
          };
          const tx = ctx.kv
            .atomic()
            .check(key(id), g.version)
            .check(entryKey(id, uid), e?.version ?? null)
            .delete(entryKey(id, uid))
            .delete(`notice:${id}:${uid}`)
            .set(key(id), next);
          if (e && counted) tx.increment(countKey(id), -1);
          if (!(await tx.commit()).ok) continue;
          if (v.winners.includes(uid)) await refresh(ctx, next);
        }
        out.push({ id, weight: e?.value ?? 0, winner: g.value.history.includes(uid) });
        break;
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}
