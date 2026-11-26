# Guard

Guard monitors Discord messages and member joins. The default mode records findings for staff. Enable `mode: enforce` and the grants for the configured response after tuning the rules on your server. Guard ignores every bot account, configured exempt users, staff, roles and channels. The project's own Cicord bots (`ctx.server.cicordBotIds`: this bot and every other bot of the project on this server) are exempt by id, even when Discord's bot flag is missing, and the sanction step refuses them whatever path led there.

```yaml
mode: monitor
locale: en
staffChannel: staff
links:
  mode: denylist
  domains: [blocked.example]
  blockInvites: true
  allowOwnInvites: true
duplicates:
  count: 4          # copies within the window
  seconds: 30
  minChannels: 2    # in at least two channels
  minLength: 20     # shorter messages count only when they carry a link
  action: { type: delete }
sanctionLimit:
  count: 5          # automatic sanctions per window, across all members
  seconds: 60
newAccounts:
  action: { type: delete }
  minAccountAgeDays: 7
  minMemberMinutes: 10
  restrict: [links, attachments]
raid:
  joins: 15
  seconds: 30
  calmMinutes: 15
  measures:
    verificationLevel: high
    pauseInvites: 2h
    slowmode: { channels: [general], seconds: 30 }
```

The message-content and server-member intents support link, mention, attachment, duplicate and account-age checks. AutoMod execution events can independently trigger a response. The duplicates rule compares the live contents of matching messages across channels before recording a violation. In enforcement mode it removes those matching messages and applies the configured action. Short chatter such as "gg" never counts as a duplicate, and the default action only removes the copies; configure `action: {type: quarantine}` to sanction. Newcomer restrictions remove the restricted message by default. With `allowOwnInvites`, Guard needs the optional invite grant to recognize this server's invites: without it, or when the invite list cannot be read, every Discord invite is blocked and the instance status says why.

In enforcement mode at most `sanctionLimit.count` automatic sanctions (warn, timeout, quarantine, kick, ban) run per window across all members. Further findings are recorded as `needs_review`, the instance status names the limit, and message removal continues. Staff-confirmed raid bans are not counted. Domain suffixes match on label boundaries. Adding a domain on the staff portal blocks it in either mode.

| Optional feature         | Grant and behavior                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message removal          | `discord.messages.manage` deletes confirmed offending messages.                                                                                                                                                                                                              |
| Standalone response      | `discord.members.moderate` permits configured member actions. `discord.roles.assign` adds a locally configured quarantine role. Configure that role’s restrictions in server YAML. Direct warnings appear in the staff violation history.                                    |
| Moderation integration   | Grant `plugins.call:moderation.sanction` when moderation is installed. Denied or uncertain calls surface the error. Grant `plugins.query:moderation.standing` to skip redundant quarantine.                                                                                  |
| Verification integration | `plugins.query:verification.status` exempts verified members from newcomer checks. The failed event counts unique members within the raid window.                                                                                                                            |
| Images                   | `media.analyze` compares perceptual hashes. Staff can select **Block image** on a message or edit hashes through the staff portal.                                                                                                                                           |
| Feeds                    | `http.fetch` downloads lines or JSON arrays every four hours. Put each HTTPS feed host in the instance network allowlist. A failed refresh keeps the previous set until its one-day expiry.                                                                                  |
| Raid measures            | `server.overlays` applies verification, slowmode and channel locks. `server.incident` optionally pauses invites until the earlier of the configured pause and the overlay deadline. Ending a raid removes its overlay and shortens the invite pause to a few seconds. |

Staff use `/lockdown on` and `/lockdown off`. A staff lockdown applies the raid measures even in `monitor` mode, stays in force until lifted or until the calm period ends, and is refused with an explanation when the `server.overlays` grant is missing. A continuing surge extends the raid without re-sending the overlay or the invite pause more than about once a minute. Lifting a raid, by the alert button, `/lockdown off` or the end of the calm period, resumes paused invites within a few seconds. Channel locks deny Send Messages (and in threads) to `@everyone` and neutralize every role or member allow of those permissions in the channel, except the bot's and the staff roles'. If the runtime refuses the overlay, the raid stays pending and the instance status says so. The alert also permits an extension and review of up to 25 recent arrivals. From an enforced incident, staff select confirmed accounts and see their IDs again before a separate, one-minute ban confirmation. The monitor records join surges and quiet expiry without modifying server settings.

Moderator routes serve `GET /violations`, `GET /raids`, and `GET /blocklist`. Send `{kind: "domain" | "hash", action: "add" | "remove", value: string}` to `POST /blocklist`. Set `locale: fr` for French staff and interaction messages.

## Data retention

Message history stores IDs, counters and a comparison hint for up to ten minutes. Guard reads Discord content for exact comparisons and stores no message text or attachment bytes. Each member retains up to 100 violations for 30 days. Raid history contains aggregate counts for 30 days. Join-window entries (one key per member) expire with the window, review-list entries expire after one day or when the raid ends, and a staff confirmation expires after one minute. Export and erasure include the member’s entries in shared lists. Operator-maintained domain and image hashes persist until removed.

Guard requests permanent bans for ban rules and staff-confirmed raid bans. Timeout and quarantine rules forward their configured duration to moderation.

During an enforcement pause, Guard records the raid immediately. The staff route
reports `phase: pending` and the outstanding measures. A durable task retries
failed measures until their original deadline, including after reload. The
controller registers a separate wakeup for expiry. The runtime Plan shows
whether a requested overlay has reached Discord. A failed lift remains
`closing` until the restriction is withdrawn.
