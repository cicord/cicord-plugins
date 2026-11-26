import type { Context, TextChannel } from "@cicord/sdk";
import {
  allTickets,
  closeTicket,
  finishClose,
  getTicket,
  lastActivityKey,
  saveTicket,
  ticketChannel,
  ticketType,
  ticketKey,
  authorKey,
  activityKey,
  type Ticket,
} from "./tickets.ts";
import { purgeArchive, reconcileCopy } from "./transcript.ts";

export async function maintenance(ctx: Context) {
  for (const t of await allTickets(ctx)) {
    try {
      if (t.status === "closed") {
        if (t.pendingClose) await finishClose(ctx, t);
        if (t.logCopy || t.logDelivery) await reconcileCopy(ctx, t);
        if (t.expiresAt && Date.now() >= t.expiresAt) {
          for (const c of t.directCopies ?? []) await ctx.server.retractDM(c.messageId);
          delete t.directCopies;
          delete t.copies;
          delete t.notices;
          await purgeArchive(ctx, t);
          await saveTicket(ctx, t);
        }
        if (
          t.closedAt &&
          Date.now() - Date.parse(t.closedAt) >=
            Math.max(ctx.config.recordRetentionDays, ctx.config.transcriptRetentionDays) * 86400000
        ) {
          await ctx.kv.delete(authorKey(t.author.id, t.number));
          await ctx.kv.delete(lastActivityKey(t.number));
          await ctx.kv.delete(activityKey(t.number));
          await ctx.kv.delete(ticketKey(t.number));
        }
        continue;
      }
      const last = (await ctx.kv.get<string>(lastActivityKey(t.number))) ?? t.createdAt;
      const channel = ticketChannel(ctx, t);
      if (!channel) continue;
      const type = ticketType(ctx, t.type);
      if (
        !t.reminded &&
        !t.firstResponseAt &&
        ctx.config.firstResponseMinutes > 0 &&
        Date.now() - Date.parse(t.createdAt) >= ctx.config.firstResponseMinutes * 60000
      ) {
        const roles = type?.staffRoles.map((k) => ctx.server.role(k)) ?? [];
        const marker = "⏱ " + t.createdAt;
        if (!(await sentNotice(ctx, channel, marker)))
          await channel.send({
            embeds: [{ footer: { text: marker }, description: ctx.i18n.t("responseRequested") }],
            content: ctx.i18n.t("responseOverdue", {
              staff: roles.map((r) => r.mention).join(" "),
            }),
            allowedMentions: { roles: roles.map((r) => r.id), users: false, everyone: false },
          });
        t.reminded = true;
        await saveTicket(ctx, t);
      }
      if (ctx.config.inactivityHours <= 0) continue;
      const due = Date.parse(last) + ctx.config.inactivityHours * 3600000;
      if (!t.warningAt && Date.now() >= due - 3600000) {
        const marker = "⏳ " + last;
        const warning =
          (await sentNotice(ctx, channel, marker)) ??
          (await channel.send({
            content: ctx.i18n.t("warning"),
            embeds: [{ footer: { text: marker }, description: ctx.i18n.t("warningTitle") }],
          }));
        t.warningAt = warning.createdAt.getTime();
        await saveTicket(ctx, t);
      } else if (t.warningAt && Date.now() >= Math.max(due, t.warningAt + 3600000)) {
        const current = await getTicket(ctx, t.number);
        if (current?.status === "open" && current.warningAt === t.warningAt)
          await closeTicket(
            ctx,
            current,
            { id: ctx.bot.user.id, displayName: ctx.bot.user.displayName },
            ctx.i18n.t("inactivity"),
          );
      }
    } catch (error) {
      ctx.log.warn("Ticket maintenance deferred", { ticket: t.id, error: String(error) });
    }
  }
}

export async function receivedReply(
  ctx: Context,
  t: Ticket,
  at: Date,
  staff: boolean,
  relay = false,
) {
  const changed = relay || t.warningAt !== undefined || (staff && !t.firstResponseAt);
  if (staff) t.firstResponseAt ??= at.toISOString();
  delete t.warningAt;
  if (changed) await saveTicket(ctx, t);
  await ctx.kv.set(lastActivityKey(t.number), at.toISOString());
}

async function sentNotice(ctx: Context, channel: TextChannel, marker: string) {
  return (await channel.messages({ limit: 100 })).find(
    (m) => m.author.id === ctx.bot.user.id && m.embeds.some((e) => e.footer?.text === marker),
  );
}
