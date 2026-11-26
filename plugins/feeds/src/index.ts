import { definePlugin, type Context } from "@cicord/sdk";
import { parseFeed } from "./parse.ts";

type Feed = NonNullable<Context["config"]["feeds"]>[number];
const MINUTE = 60000;
async function poll(ctx: Context, feed: Feed) {
  const stateKey = "state:" + feed.id;
  const state = await ctx.kv.getEntry<{ due: number; errors: number }>(stateKey);
  if ((state?.value.due ?? 0) > Date.now()) return;
  const lease = await ctx.kv
    .atomic()
    .check(stateKey, state?.version ?? null)
    .set(stateKey, { due: Date.now() + 5 * MINUTE, errors: state?.value.errors ?? 0 })
    .commit();
  if (!lease.ok) return;
  try {
    const response = await ctx.http.fetch(feed.url, { timeoutMs: 4000 });
    if (response.status !== 200) throw new Error("Feed unavailable");
    let sent = 0;
    for (const item of parseFeed(await response.text()).reverse()) {
      if (
        feed.keywords?.length &&
        !feed.keywords.some((k) => item.title.toLowerCase().includes(k.toLowerCase()))
      )
        continue;
      const key = "guid:" + feed.id + ":" + item.guid;
      if (!(await ctx.kv.atomic().check(key, null).set(key, "reserved").commit()).ok) continue;
      const role = feed.mentionRole ? ctx.server.role(feed.mentionRole) : undefined;
      const values: Record<string, string> = {
        title: item.title,
        url: item.url,
        role: role?.mention ?? "",
      };
      const content = (feed.template ?? "{role} **{title}**\n{url}")
        .replace(/\{(role|title|url)\}/g, (_, k: string) => values[k]!)
        .trim()
        .slice(0, 2000);
      try {
        await ctx.server.channel(feed.channel).send({
          content,
          allowedMentions: { users: false, roles: role ? [role.id] : false, everyone: false },
        });
      } catch {
        ctx.status.set("delivery:" + feed.id, ctx.i18n.t("uncertain"));
        throw new Error("Feed send uncertain");
      }
      await ctx.kv.set(key, "sent");
      if (++sent >= 8) break;
    }
    await ctx.kv.set(stateKey, { due: Date.now() + ctx.config.pollMinutes * MINUTE, errors: 0 });
    ctx.status.set(feed.id, null);
  } catch {
    const errors = Math.min(10, (state?.value.errors ?? 0) + 1);
    const minutes = Math.min(60, 5 * 2 ** (errors - 1));
    await ctx.kv.set(stateKey, { due: Date.now() + minutes * MINUTE, errors });
    ctx.status.set(feed.id, ctx.i18n.t("backoff", { minutes }));
  }
}
export default definePlugin({
  async onStart(ctx) {
    if (!ctx.config.enabled) return;
    await ctx.kv.set("meta:schema", 1);
    for (const feed of ctx.config.feeds ?? []) {
      const state = await ctx.kv.get<{ due: number; errors: number }>("state:" + feed.id);
      if (state?.errors)
        ctx.status.set(
          feed.id,
          ctx.i18n.t("backoff", {
            minutes: Math.max(1, Math.ceil((state.due - Date.now()) / MINUTE)),
          }),
        );
    }
  },
  schedules: {
    poll: {
      cron: "*/5 * * * *",
      async run(ctx) {
        if (!ctx.config.enabled) return;
        await Promise.all((ctx.config.feeds ?? []).map((feed) => poll(ctx, feed)));
      },
    },
  },
});
