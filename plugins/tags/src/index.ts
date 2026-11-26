import {
  command,
  definePlugin,
  defineRoutes,
  query,
  type Channel,
  type Context,
  type Member,
  type Interaction,
} from "@cicord/sdk";
import type { Tag, TagResult, TagSearch } from "./contracts.ts";
import type { Routes } from "./routes.ts";
import { parseTag, search, valid, visible } from "./catalog.ts";

const git = new Map<string, Tag>(),
  portal = new Map<string, Tag>();
const lower = (s: string) => s.trim().toLowerCase();
const quiet = { users: false, roles: false, everyone: false };
function all() {
  return [...git.values(), ...portal.values()].filter(
    (t, i) => i < git.size || !git.has(lower(t.name)),
  );
}
function matches(ctx: Context, q: string, n: number, viewer?: Member, destination?: Channel) {
  if (!ctx.config.enabled) return [];
  return search(
    all().filter((t) => visible(ctx, t, viewer, destination)),
    q,
    Math.min(50, Math.max(n, 1)),
  );
}
function exact(ctx: Context, name: string, it: Interaction) {
  return matches(ctx, name, 25, it.member, it.channel).find((t) =>
    [t.name, ...t.aliases].some((a) => lower(a) === lower(name)),
  );
}
async function send(ctx: Context, it: Interaction, name: string, userId?: string) {
  const tag = exact(ctx, name, it);
  if (!tag) {
    await it.reply({ content: ctx.i18n.t("missing"), ephemeral: true });
    return;
  }
  await it.reply({
    content: (userId ? "<@" + userId + "> " : "") + tag.text,
    allowedMentions: { ...quiet, users: userId ? [userId] : false },
  });
  await ctx.kv.increment("used:" + lower(tag.name));
}

export default definePlugin({
  async onStart(ctx) {
    git.clear();
    portal.clear();
    if (!ctx.config.enabled) return;
    if (ctx.features.enabled("files")) {
      const paths = await ctx.files.list("tags/**/*.md");
      for (let i = 0; i < paths.length; i += 32)
        await Promise.all(
          paths.slice(i, i + 32).map(async (path) => {
            const tag = parseTag(await ctx.files.read(path));
            if (!tag) throw new Error("Invalid tag frontmatter in " + path);
            if (git.has(lower(tag.name))) throw new Error("Duplicate tag name: " + tag.name);
            git.set(lower(tag.name), tag);
          }),
        );
    }
    let cursor: string | undefined;
    do {
      const page = await ctx.kv.list<Tag>({ prefix: "portal:", limit: 100, cursor });
      for (const item of page.items) portal.set(lower(item.value.name), item.value);
      cursor = page.cursor;
    } while (cursor && portal.size <= 1000);
    await ctx.kv.set("meta:schema", 1);
  },
  commands: {
    tag: command({
      description: "Share a saved answer",
      options: {
        name: {
          type: "string",
          description: "Tag name or alias",
          required: true,
          autocomplete: (ctx, it, opt) =>
            matches(ctx, opt.value, 25, it.member, it.channel).map((t) => ({
              name: t.name,
              value: t.name,
            })),
        },
        user: { type: "user", description: "Mention a member" },
      },
      async run(ctx, it) {
        await send(ctx, it, it.options.name, it.options.user?.id);
      },
    }),
  },
  contextMenus: {
    "Reply with a tag": {
      type: "message",
      ephemeral: true,
      async run(ctx, it) {
        const choices = matches(ctx, "", 25, it.member, it.channel);
        if (!choices.length) {
          await it.reply({ content: ctx.i18n.t("missing"), ephemeral: true });
          return;
        }
        await it.reply({
          ephemeral: true,
          components: [
            {
              type: "row",
              components: [
                {
                  type: "select",
                  id: "pick",
                  placeholder: ctx.i18n.t("choose"),
                  options: choices.map((t) => ({ label: t.name, value: t.name })),
                },
              ],
            },
          ],
        });
      },
    },
  },
  components: {
    pick: async (ctx, it) => {
      await send(ctx, it, it.values?.[0] ?? "");
    },
  },
  events: {
    async messageCreate(ctx, msg) {
      if (
        !ctx.config.enabled ||
        !ctx.features.enabled("autoReplies") ||
        msg.author.bot ||
        !msg.member ||
        !ctx.config.channels.includes(msg.channel.key ?? "")
      )
        return;
      const content = lower(msg.content);
      const tag = all().find(
        (t) =>
          visible(ctx, t, msg.member, msg.channel) &&
          t.keywords.some((word) => content.includes(lower(word))),
      );
      if (!tag) return;
      const key = "debounce:" + msg.channel.id;
      if (
        !(
          await ctx.kv
            .atomic()
            .check(key, null)
            .set(key, true, { ttlSeconds: ctx.config.debounceSeconds })
            .commit()
        ).ok
      )
        return;
      await msg.reply({ content: tag.text, allowedMentions: quiet });
      await ctx.kv.increment("used:" + lower(tag.name));
    },
  },
  queries: {
    search: query<TagSearch, TagResult>({
      async run(ctx, input, call) {
        const viewer = call.onBehalfOf
          ? await ctx.server.member(call.onBehalfOf.userId)
          : undefined;
        return { entries: matches(ctx, input.query, input.limit, viewer ?? undefined) };
      },
    }),
  },
  routes: defineRoutes<Routes>({
    "GET /stats": {
      access: "moderator",
      async handler(ctx, req) {
        const tags = matches(ctx, req.query.q ?? "", 50, req.viewer?.member),
          counts = await ctx.kv.getMany<number>(tags.map((t) => "used:" + lower(t.name)));
        return { items: tags.map((tag, n) => ({ name: tag.name, uses: counts[n] ?? 0 })) };
      },
    },
    "GET /tags": {
      access: "member",
      handler(ctx, req) {
        return { entries: matches(ctx, req.query.q ?? "", 50, req.viewer?.member) };
      },
    },
    "PUT /tags/:name": {
      access: "moderator",
      async handler(ctx, req) {
        const tag = valid(req.body),
          name = lower(req.params.name),
          prior = portal.get(name);
        if (!ctx.config.enabled || !ctx.config.editableOnPortal || !req.viewer?.member)
          return { status: 403, body: { saved: false } };
        if (!tag || lower(tag.name) !== name || git.has(name) || (!prior && portal.size >= 1000))
          return { status: 400, body: { saved: false } };
        if (
          (prior && !visible(ctx, prior, req.viewer.member)) ||
          !visible(ctx, tag, req.viewer.member)
        )
          return { status: 403, body: { saved: false } };
        if (
          prior?.channel &&
          (!tag.channel ||
            !["same", "narrower"].includes(ctx.server.compareAudience(prior.channel, tag.channel)))
        )
          return { status: 403, body: { saved: false } };
        await ctx.kv.set("portal:" + name, tag);
        portal.set(name, tag);
        return { saved: true };
      },
    },
    "DELETE /tags/:name": {
      access: "moderator",
      async handler(ctx, req) {
        const name = lower(req.params.name),
          tag = portal.get(name);
        if (
          !ctx.config.enabled ||
          !ctx.config.editableOnPortal ||
          !tag ||
          !req.viewer?.member ||
          !visible(ctx, tag, req.viewer.member)
        )
          return { status: 403, body: { deleted: false } };
        await ctx.kv.delete("portal:" + name);
        portal.delete(name);
        return { deleted: true };
      },
    },
  }),
});
