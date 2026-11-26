import {
  command,
  definePlugin,
  defineRoutes,
  subcommand,
  type Channel,
  type Context,
  type Interaction,
  type Json,
  type Member,
  type MessagePayload,
} from "@cicord/sdk";
import { searchKnowledge, sections, tagSources, visible, type Passage } from "./knowledge.ts";
import { askProvider } from "./provider.ts";
import type { Routes } from "./routes.ts";

// Interaction wrappers are instance-local and expire. Durable tasks contain only
// the request ID; a restart leaves the acknowledged contact link available.
type Pending = { interaction: Interaction; question: string; tags: Passage[]; expires: number };
const pending = new Map<string, Pending>();

const quiet = { users: false, roles: false, everyone: false };
const ttl = (ttlSeconds: number) => ({ ttlSeconds });
const userKey = (user: string, key: string) => "user:" + user + ":" + key;
type Handoff = { question: string; answer: string; channel: string; source?: string };
const link = (ctx: Context) => ({
  type: "link" as const,
  url: ctx.config.fallbackContact!.url,
  label: ctx.config.fallbackContact!.text,
});
function allowed(ctx: Context, m: Member) {
  return (
    !ctx.config.excludedRoles.some((r) => m.hasRole(r)) &&
    (!ctx.config.allowedRoles.length || ctx.config.allowedRoles.some((r) => m.hasRole(r)))
  );
}
async function answer(
  ctx: Context,
  user: Member,
  ch: Channel,
  question: string,
  id: string,
  ephemeral: boolean,
  history: string[] = [],
  tags?: Passage[],
): Promise<MessagePayload> {
  const say = (key: string) => ({ content: ctx.i18n.t(key), allowedMentions: quiet });
  if (!ctx.config.enabled) return say("disabled");
  if (
    ch.type === "dm" ||
    !user.canView(ch) ||
    !allowed(ctx, user) ||
    (await ctx.kv.get("opt:" + user.id))
  )
    return say("restricted");
  const mkey = userKey(user.id, "rate"),
    ckey = "rate:" + ch.id;
  if (
    !(
      await ctx.kv
        .atomic()
        .check(mkey, null)
        .check(ckey, null)
        .set(mkey, true, ttl(ctx.config.memberInterval))
        .set(ckey, true, ttl(ctx.config.channelInterval))
        .commit()
    ).ok
  )
    return say("limited");
  const live = await ctx.server.member(user.id);
  if (!live || !allowed(ctx, live) || !live.canView(ch)) return say("restricted");
  const docs = await searchKnowledge(ctx, question, live, ephemeral ? undefined : ch, tags);
  const result =
    docs.length && ctx.secrets.has("API_KEY")
      ? await askProvider(ctx, question, docs, history)
      : docs.length
        ? "unavailable"
        : "unknown";
  const current = await ctx.server.member(user.id);
  if (
    !current ||
    !allowed(ctx, current) ||
    !current.canView(ch) ||
    (await ctx.kv.get("opt:" + user.id))
  )
    return say("restricted");
  const source: Passage | undefined =
    typeof result === "object" && visible(ctx, result, current, ephemeral ? undefined : ch)
      ? result
      : undefined;
  const content = source
    ? source.text +
      "\n\n[" +
      source.title.replace(/[\[\]()<>]/g, "").slice(0, 120) +
      "](<" +
      source.url +
      ">)"
    : ctx.i18n.t(typeof result === "string" ? result : "unknown");
  const row: NonNullable<MessagePayload["components"]>[number] = {
    type: "row",
    components: [link(ctx)],
  };
  if (ctx.features.enabled("tickets") && ctx.plugins.has("tickets")) {
    // Keep only a short-lived, owner-scoped handoff. A restricted passage is never copied into a new ticket.
    await ctx.kv.set(
      userKey(user.id, "handoff:" + id),
      {
        question,
        answer: source?.channel ? "" : content,
        channel: ch.id,
        ...(source?.channel ? { source: source.channel } : {}),
      },
      ttl(900),
    );
    row.components.unshift({ type: "button", id: "human:" + id, label: ctx.i18n.t("human") });
  }
  if (!source && ctx.config.keepUnanswered)
    await ctx.kv.set(
      userKey(user.id, "review:" + id),
      { question, channel: ch.id },
      ttl(7 * 86400),
    );
  if (source) {
    row.components.push(
      { type: "button", id: "vote:up:" + id, emoji: "👍" },
      { type: "button", id: "vote:down:" + id, emoji: "👎" },
    );
  }
  return { content: content.slice(0, 2000), components: [row], allowedMentions: quiet };
}

