# Moderation

Configure a private staff log channel with `logChannel`. The 0.2 plugin requires the Cicord 0.2 moderation API and task scheduler. Review the added grants before upgrading. Existing cases are indexed in batches on startup and can be read while migration progresses.

- `/ban` accepts a user and an optional duration in minutes. A permanent ban supersedes an earlier temporary ban. Expiration checks the active case and the recorded Discord ban before lifting it. `/unban` records a manual release.
- `/purge` previews recent messages in the current channel. Only the moderator who requested the preview can confirm it, within two minutes. Confirmation applies only to the selected message IDs. Text and attachment filters require the plugin's Message Content intent. The default manifest does not request it.
- `/case view`, `/case reason`, `/case void`, `/history` and `/note` manage case records. Voiding a warning also removes it from the active warning count. Voiding a case does not lift a Discord sanction.
- `GET /members/:id` exposes the caller's case history, excluding staff notes. Moderators can review member history including notes. `GET /cases` is staff-only and accepts status, action, moderator and cursor parameters. The plugin sends no private note content to its webhook or event subscribers.

Temporary ban tasks carry an opaque case reference. Erasure keeps the minimum target information in the active sanction until release and migrates older pending timers. The plugin requires `discord.auditlog.read`, the Server Moderation intent and the bot’s View Audit Log permission. It binds a ban to a confirmed Discord audit entry from this bot and plugin installation. Delayed evidence is retried. Long bans are checked weekly so the plugin retains verified continuity across Discord’s audit retention window. An ambiguous history, a gap of 44 days, or a scan exceeding 500 entries for either action leaves the ban in place for staff review. A release case number is saved before lifting the ban, so a retry after an interruption uses the same record. Discord exposes separate audit-read and remove-ban requests, so simultaneous external changes can still race the last check.

Case events use a stable delivery key per case and contract version. The staff log uses an enforced Discord nonce. Recovery checks up to 100 recent messages for the same bot and delivery marker. If that history no longer reaches the send attempt after two minutes, the task records a failure for staff review. Log messages are retracted on case erasure or at the end of one-year case retention. Optional webhooks receive only the case number and action, with at most one delivery attempt. Staff notes stay in case storage. Attachment evidence can appear in the staff log only when the recorded source has an equal or wider audience.

Warnings expire according to `warningDays`; the case history is persisted separately in the instance's database.

The complete configuration and granted permissions are in [config.schema.json](config.schema.json) and [plugin.yaml](plugin.yaml).

## Quarantine and emergency locks

Grant `discord.roles.assign` to enable quarantine and configure an assignable
`quarantineRole` with the restrictions your server requires. Give the bot a higher
role than the quarantine role and its targets. `/quarantine user reason duration`
accepts 1–10080 minutes and defaults to seven days. `/release user` ends a
quarantine early. A newer quarantine supersedes its earlier expiration task.

Grant `server.overlays` to suspend a holder listed in YAML. The plugin checks
ownership before changing any roles. Cicord restores declared holders from the
current revision. For other roles, it retains the assignments present at
quarantine and incorporates additions and removals observed during restriction.
Discord emits membership changes only when an assignment actually changes.
`/lock` and `/slowmode` apply a temporary overlay to the named managed channel.
An administrator can lift each lock independently on the server Plan page.

## Appeals

Configure Discord OAuth and the forkable community portal at the runtime's
public URL. Install a portal version with the `/appeals` page and grant
`portal.links`. A sanction DM includes a link to one case, valid for seven
days. The recipient authenticates with Discord even after a ban. The staff
queue is at `/appeals/staff`. The moderator's decision records whether the
original sanction could still be lifted. A newer ban, timeout, or quarantine
must remain active. A kick that already removed the member has no reversible
sanction. Expired links can request a fresh DM for up to 30 days. The configured
cooldown defaults to seven days. A recipient who blocks DMs needs a staff-assisted
delivery channel.

```yaml
quarantineRole: quarantine
appeals:
  enabled: true
  via: portal
  channel: mod-appeals
  cooldownDays: 7
sanction:
  allowStaffTargets:
    - { bot: security, instance: anti-nuke }
```

Use `via: ticket` and grant `plugins.call:tickets.open` to open a ticket with the
appeal statement. An unavailable ticket provider leaves the appeal pending.
The appeal route derives its case and owner from the signed session. A
moderator never needs to share their own staff session with the appellant.

## Interoperability and privacy

The `standing` query returns the active-warning count, latest public case number,
and quarantine status. `cases` checks the original user's authority and returns
a member-safe projection to the subject. Staff can also read private notes and
evidence in the staff portal. `sanction` accepts warn, timeout, kick, ban,
quarantine, and release. Callers need the individual action grant and a stable
idempotency key. Only configured, trusted installations may act on staff targets.
The owner and users at or above the bot's hierarchy are protected.

The case event has versioned schemas in `contracts/`. `caseUpdated` describes
changes without disclosing note text. `appeal` publishes only the case number,
subject and status. Staff statistics are available at `GET /stats/moderators`.
Use an instance secret binding for `WEBHOOK_URL` when forwarding notifications
to Slack or Discord. Move existing webhook URLs out of repository configuration
and rotate those credentials after migration.

Case history is retained for one year. Privacy erasure removes private notes,
appeals, warnings and member indexes, redacts free text and evidence, and
pseudonymizes historical identities. A current sanction retains the minimum
target and generation needed for safe enforcement and release. Discord's own
audit logs and copies already received by external webhooks follow their
operators' retention policies.

Discord commands, member notices and moderator replies support English and French.
Set the instance locale to `fr` to select French throughout the server, or leave
it unset to follow the interaction and server locale. To exclude an assignment
that was already absent from Discord during quarantine, authorized staff can use
`DELETE /quarantines/:id/roles/:role` with the member and role IDs before release.

Case and membership notices posted by this version retain a Discord reference until
erasure or their scheduled one-year withdrawal. Erasure removes their staff-channel
copies, revokes case links and leaves a retry receipt if Discord is unavailable.
Pre-upgrade notices without a reference or delivery marker may need manual
removal. New external webhook notifications contain only the case number and
action. Older messages already delivered to another service remain under that
service's retention policy.

On upgrade, startup enqueues a durable migration when the stored schema is older than version 3. Each delivery processes up to 25 legacy cases. Restarting resumes from the saved cursor, and a repeated delivery preserves staff edits and moderator totals.
