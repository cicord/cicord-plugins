# Moderation

Configure a private staff log channel with `logChannel`. The 0.2 plugin requires the Cicord 0.2 moderation API and task scheduler. Review the added grants before upgrading. Existing cases are indexed in batches on startup and can be read while migration progresses.

- `/ban` accepts a user and an optional duration in minutes. A permanent ban supersedes an earlier temporary ban. Expiration checks the active case and the recorded Discord ban before lifting it. `/unban` records a manual release.
- `/purge` previews recent messages in the current channel. Only the moderator who requested the preview can confirm it, within two minutes. Confirmation applies only to the selected message IDs. Text and attachment filters require the plugin's Message Content intent. The default manifest does not request it.
- `/case view`, `/case reason`, `/case void`, `/history` and `/note` manage case records. Voiding a warning also removes it from the active warning count. Voiding a case does not lift a Discord sanction.
- `GET /members/:id` exposes the caller's case history, excluding staff notes. Moderators can review member history including notes. `GET /cases` is staff-only and accepts status, action, moderator and cursor parameters. The plugin sends no private note content to its webhook or event subscribers.

Temporary ban tasks carry the case number and user ID. The plugin requires `discord.auditlog.read`, the Server Moderation intent and the bot’s View Audit Log permission. It binds a ban to a confirmed Discord audit entry from this bot and plugin installation. Delayed evidence is retried. Long bans are checked weekly so the plugin retains verified continuity across Discord’s audit retention window. An ambiguous history, a gap of 44 days, or a scan exceeding 500 entries for either action leaves the ban in place for staff review. A release case number is saved before lifting the ban, so a retry after an interruption uses the same record. Discord exposes separate audit-read and remove-ban requests, so simultaneous external changes can still race the last check.

Case events use a stable delivery key per case and contract version. The staff log uses an enforced Discord nonce. Recovery checks up to 100 recent messages for the same bot and delivery marker. If that history no longer reaches the send attempt after two minutes, the task records a failure for staff review. Optional webhooks receive at most one attempt. Staff notes stay in case storage. Attachment evidence can appear in the staff log only when the recorded source has an equal or wider audience.

Warnings expire according to `warningDays`; the case history is persisted separately in the instance's database.

The complete configuration and granted permissions are in [config.schema.json](config.schema.json) and [plugin.yaml](plugin.yaml).
