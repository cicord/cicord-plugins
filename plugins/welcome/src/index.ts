import { command, definePlugin, type Context, type Member, type MessagePayload } from "@cicord/sdk";
import type { Inviter } from "./contracts.ts";

type Receipt = {
  joined: number;
  number: number;
  variant?: number;
  message?: string;
  role?: boolean;
  dm?: boolean;
};
const key = (id: string) => "greet:" + id;

async function content(ctx: Context, member: string, index: number, variant = 0) {
  let template = ctx.config.variants?.length
    ? ctx.config.variants[variant % ctx.config.variants.length]
    : ctx.config.message;
  if (ctx.config.templateFile && ctx.features.enabled("templates"))
    template = await ctx.files.read(ctx.config.templateFile);
  if (!template || template === "Welcome {member} to {server}!")
    template = ctx.i18n.t("greeting", { member, server: ctx.server.name });
  return template
    .replaceAll("{member}", member)
    .replaceAll("{server}", ctx.server.name)
    .replaceAll("{number}", String(index))
    .slice(0, 1850);
}
async function greet(ctx: Context, m: Member) {
  if (!ctx.config.enabled || !ctx.config.channel || m.user.bot) return;
  const joined = m.joinedAt.getTime(),
    k = key(m.id);
  let receipt = await ctx.kv.get<Receipt>(k);
  if (!receipt || receipt.joined !== joined) {
    const counter = await ctx.kv.getEntry("stats:joined"),
      old = await ctx.kv.getEntry(k);
    if (old && (old.value as Receipt).joined === joined) receipt = old.value as Receipt;
    else {
      receipt = {
        joined,
        variant: Math.floor(Math.random() * Math.max(1, ctx.config.variants.length)),
        number: Number(counter?.value ?? 0) + 1,
      };
      if (
        !(
          await ctx.kv
            .atomic()
            .check(k, old?.version ?? null)
            .check("stats:joined", counter?.version ?? null)
            .set(k, receipt)
            .set("stats:joined", receipt.number)
            .commit()
        ).ok
      )
        return greet(ctx, m);
    }
  }
  if (!receipt.message) {
    let text = await content(ctx, m.mention, receipt.number, receipt.variant);
    if (
      ctx.config.showInviter &&
      ctx.features.enabled("inviter") &&
      ctx.plugins.has("invite-tracker")
    ) {
      const inviter = (await ctx.plugins.query("invite-tracker", "inviterOf", {
        userId: m.id,
      })) as Inviter;
      if (inviter.inviterId)
        text += "\n" + ctx.i18n.t("inviter", { member: `<@${inviter.inviterId}>` });
    }
    const payload: MessagePayload = {
      content: text,
      allowedMentions: { users: [m.id], everyone: false, roles: false },
      nonce: "w" + m.id.slice(-12) + joined.toString(36),
      enforceNonce: true,
    };
    if (ctx.config.card && ctx.features.enabled("cards")) {
      const image = await ctx.render.image({
        width: 700,
        height: 220,
        background: { asset: "background.png" },
        layers: [
          ...(m.user.avatarUrl
            ? [
                {
                  type: "image" as const,
                  x: 26,
                  y: 32,
                  width: 156,
                  height: 156,
                  source: { url: m.user.avatarUrl },
                  mask: "circle" as const,
                },
              ]
            : []),
          {
            type: "text",
            x: 205,
            y: 60,
            text: m.displayName,
            size: 38,
            color: "#ffffff",
            maxWidth: 475,
          },
          {
            type: "text",
            x: 205,
            y: 132,
            text: ctx.i18n.t("number", { number: receipt.number }),
            size: 23,
            color: "#bac8ed",
            maxWidth: 460,
          },
        ],
      });
      payload.files = [{ name: "welcome.png", ...image }];
      payload.embeds = [{ image: { url: "attachment://welcome.png" } }];
    }
    receipt.message = (await ctx.server.channel(ctx.config.channel).send(payload)).id;
    await ctx.kv.set(k, receipt);
  }
  if (!receipt.role && ctx.config.autoRole && ctx.features.enabled("defaultRole")) {
    if (!m.hasRole(ctx.config.autoRole))
      await m.addRole(ctx.config.autoRole, "Welcome default role");
    receipt.role = true;
    await ctx.kv.set(k, receipt);
  }
  if (!receipt.dm && ctx.config.dmOnboarding && ctx.features.enabled("onboarding")) {
    const url = await ctx.portal.link("/onboarding", { member: m });
    await m.send({
      content: ctx.i18n.t("dm", { server: ctx.server.name }),
      nonce: "d" + m.id.slice(-12) + joined.toString(36),
      enforceNonce: true,
      components: [
        { type: "row", components: [{ type: "link", label: ctx.i18n.t("start"), url }] },
      ],
    });
    receipt.dm = true;
    await ctx.kv.set(k, receipt);
  }
}
export default definePlugin({
  async onStart(ctx) {
    await ctx.kv.set("meta:schema", 1);
  },
  events: {
    async memberJoin(ctx, m) {
      if (ctx.config.trigger === "join") await greet(ctx, m);
    },
    async memberUpdate(ctx, m, previous) {
      if (
        ctx.config.trigger === "onboarded" &&
        m.flags.includes("completedOnboarding") &&
        !previous?.flags.includes("completedOnboarding")
      )
        await greet(ctx, m);
    },
    async memberLeave(ctx, m) {
      await ctx.kv.delete(key(m.id));
      if (ctx.config.enabled && ctx.config.channel && ctx.config.leaveMessage)
        await ctx.server
          .channel(ctx.config.channel)
          .send({
            content: ctx.config.leaveMessage
              .replaceAll("{member}", m.mention)
              .replaceAll("{server}", ctx.server.name),
            allowedMentions: { users: false, roles: false, everyone: false },
          });
    },
  },
  subscriptions: {
    "verification.passed": async (ctx, p) => {
      if (ctx.config.trigger !== "verified" || !ctx.features.enabled("verified")) return;
      const userId = (p as { userId: string }).userId,
        m = await ctx.server.member(userId);
      if (m) await greet(ctx, m);
    },
  },
  commands: {
    "welcome-preview": command({
      description: "Preview the welcome message",
      ephemeral: true,
      permissions: ["ManageServer"],
      options: { member: { type: "user", description: "Member to greet (defaults to you)" } },
      async run(ctx, i) {
        await i.reply({
          content: await content(ctx, (i.options.member ?? i.user).mention, 0),
          ephemeral: true,
        });
      },
    }),
    "welcome-stats": command({
      description: "How many members were welcomed",
      ephemeral: true,
      async run(ctx, i) {
        await i.reply(
          ctx.i18n.t("stats", { total: (await ctx.kv.get<number>("stats:joined")) ?? 0 }),
        );
      },
    }),
  },
  privacy: {
    async export(ctx, id) {
      return (await ctx.kv.get(key(id))) ?? {};
    },
    async erase(ctx, id) {
      const found = await ctx.kv.get(key(id));
      await ctx.kv.delete(key(id));
      return { erased: found ? 1 : 0 };
    },
  },
});
