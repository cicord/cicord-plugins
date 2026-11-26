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
import { search, valid, visible } from "./catalog.ts";
import { PORTAL_LIMIT, loadCatalog, lower, portalKey, readFileTags } from "./store.ts";

const quiet = { users: false, roles: false, everyone: false };
function pick(ctx: Context, tags: Tag[], q: string, n: number, viewer?: Member, destination?: Channel) {
  return search(
    tags.filter((t) => visible(ctx, t, viewer, destination)),
    q,
    Math.min(50, Math.max(n, 1)),
  );
}
async function matches(ctx: Context, q: string, n: number, viewer?: Member, destination?: Channel) {
  if (!ctx.config.enabled) return [];
  return pick(ctx, (await loadCatalog(ctx)).all, q, n, viewer, destination);
}
async function exact(ctx: Context, name: string, it: Interaction) {
  return (await matches(ctx, name, 25, it.member, it.channel)).find((t) =>
    [t.name, ...t.aliases].some((a) => lower(a) === lower(name)),
  );
}
async function send(ctx: Context, it: Interaction, name: string, userId?: string) {
  const tag = await exact(ctx, name, it);
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
    // Fail fast on an invalid revision. This is validation only: every handler rebuilds the
    // catalog from files and KV, so correctness never depends on startup state, and nothing
    // here writes (it stays valid if the host also runs it in a read-only realm).
    await readFileTags(ctx, true);
  },
  commands: {
    tag: command({
      description: "Share a saved answer",
      options: {
        name: {
          type: "string",
          description: "Tag name or alias",
          required: true,
          autocomplete: async (ctx, it, opt) =>
            (await matches(ctx, opt.value, 25, it.member, it.channel)).map((t) => ({
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
        const choices = await matches(ctx, "", 25, it.member, it.channel);
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
      const key = "debounce:" + msg.channel.id;
      // Skip the catalog read entirely while the channel is cooling down.
      if ((await ctx.kv.get(key)) !== undefined) return;
      const content = lower(msg.content);
      const tag = (await loadCatalog(ctx)).all.find(
        (t) =>
          visible(ctx, t, msg.member, msg.channel) &&
          t.keywords.some((word) => content.includes(lower(word))),
      );
      if (!tag) return;
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
        return { entries: await matches(ctx, input.query, input.limit, viewer ?? undefined) };
      },
    }),
  },
  routes: defineRoutes<Routes>({
    "GET /stats": {
      access: "moderator",
      async handler(ctx, req) {
        const tags = await matches(ctx, req.query.q ?? "", 50, req.viewer?.member),
          counts = await ctx.kv.getMany<number>(tags.map((t) => "used:" + lower(t.name)));
        return { items: tags.map((tag, n) => ({ name: tag.name, uses: counts[n] ?? 0 })) };
      },
    },
    "GET /tags": {
      access: "member",
      async handler(ctx, req) {
        const member = req.viewer?.member;
        if (!ctx.config.enabled) return { entries: [] };
        const catalog = await loadCatalog(ctx),
          entries = pick(ctx, catalog.all, req.query.q ?? "", 50, member);
        if (member?.access !== "admin" && member?.access !== "moderator") return { entries };
        const canEdit = ctx.config.editableOnPortal;
        return {
          canEdit,
          entries: entries.map((tag) => ({
            ...tag,
            editable: canEdit && !catalog.files.has(lower(tag.name)),
          })),
        };
      },
    },
    "PUT /tags/:name": {
      access: "moderator",
      async handler(ctx, req) {
        const tag = valid(req.body),
          name = lower(req.params.name);
        if (!ctx.config.enabled || !ctx.config.editableOnPortal || !req.viewer?.member)
          return { status: 403, body: { saved: false } };
        const key = portalKey(name),
          entry = await ctx.kv.getEntry<Tag>(key),
          prior = entry && valid(entry.value),
          catalog = await loadCatalog(ctx);
        if (
          !tag ||
          lower(tag.name) !== name ||
          catalog.files.has(name) ||
          (!prior && catalog.portal.size >= PORTAL_LIMIT)
        )
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
        // The audience checks above judged this exact prior version.
        const saved = await ctx.kv
          .atomic()
          .check(key, entry?.version ?? null)
          .set(key, tag)
          .commit();
        return saved.ok ? { saved: true } : { status: 409, body: { saved: false } };
      },
    },
    "DELETE /tags/:name": {
      access: "moderator",
      async handler(ctx, req) {
        const key = portalKey(req.params.name),
          entry = ctx.config.enabled ? await ctx.kv.getEntry<Tag>(key) : undefined,
          tag = entry && valid(entry.value);
        if (
          !ctx.config.enabled ||
          !ctx.config.editableOnPortal ||
          !tag ||
          !req.viewer?.member ||
          !visible(ctx, tag, req.viewer.member)
        )
          return { status: 403, body: { deleted: false } };
        const deleted = await ctx.kv.atomic().check(key, entry.version).delete(key).commit();
        return deleted.ok ? { deleted: true } : { status: 409, body: { deleted: false } };
      },
    },
  }),
});
