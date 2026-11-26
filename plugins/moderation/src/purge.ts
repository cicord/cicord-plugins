import {
  command,
  type Context,
  type ComponentInteraction,
  type Channel,
  type Interaction,
  type User,
} from "@cicord/sdk";
import { recordCase, who } from "./moderation.ts";

type Preview = { actor: string; channel: string; ids: string[]; scanned: number; skipped: number };

// Stops repeated clicks before the KV read completes. KV expiry bounds abandoned previews.
const running = new Set<string>();

async function allowed(ctx: Context, user: string, channel: Channel | undefined) {
  if (!channel || channel.type === "dm") return false;
  const member = await ctx.server.member(user);
  return member?.permissionsIn(channel).includes("ManageMessages") ?? false;
}

export const purge = command({
  description: "Preview and confirm a filtered message purge",
  permissions: ["ManageMessages"],
  ephemeral: true,
  options: {
    count: {
      type: "integer",
      required: true,
      minValue: 1,
      maxValue: 1000,
      description: "Maximum number of recent messages to inspect",
    },
    user: { type: "user", description: "Only messages from this user" },
    contains: { type: "string", description: "Text to match (requires MessageContent)" },
    bots: { type: "boolean", description: "Filter by bot or human messages" },
    attachments: {
      type: "boolean",
      description: "Filter by attachment presence (requires MessageContent)",
    },
    after_message: { type: "string", description: "Only messages newer than this message ID" },
  },
  async run(ctx, it) {
    await previewPurge(ctx, it, it.options);
  },
});

export async function previewPurge(
  ctx: Context,
  it: Interaction,
  o: {
    count: number;
    user?: User;
    contains?: string;
    bots?: boolean;
    attachments?: boolean;
    after_message?: string;
  },
) {
  const channel = it.channel;
  if (!channel || !(await allowed(ctx, it.user.id, channel))) {
    await it.reply(ctx.i18n.t("purge.permission"));
    return;
  }

  if (o.count > ctx.config.purge.maxCount) {
    await it.reply(ctx.i18n.t("purge.limit", { count: ctx.config.purge.maxCount }));
    return;
  }
  if (o.after_message && !/^[1-9]\d{0,19}$/.test(o.after_message)) {
    await it.reply(ctx.i18n.t("purge.id"));
    return;
  }
  let ids: string[], skipped: number;
  try {
    ({ ids, skipped } = await channel.previewPurge({
      limit: o.count,
      ...(o.user ? { author: o.user.id } : {}),
      ...(o.contains !== undefined ? { contains: o.contains } : {}),
      ...(o.bots !== undefined ? { bots: o.bots } : {}),
      ...(o.attachments !== undefined ? { attachments: o.attachments } : {}),
      ...(o.after_message ? { after: o.after_message } : {}),
    }));
  } catch (error) {
    if (String(error).includes("MessageContent")) {
      await it.reply(ctx.i18n.t("purge.intent"));
      return;
    }
    throw error;
  }
  const scanned = ids.length + skipped;
  if (!ids.length) {
    await it.reply(ctx.i18n.t("purge.zero", { skipped: skipped }));
    return;
  }
  const key = String(await ctx.kv.increment("purge-seq"));
  const preview: Preview = { actor: it.user.id, channel: channel.id, ids, scanned, skipped };
  await ctx.kv.set(`purge:${key}`, preview, { ttlSeconds: 120 });
  await it.reply({
    content: ctx.i18n.t("purge.preview", {
      count: ids.length,
      channel: channel.mention,
      scanned: scanned,
      skipped: skipped,
    }),
    components: [
      {
        type: "row",
        components: [
          {
            type: "button",
            style: "danger",
            id: `purge-confirm:${key}`,
            label: ctx.i18n.t("purge.confirm"),
          },
          {
            type: "button",
            style: "secondary",
            id: `purge-cancel:${key}`,
            label: ctx.i18n.t("purge.cancel"),
          },
        ],
      },
    ],
  });
}

export async function finishPurge(ctx: Context, it: ComponentInteraction) {
  const [action, id] = it.componentId.split(":");
  if (!id || running.has(id)) {
    await it.reply({ content: ctx.i18n.t("purge.busy"), ephemeral: true });
    return;
  }
  running.add(id);
  const key = `purge:${id}`;
  try {
    const preview = await ctx.kv.get<Preview>(key);
    if (
      !preview ||
      preview.actor !== it.user.id ||
      preview.channel !== it.channel?.id ||
      !(await allowed(ctx, it.user.id, it.channel))
    ) {
      await it.reply({ content: ctx.i18n.t("purge.missing"), ephemeral: true });
      return;
    }
    if (action === "purge-cancel") {
      await ctx.kv.delete(key);
      await it.update({ content: ctx.i18n.t("purge.cancelled"), components: [] });
      return;
    }
    // Consume the confirmation before the first external effect. The exact frozen IDs
    // bound every batch; a second click can never clear a new page of messages.
    await ctx.kv.delete(key);
    const channel = ctx.server.channel({ id: preview.channel });
    let deleted = 0,
      failed = false;
    try {
      for (let n = 0; n < preview.ids.length; n += 100)
        deleted += await channel.bulkDelete(
          preview.ids.slice(n, n + 100),
          `Purge by ${it.user.id}`,
        );
    } catch {
      failed = true;
    }
    // Every deletion leaves a case, including the batches done before a failure.
    if (deleted > 0 || !failed)
      await recordCase(ctx, {
        action: "purge",
        member: null,
        moderator: who(it.user),
        reason: ctx.i18n.t(failed ? "purge.caseReasonPartial" : "purge.caseReason", {
          count: deleted,
          channel: channel.mention,
          skipped: preview.skipped,
        }),
      });
    if (failed) {
      await it.update({
        content: ctx.i18n.t("purge.partial", { count: deleted }),
        components: [],
      });
      return;
    }
    await it.update({
      content: ctx.i18n.t("purge.done", { count: deleted, skipped: preview.skipped }),
      components: [],
    });
  } finally {
    running.delete(id);
  }
}
