# Anti-nuke

This 0.2 release monitors administrative changes. It alerts staff and publishes an incident for audit-log. The manifest grants no member sanctions, role changes, overlays, or server synchronization. An enforcement release requires separate validation with real Discord audit timing and concurrent moderators.

```yaml
mode: monitor
staffChannel: staff
notifyOwner: false
notifyWebhook: false
locale: en
windowSeconds: 60
thresholds:
  channelDelete: 3
  roleDelete: 2
  kick: 5
trusted:
  users: []
  bots: []
trustAdmins: false
protectedRoles: [moderator]
```

A channel or role deletion opens a 30-second correlation window. Audit entries must match the action and target. The monitor accepts a confirmed human or bot only when the evidence is timely, has an actor and is unambiguous. The reason string has no bearing on attribution. Missing, conflicting, late and merged evidence yields an unknown-actor alert. A late audit entry can annotate a previous alert for manual review. A confirmed Cicord operation is ignored. A probable Cicord operation prompts staff to review the bot token and operation journal. Audit-only administrative triggers use Discord’s actor and target fields. Each actor’s counter is separate. A guard raid can temporarily lower thresholds.

Staff can inspect `/antinuke status` and the moderator portal’s paged `GET /incidents` route. The status reports the bot’s audit-log permission, configured protected roles and the host protection snapshot. It calls out disabled restoration, missing deletion protection, paused reconciliation and resources outside the declared structure. An unavailable host snapshot is reported as unverified. Setting `trustedFromCommand: true` lets the server owner use `/antinuke trust add|remove`. Command trust expires after 30 days. Permanent trust belongs in YAML. The server owner is always trusted.

Grant `discord.dm.send` and enable `notifyOwner` for owner notifications. For a staff webhook, provide an instance secret named `WEBHOOK_URL` bound to discord.com, grant `http.fetch`, and enable `notifyWebhook`. These remote notifications contain an incident summary. Dashboard and channel details go to staff. Set `locale: fr` for French staff messages.

## Restoration and retention

Self-healing can recreate the declared structure. A recreated channel has a new ID and an empty message history. Panels, tickets and jobs that referenced the old ID need review. The database contains key-to-ID mappings, tasks, ticket data and encrypted secrets. Follow the operator backup and secrets procedure alongside the Git repository.

Correlation evidence expires after ten minutes, sliding counters after the configured window and incident records after 30 days. Staff Discord messages with an attributed actor are redacted by the plugin’s erasure hook. The hook also removes that member’s trust, counter and evidence records, preserving evidence for other members. The provider publishes a confirmed actor ID only for confirmed observations. Alerts with uncertain attribution omit the actor ID.
