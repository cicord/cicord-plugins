import {
  command,
  definePlugin,
  subcommand,
  type Context,
  type Message,
  type TextChannel,
} from "@cicord/sdk";

type Highlight = {
  messageId: string;
  sourceId: string;
  destination: string;
  authorId?: string;
  copyId?: string;
  pendingAt?: number;
  stars: number;
  lastEdit?: number;
  due: number;
  published?: boolean;
};
const key = (id: string) => "star:" + id;
function destination(ctx: Context, source: TextChannel) {
  const explicit = ctx.config.boards.find((b) =>
    b.sources.some((s) => ctx.server.channel(s).id === source.id),
  );
  if (!explicit && !ctx.server.audience(source).public) return;
  const target = explicit?.channel ?? ctx.config.channel;
  if (!target) return;
  const board = ctx.server.channel(target),
    relation = ctx.server.compareAudience(source, board);
  return board.id !== source.id && (relation === "same" || relation === "narrower")
    ? board
    : undefined;
}
async function enqueue(ctx: Context, m: Message, emoji: string) {
  if (!ctx.config.enabled || emoji !== ctx.config.emoji) return;
  const k = key(m.id),
    prior = await ctx.kv.getEntry<Highlight>(k),
    board = destination(ctx, m.channel);
  if (!prior && !board) return;
  if (prior && prior.value.due > 0) return;
  const state = prior?.value ?? {
    messageId: m.id,
    sourceId: m.channel.id,
    destination: board!.id,
    stars: 0,
  };
  // Queue first. An interrupted write leaves a harmless task; a committed due time always has a task.
  const delay = Math.max(10, 10000 - (Date.now() - (prior?.value.lastEdit ?? Date.now())));
  await ctx.schedule.after(delay, "refresh", { id: m.id });
  await ctx.kv
    .atomic()
    .check(k, prior?.version ?? null)
    .set(k, { ...state, due: Date.now() + delay })
    .commit();
}
async function recover(ctx: Context, g: Highlight) {
  const channel = ctx.server.channel({ id: g.destination });
  if (g.copyId) return channel.message(g.copyId);
  if (!g.pendingAt) return;
  let before: string | undefined;
  do {
    const messages = await channel.messages({ limit: 100, before });
    const found = messages.find(
      (m) =>
        m.author.id === ctx.bot.user.id &&
        m.embeds.some((e) => e.footer?.text === "star/" + g.messageId),
    );
    if (found) return found;
    before =
      messages.length === 100 && messages.at(-1)!.createdAt.getTime() >= g.pendingAt - 10000
        ? messages.at(-1)!.id
        : undefined;
  } while (before);
}
async function remove(ctx: Context, g: Highlight) {
  const copy = await recover(ctx, g);
  if (copy) await copy.delete("Starboard removed");
  await ctx.kv.atomic().delete(key(g.messageId)).rankRemove("stars", g.messageId).commit();
}
export async function sync(ctx: Context, id: string) {
  const k = key(id),
    snapshot = await ctx.kv.getEntry<Highlight>(k);
  if (!snapshot) return;
  const g = snapshot.value,
    source = ctx.server.channel({ id: g.sourceId }),
    board = destination(ctx, source);
  const m = board && (await source.message(id));
  if (
    !board ||
    board.id !== g.destination ||
    !m ||
    (m.author.bot && !ctx.config.includeBots) ||
    Date.now() - m.createdAt.getTime() > ctx.config.historyDays * 86400000
  ) {
    await remove(ctx, g);
    return;
  }
  if (!ctx.config.enabled) return;
  const count = m.reactions.find((r) => r.emoji === ctx.config.emoji)?.count ?? 0;
  const self = count
    ? await m.reactionUsers(ctx.config.emoji, {
        limit: 1,
        after: (BigInt(m.author.id) - 1n).toString(),
      })
    : [];
  const stars = Math.max(0, count - Number(self.some((u) => u.id === m.author.id)));
  if (stars < ctx.config.threshold && (ctx.config.removeBelow || (!g.copyId && !g.pendingAt))) {
    await remove(ctx, g);
    return;
  }
  const reserved = {
    ...g,
    authorId: m.author.id,
    stars,
    pendingAt: g.pendingAt ?? Date.now(),
    due: 0,
    lastEdit: Date.now(),
  };
  if (!(await ctx.kv.atomic().check(k, snapshot.version).set(k, reserved).commit()).ok) return;
  const payload = {
    embeds: [
      {
        description: m.content.slice(0, 3500),
        author: { name: m.author.displayName },
        url: m.url,
        title: ctx.i18n.t("source"),
        fields: [{ name: ctx.config.emoji, value: String(stars) }],
        footer: { text: "star/" + id },
        ...(m.attachments.find((a) => a.contentType?.startsWith("image/"))
          ? { image: { url: m.attachments.find((a) => a.contentType?.startsWith("image/"))!.url } }
          : {}),
      },
    ],
    allowedMentions: { users: [], roles: [], everyone: false },
  };
  const copy = await recover(ctx, g);
  if (!destination(ctx, source)) {
    await remove(ctx, reserved);
    return;
  }
  const sent = copy
    ? await copy.edit(payload)
    : await board.send({ ...payload, nonce: id, enforceNonce: true });
  if (destination(ctx, source)?.id !== board.id) {
    await sent.delete("Audience changed");
    await remove(ctx, reserved);
    return;
  }
  for (;;) {
    const latest = await ctx.kv.getEntry<Highlight>(k);
    if (!latest) {
      await sent.delete("Source removed");
      return;
    }
    if (
      (
        await ctx.kv
          .atomic()
          .check(k, latest.version)
          .set(k, { ...latest.value, copyId: sent.id, stars, authorId: m.author.id })
          .rankSet("stars", id, stars)
          .commit()
      ).ok
    )
      break;
  }
  if (!g.published) {
    await ctx.events.publish(
      "starred",
      { messageId: id, authorId: m.author.id, stars },
      { idempotencyKey: "star:" + id },
    );
    for (;;) {
      const latest = await ctx.kv.getEntry<Highlight>(k);
      if (!latest || latest.value.published) break;
      if (
        (
          await ctx.kv
            .atomic()
            .check(k, latest.version)
            .set(k, { ...latest.value, published: true })
            .commit()
        ).ok
      )
        break;
    }
  }
}
async function audit(ctx: Context, cursor?: string) {
  const p = await ctx.kv.list<Highlight>({ prefix: "star:", limit: 100, cursor });
  for (const row of p.items) await ctx.schedule.after(1, "refresh", { id: row.value.messageId });
  if (p.cursor) await ctx.schedule.after(1, "audit", { cursor: p.cursor });
}
// A reaction event carries a partial message, so a highlight still inside its coalescing
// window has no author yet. Resolve it from the source so erasure cannot miss it.
async function author(ctx: Context, v: Highlight) {
  if (v.authorId || !v.due) return v.authorId;
  try {
    return (await ctx.server.channel({ id: v.sourceId }).message(v.messageId))?.author.id;
  } catch {
    return undefined;
  }
}
async function personal(ctx: Context, uid: string, erase: boolean) {
  let cursor: string | undefined;
  const rows: { messageId: string; stars: number }[] = [];
  do {
    const page = await ctx.kv.list<Highlight>({ prefix: "star:", limit: 250, cursor });
    for (const { value: v } of page.items)
      if ((await author(ctx, v)) === uid) {
        rows.push({ messageId: v.messageId, stars: v.stars });
        if (erase) await remove(ctx, v);
      }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}
export default definePlugin({
  onStart: (ctx) => ctx.schedule.after(1, "audit").then(() => {}),
  events: {
    reactionAdd: (ctx, r) => enqueue(ctx, r.message, r.emoji),
    reactionRemove: (ctx, r) => enqueue(ctx, r.message, r.emoji),
    async messageDelete(ctx, v) {
      const g = await ctx.kv.get<Highlight>(key(v.id));
      if (g) await remove(ctx, g);
    },
  },
  schedules: { audit: { cron: "0 3 * * *", run: (ctx) => audit(ctx) } },
  tasks: {
    async refresh(ctx, p) {
      await sync(ctx, (p as { id: string }).id);
    },
    async audit(ctx, p) {
      await audit(ctx, (p as { cursor?: string } | undefined)?.cursor);
    },
  },
  commands: {
    starboard: command({
      description: "Community highlights",
      ephemeral: true,
      subcommands: {
        top: subcommand({
          description: "Show the most starred messages you can read",
          async run(ctx, i) {
            if (!ctx.config.enabled) return i.reply(ctx.i18n.t("off"));
            const ranked = await ctx.kv.ranking("stars").top({ limit: 100 }),
              lines: string[] = [];
            for (const e of ranked) {
              const row = await ctx.kv.get<Highlight>(key(e.member));
              if (!row || !row.copyId) continue;
              const source = ctx.server.channel({ id: row.sourceId }),
                board = destination(ctx, source);
              if (
                !board ||
                board.id !== row.destination ||
                !i.member?.canView(source) ||
                !i.member.canView(board)
              )
                continue;
              lines.push(
                `${e.score} ${ctx.config.emoji} <https://discord.com/channels/${ctx.server.id}/${board.id}/${row.copyId}>`,
              );
              if (lines.length >= 10) break;
            }
            await i.reply(lines.join("\n") || ctx.i18n.t("empty"));
          },
        }),
      },
    }),
  },
  privacy: {
    export: (ctx, id) => personal(ctx, id, false),
    async erase(ctx, id) {
      return { erased: (await personal(ctx, id, true)).length };
    },
  },
});
