# Audit log

Version 0.2.0 posts server observations to a private staff channel. It runs independently of moderation, polls and other event publishers. English and French messages follow the installation or server locale.

## Configure

```yaml
config:
  channel: staff-log        # private reference audience and default destination
  channels:
    structure: staff-log
    security: incident-log # equal or narrower than staff-log
    voice: staff-log
  events:
    messageEdits: false
    messageDeletes: true
    roles: true             # member roles and role structure
    automod: true
    plugins: true
  cacheContent: false
  retentionDays: 30
  batchSeconds: 10
  maxPerBatch: 60
```

The minimal configuration is `{channel: staff-log}`. Declare view and message-history overwrites restricting this channel to the staff audience. `{enabled: false}` disables observation without requiring a destination. The scheduled cleanup can still retract earlier copies. The plugin records joins, leaves, nicknames, role membership, messages, channels, roles, threads, expressions, server settings, invitations, bans, voice changes and AutoMod. Event switches and category destinations are defined in the configuration schema. Invite codes, audit reasons, AutoMod matched text and arbitrary partner payloads are excluded from log lines.

Keep the required grants visible in the bot manifest. `discord.auditlog.read` and the Discord **View Audit Log** permission supply actor evidence. `discord.messages.read` is needed to identify the bot’s earlier sends and edit its own copies. `discord.messages.send`, `discord.channels.read`, `storage.kv`, `scheduler` and `portal.routes` provide delivery, access checks, persistence, deadlines and the staff routes. Required intents are listed in the manifest.

Optional `events.subscribe` enables declared moderation, polls, levels, guard, anti-nuke, verification, tickets, giveaways, economy and member-roles topics. Moderation cases and closed polls subscribe to v2. The plugin accepts bounded v1-shaped payloads and uses v2 voter counts when available. A replay carries a stable delivery ID that deduplicates the stored row and log line. A missing partner leaves its category quiet.

Optional `storage.index` enables full-text search. If it is unavailable, the routes filter one page of KV observations at a time. The `cacheContent` feature requests the privileged **Message Content** intent only when enabled in configuration. Without that feature, the plugin stores no message bodies. The admin status names unavailable features, unsafe log destinations and indexing failures.

## Attribution and delivery

Gateway structure notifications describe what changed. A distinct authoritative audit observation identifies the actor, changed permissions and trusted Cicord revision when available. A human can enter a Cicord-looking reason. Only the host’s confirmed operation attribution earns the Cicord label.

Discord’s ordinary message-deletion audit entry identifies the actor, author, channel and count. It usually omits a message ID. For an unmerged, unambiguous entry, the log names the actor and describes the confirmed audit fact at that granularity. A coalesced counter yields probable attribution. Overlapping moderators or multiple compatible pending deletions do not select a winner. An unresolved deletion waits thirty seconds from gateway receipt and then reports an unknown actor. An aggregate fact may be logged without linking it to a particular message. The plugin reads bounded REST history after 3, 8 and 18 seconds while a deletion remains unresolved, so a count update can be observed without a second gateway notification. Missing permission, gateway delay or Discord rate limiting can delay delivery. The plugin never sanctions anyone.

Batches share a durable reservation and a Discord message marker. A retry searches bot-authored messages for that marker before resending. Discord nonces also protect short retries. A busy destination is searched in pages with a persisted cursor. Retention or member erasure edits only matching lines in a shared copy and clears an empty embed. Version 0.1 stored pre-rendered pending lines without source permissions or identifiable subjects. The resumable migration drops those unpublished lines in pages of thirty and retains unrelated data.

## Staff search and privacy

`GET /search` and `GET /export` have moderator access, return JSON and accept `q`, `member`, `channel`, `category` and `cursor`. Every result rechecks the viewer’s access to the current source channels and private log. An export always scans successive pages and applies a literal text filter when supplied. A request without full-text search reads up to fifty stored observations and returns a cursor. A full-text search uses up to fifty index hits and returns only observations the viewer may read. A page can be empty with a continuation cursor. Index snippets are never returned directly.

The cache keeps an optional 2,000-character excerpt for up to seven days from observation, bounded by the shorter configured retention. Cross-channel Discord log messages contain metadata. An excerpt can appear inside its own source channel or in the staff portal after a fresh access check. This avoids an enduring text copy in a different Discord channel whose permissions could widen later. Unknown, public or wider category destinations disable delivery. New permissions do not grant access to an unrelated source.

Metadata remains searchable for 1–30 days. The cleanup schedule removes expired rows, search documents and bot-authored copies. It preserves a retryable cleanup record if Discord or the index is unavailable. Member export returns the subject’s observation categories, times and evidence relationships without disclosing another member’s private text. Member erasure anonymizes shared observations and clears their free text while preserving other members’ records. It removes the member’s remaining observations, attribution buffers, pending tasks, search entries and the corresponding lines in tracked Discord copies. Historical 0.1 posts did not store Discord message IDs and require operator cleanup.

## Verify

Run `scripts/check-plugin.sh plugins/audit-log` with the matching minimum engine and SDK. The simulator test exercises normal message-deletion events, the REST-only merged counter and the unknown deadline. The unit tests cover reversed arrival order, competing moderators, access revocation, shared-copy erasure and interrupted sends. For the restart migration run `CICORD_SOURCE=/path/to/cicord node plugins/audit-log/test/persistence/run.mjs` and supply `CICORD_TEST_POSTGRES_URL` for PostgreSQL. The tests use a temporary SQLite database and a private PostgreSQL schema. Validate Discord’s real audit-entry presence, ordering and latency on a test guild before publication.
