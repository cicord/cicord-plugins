import { command, definePlugin } from "@cicord/sdk";

function render(template: string, vars: { member: string; server: string }): string {
  return template.replaceAll("{member}", vars.member).replaceAll("{server}", vars.server);
}

export default definePlugin({
  events: {
    async memberJoin(ctx, member) {
      const { channel, message, autoRole, dmOnboarding } = ctx.config;

      await ctx.server
        .channel(channel)
        .send(render(message, { member: member.mention, server: ctx.server.name }));

      if (autoRole && !member.hasRole(autoRole)) {
        await member.addRole(autoRole, "welcome: default role");
      }

      if (dmOnboarding) {
        const url = await ctx.portal.link("/onboarding", { member });
        await member.send({
          content: `Welcome to **${ctx.server.name}**! Pick your roles in 30 seconds:`,
          components: [{ type: "row", components: [{ type: "link", label: "Get started", url }] }],
        });
      }

      const total = await ctx.kv.increment("stats:joined");
      ctx.log.info("member welcomed", { member: member.id, total });
    },
  },

  commands: {
    "welcome-preview": command({
      description: "Preview the welcome message",
      ephemeral: true,
      permissions: ["ManageServer"],
      options: {
        member: { type: "user", description: "Member to greet (defaults to you)" },
      },
      async run(ctx, interaction) {
        const target = interaction.options.member ?? interaction.user;
        await interaction.reply({
          content: render(ctx.config.message, { member: target.mention, server: ctx.server.name }),
          ephemeral: true,
        });
      },
    }),

    "welcome-stats": command({
      description: "How many members were welcomed",
      ephemeral: true,
      async run(ctx, interaction) {
        const total = (await ctx.kv.get<number>("stats:joined")) ?? 0;
        await interaction.reply(`${total} ${total === 1 ? "member" : "members"} welcomed.`);
      },
    }),
  },
});
