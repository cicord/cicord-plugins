# Guard

Guard monitors Discord messages and member joins. The default mode records findings for staff. Enable `mode: enforce` and the grants for the configured response after tuning the rules on your server. Guard ignores the installation’s bot, configured exempt users/bots, staff, roles and channels.

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
  count: 3
  seconds: 30
  action: { type: quarantine }
newAccounts:
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

The message-content and server-member intents support link, mention, attachment, duplicate and account-age checks. AutoMod execution events can independently trigger a response. The duplicates rule compares the live contents of matching messages across channels before recording a violation. In enforcement mode it removes those matching messages and applies the configured action. Discord invite lookups need the optional invite grant to distinguish another server’s invites. Domain suffixes match on label boundaries. Adding a domain on the staff portal blocks it in either mode.

| Optional feature         | Grant and behavior                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message removal          | `discord.messages.manage` deletes confirmed offending messages.                                                                                                                                                                                                              |
| Standalone response      | `discord.members.moderate` permits configured member actions. `discord.roles.assign` adds a locally configured quarantine role. Configure that role’s restrictions in server YAML. Direct warnings appear in the staff violation history.                                    |
| Moderation integration   | Grant `plugins.call:moderation.sanction` when moderation is installed. Denied or uncertain calls surface the error. Grant `plugins.query:moderation.standing` to skip redundant quarantine.                                                                                  |
| Verification integration | `plugins.query:verification.status` exempts verified members from newcomer checks. The failed event counts unique members within the raid window.                                                                                                                            |
| Images                   | `media.analyze` compares perceptual hashes. Staff can select **Block image** on a message or edit hashes through the staff portal.                                                                                                                                           |
| Feeds                    | `http.fetch` downloads lines or JSON arrays every four hours. Put each HTTPS feed host in the instance network allowlist. A failed refresh keeps the previous set until its one-day expiry.                                                                                  |
| Raid measures            | `server.overlays` applies verification, slowmode and channel locks. `server.incident` optionally pauses invites until the earlier of the configured pause and the overlay deadline. Ending a raid removes its overlay. The guild incident pause expires at its own deadline. |

Staff use `/lockdown on` and `/lockdown off`. The alert also permits an extension and review of up to 25 recent arrivals. From an enforced incident, staff select confirmed accounts and see their IDs again before a separate, one-minute ban confirmation. The monitor records join surges and quiet expiry without modifying server settings.

Moderator routes serve `GET /violations`, `GET /raids`, and `GET /blocklist`. Send `{kind: "domain" | "hash", action: "add" | "remove", value: string}` to `POST /blocklist`. Set `locale: fr` for French staff and interaction messages.

## Data retention

Message history stores IDs, counters and a comparison hint for up to ten minutes. Guard reads Discord content for exact comparisons and stores no message text or attachment bytes. Each member retains up to 100 violations for 30 days. Raid history contains aggregate counts for 30 days. Join-window identities expire with the window, the review list expires after one day, and a staff confirmation expires after one minute. Export and erasure include the member’s entries in shared lists. Operator-maintained domain and image hashes persist until removed.

Guard requests permanent bans for ban rules and staff-confirmed raid bans. Timeout and quarantine rules forward their configured duration to moderation.