async function memberRecords(ctx: Context, id: string, erase: boolean) {
  const out: Record<string, Json> = {};
  let n = 0;
  for (const [key, job] of pending) {
    if (job.interaction.user.id === id) {
      if (erase) {
        pending.delete(key);
        n++;
      } else out["pending:" + key] = job.question;
    }
  }
  let cursor: string | undefined;
  for (const prefix of [userKey(id, ""), "forum:" + id + ":"]) {
    do {
      const page = await ctx.kv.list({ prefix, cursor, limit: 100 });
      for (const item of page.items) {
        if (erase) {
          if (prefix.startsWith("forum:")) {
            const ref = item.value as { doc: string; task: string };
            await ctx.index("solved").remove(ref.doc);
            await ctx.schedule.cancel(ref.task);
          }
          if (item.key.includes(":task:") && typeof item.value === "string")
            await ctx.schedule.cancel(item.value);
          await ctx.kv.delete(item.key);
          n++;
        } else out[item.key] = item.value;
      }
      cursor = page.cursor;
    } while (cursor);
  }
  const opt = await ctx.kv.get("opt:" + id);
  if (opt !== undefined) {
    if (erase) {
      await ctx.kv.delete("opt:" + id);
      n++;
    } else out.optout = opt;
  }
  return { out, n };
}

