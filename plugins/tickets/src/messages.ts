import type { Context, Message } from "@cicord/sdk";

/** Removes a bot-authored copy. Deleting needs discord.messages.manage (the optional
 * `managedMessages` feature); without it the copy is overwritten with neutral text, which
 * editing the bot's own message allows. */
export async function removeOwn(ctx: Context, m: Message | undefined, reason: string) {
  if (!m) return;
  if (ctx.features.enabled("managedMessages")) await m.delete(reason);
  else
    await m.edit({
      content: ctx.i18n.t("removedMessage"),
      embeds: [],
      components: [],
      allowedMentions: { users: false, roles: false, everyone: false },
    });
}
