import { definePlugin, type Context, type Message, type Json } from "@cicord/sdk";

type DeleteJob = { id: string; channel: string; message: string; task: string; owner: string };
const hour = 3600000;
const reason = "Configured channel automation";

async function deleteLater(ctx: Context, m: Message, ms: number) {
  const key = `delete:${m.author.id}:${m.id}`;
  if (await ctx.kv.get(key)) return;
  const id = String(await ctx.kv.increment("seq"));
  const task = await ctx.schedule.after(ms, "cleanup", { id });
  const data = { id, channel: m.channel.id, message: m.id, task: task.id, owner: m.author.id };
  if (
    !(
      await ctx.kv
        .atomic()
        .check(key, null)
        .set(key, id)
        .set("job:" + id, data)
        .commit()
    ).ok
  )
    await ctx.schedule.cancel(task.id);
}
async function remove(m: Message) {
  if ((await m.channel.pins()).some((p) => p.id === m.id)) return false;
  await m.delete(reason);
  return true;
}
async function process(ctx: Context, m: Message) {
  if (!ctx.config.enabled || !m.author) return;
  const rule = ctx.config.rules?.find(
    (r) => m.channel.key === r.channel || m.channel.id === r.channel,
  );
  if (!rule) return;
  const feature = (name: string) => ctx.features.enabled(name);
  if (m.author.bot) {
    if (rule.cleanBots && feature("cleanup")) await deleteLater(ctx, m, rule.cleanBots * 60000);
    return;
  }
  if (
    rule.mediaOnly &&
    feature("mediaOnly") &&
    !m.attachments.length &&
    !/https?:\/\/[^\s<>]+/i.test(m.content)
  ) {
    if (await remove(m)) {
      const key = "dm:" + m.author.id;
      if ((await ctx.kv.atomic().check(key, null).set(key, true, { ttlSeconds: 3600 }).commit()).ok)
        await (m.member ?? (await ctx.server.member(m.author.id)))?.send(
          ctx.i18n.t("media", { channel: m.channel.mention }),
        );
    }
    return;
  }
  if (rule.onePostPer && feature("cleanup")) {
    const key = `period:${m.author.id}:${m.channel.id}`,
      e = await ctx.kv.get<string>(key);
    if (
      e !== m.id &&
      !(
        await ctx.kv
          .atomic()
          .check(key, null)
          .set(key, m.id, { ttlSeconds: rule.onePostPer * 60 })
          .commit()
      ).ok
    ) {
      if ((await ctx.kv.get(key)) !== m.id) await remove(m);
      return;
    }
  }
  if (rule.autoDelete && feature("cleanup")) await deleteLater(ctx, m, rule.autoDelete * hour);
  if (
    rule.autoThread &&
    feature("threads") &&
    !(await ctx.kv.get("thread:" + m.author.id + ":" + m.id))
  ) {
    // Discord uses the starter message ID as the public thread ID and enforces one thread per message.
    try {
      await m.channel.createThread(
        rule.autoThread
          .replaceAll("{author}", m.author.displayName)
          .replaceAll("{id}", m.id)
          .slice(0, 100),
        { fromMessage: m.id },
      );
    } catch (e) {
      if (!/160004|thread.*already|already.*thread/i.test(String(e))) throw e;
    }
    await ctx.kv.set("thread:" + m.author.id + ":" + m.id, true, { ttlSeconds: 31 * 86400 });
  }
  if (feature("reactions")) for (const emoji of rule.autoReact ?? []) await m.react(emoji);
  if (rule.autoCrosspost && feature("crosspost") && m.channel.type === "announcement") {
    try {
      await m.crosspost();
    } catch (e) {
      ctx.log.warn("Crosspost unavailable", { channel: m.channel.id, error: String(e) });
    }
  }
}
async function personal(ctx: Context, id: string, erase: boolean) {
  const data: Json[] = [];
  for (const prefix of [
    "delete:" + id + ":",
    "period:" + id + ":",
    "thread:" + id + ":",
    "dm:" + id,
  ]) {
    let cursor: string | undefined;
    do {
      const page = await ctx.kv.list({ prefix, limit: 100, cursor });
      for (const { key, value } of page.items) {
        if (prefix === "dm:" + id && key !== prefix) continue;
        if (key.startsWith("delete:")) {
          const job = await ctx.kv.get<DeleteJob>("job:" + String(value));
          if (job) {
            data.push(job);
            if (erase) {
              await ctx.schedule.cancel(job.task);
              await ctx.kv.delete("job:" + job.id);
            }
          }
        } else data.push({ key, value });
        if (erase) await ctx.kv.delete(key);
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return data;
}
export default definePlugin({
  async onStart(ctx) {
    await ctx.kv.set("meta:schema", 1);
  },
  events: { messageCreate: process },
  tasks: {
    async cleanup(ctx, payload) {
      const id = (payload as { id: string }).id,
        job = await ctx.kv.get<DeleteJob>("job:" + id);
      if (!job) return;
      if (ctx.config.enabled && ctx.features.enabled("cleanup")) {
        const channel = ctx.server.channel({ id: job.channel }),
          m = await channel.message(job.message);
        if (m) await remove(m);
      }
      await ctx.kv
        .atomic()
        .delete("job:" + id)
        .delete(`delete:${job.owner}:${job.message}`)
        .commit();
    },
  },
  privacy: {
    export: (ctx, id) => personal(ctx, id, false),
    async erase(ctx, id) {
      return { erased: (await personal(ctx, id, true)).length };
    },
  },
});