export default definePlugin({
  async onStart(ctx) {
    if (!ctx.config.enabled) return;
    await ctx.kv.set("meta:schema", 1);
    await ctx.index("knowledge").clear();
    await ctx.schedule.after(1, "indexFiles", 0);
  },
  tasks: {
    async indexFiles(ctx, input) {
      if (!ctx.config.enabled) return;
      let file = 0,
        offset = 0;
      if (input && typeof input === "object" && !Array.isArray(input)) {
        file = Number(input.file) || 0;
        offset = Number(input.offset) || 0;
      }
      const files = await ctx.files.list("knowledge/**/*.md");
      let remaining = 24,
        visited = 0;
      while (file < files.length && remaining > 0 && visited++ < 8) {
        const path = files[file]!;
        const docs = sections(await ctx.files.read(path), path, ctx.config.documentBaseURL!);
        for (const doc of docs.slice(offset, offset + remaining)) {
          await ctx.index("knowledge").upsert(path + "#" + doc.section, {
            title: doc.title,
            text: doc.text,
            meta: { path, section: doc.section! },
          });
          offset++;
          remaining--;
        }
        if (offset >= docs.length) {
          file++;
          offset = 0;
        }
      }
      if (file < files.length) await ctx.schedule.after(1, "indexFiles", { file, offset });
    },
    async forget(ctx, p, task) {
      const d = p as { doc: string; key: string },
        ref = await ctx.kv.get<{ task: string }>(d.key);
      if (task?.id === ref?.task) {
        await ctx.index("solved").remove(d.doc);
        await ctx.kv.delete(d.key);
      }
    },
    async privateAnswer(ctx, p) {
      if (typeof p !== "string") return;
      const job = pending.get(p);
      pending.delete(p);
      if (!job || job.expires <= Date.now()) return;
      const it = job.interaction;
      try {
        if (!it.channel) return;
        const user = await ctx.server.member(it.user.id);
        if (!user) return;
        const content = await answer(ctx, user, it.channel, job.question, p, true, [], job.tags);
        await it.followUp({ ...content, ephemeral: true });
      } finally {
        await ctx.kv.delete(userKey(it.user.id, "task:" + p));
      }
    },
    async help(ctx, p) {
      if (!ctx.config.enabled) return;
      const ref = p as { channel: string; message: string };
      const channel = ctx.server.channel({ id: ref.channel }),
        msg = await channel.message(ref.message);
      if (
        !msg?.member ||
        msg.author.bot ||
        !(
          ctx.config.channels.includes(channel.key ?? "") ||
          msg.content.includes("<@" + ctx.bot.user.id + ">") ||
          (channel.type === "thread" && (await ctx.kv.get("thread:" + channel.id)))
        )
      )
        return;
      const key = "reply:" + msg.id;
      if (
        !(
          await ctx.kv
            .atomic()
            .check(key, null)
            .set(key, true, ttl(30 * 86400))
            .commit()
        ).ok
      )
        return;
      await channel.typing();
      const q = msg.content.slice(0, 1000),
        history: string[] = [];
      if (channel.type === "thread" && ctx.config.threadContextMessages > 0) {
        for (const previous of (
          await channel.messages({ limit: ctx.config.threadContextMessages, before: msg.id })
        ).reverse()) {
          if (!previous.author.bot && !(await ctx.kv.get("opt:" + previous.author.id)))
            history.push(previous.content.slice(0, 750));
        }
      }
      const reply = await answer(ctx, msg.member, channel, q, msg.id, false, history);
      await msg.reply(reply);
      await ctx.kv.delete(userKey(msg.author.id, "task:" + msg.id));
    },
  },
  commands: {
    ask: command({
      description: "Ask about community knowledge",
      subcommands: {
        question: subcommand({
          description: "Get an answer with sources",
          options: {
            question: {
              type: "string",
              description: "Your question",
              required: true,
              minLength: 1,
              maxLength: 1000,
            },
          },
          async run(ctx, it) {
            if (!it.member || !it.channel) {
              await it.reply({ content: ctx.i18n.t("restricted"), ephemeral: true });
              return;
            }
            if (
              !ctx.config.enabled ||
              !allowed(ctx, it.member) ||
              !it.member.canView(it.channel) ||
              (await ctx.kv.get("opt:" + it.user.id))
            ) {
              await it.reply({
                content: ctx.i18n.t(ctx.config.enabled ? "restricted" : "disabled"),
                ephemeral: true,
              });
              return;
            }
            for (const [id, job] of pending) if (job.expires <= Date.now()) pending.delete(id);
            if (pending.size >= 100) {
              await it.reply({ content: ctx.i18n.t("limited"), ephemeral: true });
              return;
            }
            await it.defer({ ephemeral: true });
            const tags = await tagSources(ctx, it.options.question, it.member);
            await it.reply({
              content: ctx.i18n.t("queued"),
              ephemeral: true,
              components: [{ type: "row", components: [link(ctx)] }],
            });
            pending.set(it.id, {
              interaction: it,
              question: it.options.question,
              tags,
              expires: Date.now() + 14 * 60000,
            });
            try {
              const task = await ctx.schedule.after(1, "privateAnswer", it.id);
              await ctx.kv.set(userKey(it.user.id, "task:" + it.id), task.id, ttl(900));
            } catch {
              pending.delete(it.id);
              await it.followUp({
                content: ctx.i18n.t("unavailable"),
                ephemeral: true,
                components: [{ type: "row", components: [link(ctx)] }],
              });
            }
          },
        }),
        optout: subcommand({
          description: "Change your participation preference",
          options: {
            enabled: {
              type: "boolean",
              description: "Disable assistant processing for your account",
              required: true,
            },
          },
          async run(ctx, it) {
            if (ctx.config.enabled) {
              if (it.options.enabled) {
                await memberRecords(ctx, it.user.id, true);
                await ctx.kv.set("opt:" + it.user.id, true);
              } else await ctx.kv.delete("opt:" + it.user.id);
            }
            await it.reply({
              content: ctx.i18n.t(ctx.config.enabled ? "optout" : "disabled"),
              ephemeral: true,
            });
          },
        }),
      },
    }),
  },
  events: {
    async threadCreate(ctx, e) {
      const key = e.parent?.key;
      if (
        ctx.config.enabled &&
        ctx.features.enabled("helpChannels") &&
        key &&
        (ctx.config.channels.includes(key) || ctx.config.solvedForums.includes(key))
      )
        await ctx.kv.set("thread:" + e.thread.id, key, ttl(30 * 86400));
    },
    async messageCreate(ctx, msg) {
      if (
        !ctx.config.enabled ||
        !ctx.features.enabled("helpChannels") ||
        msg.author.bot ||
        !msg.member ||
        msg.channel.type === "dm" ||
        (await ctx.kv.get("opt:" + msg.author.id))
      )
        return;
      const forum =
        msg.channel.type === "thread" &&
        (await ctx.kv.get("thread:" + msg.channel.id)) &&
        msg.id === msg.channel.id;
      if (
        !(
          forum ||
          msg.content.includes("<@" + ctx.bot.user.id + ">") ||
          ctx.config.channels.includes(msg.channel.key ?? "")
        )
      )
        return;
      const task = await ctx.schedule.after(1, "help", {
        channel: msg.channel.id,
        message: msg.id,
      });
      await ctx.kv.set(userKey(msg.author.id, "task:" + msg.id), task.id, ttl(86400));
    },
  },
  components: {
    async human(ctx, it) {
      const id = it.componentId.split(":")[1],
        saved = await ctx.kv.get<Handoff>(userKey(it.user.id, "handoff:" + id));
      let opened = false;
      if (
        saved &&
        ctx.config.enabled &&
        it.member?.canView({ id: saved.channel }) &&
        ctx.features.enabled("tickets") &&
        ctx.plugins.has("tickets")
      ) {
        // A question asked in a private channel must not move into a wider staff ticket.
        if (!saved.source && ctx.server.audience({ id: saved.channel }).public) {
          try {
            await ctx.plugins.call(
              "tickets",
              "open",
              {
                userId: it.user.id,
                subject: saved.question.slice(0, 100),
                description: (saved.question + "\n" + saved.answer).slice(0, 1000),
              },
              { idempotencyKey: "ask:" + id },
            );
            opened = true;
          } catch {
            /* Always give the configured contact when the outcome is uncertain. */
          }
        }
      }
      await it.reply({
        ephemeral: true,
        content: opened
          ? ctx.i18n.t("ticket")
          : (ctx.config.fallbackContact?.text ?? ctx.i18n.t("disabled")),
        components:
          !opened && ctx.config.fallbackContact ? [{ type: "row", components: [link(ctx)] }] : [],
      });
    },
    async vote(ctx, it) {
      const [, direction, id] = it.componentId.split(":");
      if (ctx.config.enabled && id && (direction === "up" || direction === "down"))
        await ctx.kv.set(userKey(it.user.id, "vote:" + id), direction, ttl(7 * 86400));
      await it.reply({ content: ctx.i18n.t("feedback"), ephemeral: true });
    },
  },
  privacy: {
    async export(ctx, id) {
      return (await memberRecords(ctx, id, false)).out;
    },
    async erase(ctx, id) {
      return { erased: (await memberRecords(ctx, id, true)).n };
    },
  },
  routes: defineRoutes<Routes>({
    "GET /unanswered": {
      access: "moderator",
      async handler(ctx, req) {
        if (!ctx.config.enabled || !ctx.config.keepUnanswered || !req.viewer?.member)
          return { items: [] };
        const page = await ctx.kv.list({ prefix: "user:", cursor: req.query.cursor, limit: 100 });
        return {
          items: page.items
            .filter((it) => it.key.includes(":review:"))
            .map((it) => it.value as { question: string; channel: string })
            .filter((it) => req.viewer!.member!.canView({ id: it.channel })),
          ...(page.cursor ? { cursor: page.cursor } : {}),
        };
      },
    },
    "POST /solved": {
      access: "moderator",
      async handler(ctx, req) {
        const { channel, message, thread } = req.body ?? {};
        if (
          !ctx.config.enabled ||
          !ctx.features.enabled("helpChannels") ||
          !channel ||
          !message ||
          !ctx.config.solvedForums.includes(channel) ||
          !req.viewer?.member?.canView(channel) ||
          !/^\d{1,20}$/.test(message ?? "")
        )
          return { status: 403, body: { saved: false } };
        if (
          thread &&
          (!/^\d{1,20}$/.test(thread) ||
            (await ctx.kv.get("thread:" + thread)) !== channel ||
            !req.viewer.member.canView({ id: thread }))
        )
          return { status: 403, body: { saved: false } };
        const msg = await ctx.server.channel(thread ? { id: thread } : channel).message(message);
        if (!msg?.content || (await ctx.kv.get("opt:" + msg.author.id)))
          return { status: 400, body: { saved: false } };
        const doc = channel + ":" + message,
          key = "forum:" + msg.author.id + ":" + doc;
        const task = await ctx.schedule.after(30 * 86400000, "forget", { doc, key });
        await ctx.kv.set(key, { doc, task: task.id });
        await ctx.index("solved").upsert(doc, {
          text: msg.content.slice(0, 1600),
          meta: { channel, forum: message, ...(thread ? { thread } : {}) },
        });
        return { saved: true };
      },
    },
  }),
});
