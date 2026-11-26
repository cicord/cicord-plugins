# Levels 0.2

Levels awards XP for eligible messages, reactions, optional voice participation and community events. The 0.1 configuration, level curve, public leaderboard and member route continue to work.

```yaml
xpPerMessage: 15
cooldownSeconds: 60
noXpRoles: [muted]
roleMultipliers: [{role: booster, factor: 1.5}]
voice: {xpPerMinute: 2, requireUndeafened: true, afkChannel: afk}
rewardMode: replace
bonuses: {approved: 10, starred: 2, attended: 5}
```

A level is crossed once per member: the plugin keeps the highest level each member has reached (`peak:<member>`). Removing a reaction, `/xp remove` or a reset lowers XP but not that mark, so re-adding the reaction or `/xp give` never repeats the `levelUp` event, the announcement, the role rewards or the economy level reward. A season reset is the exception: when the season archive resets a member, the mark restarts for that season, and the levels reached again are new facts (`levelUp:<member>:<level>:<season>`; before any season reset `levelUp:<member>:<level>`). Members who already had XP before 0.2 count as having reached their current level. After a crash, a redelivered message, reaction, event or `grantXp` call finishes the level-up: roles reconcile again, the event keeps its key, and the announcement is posted at most once. Role reward failures set the `role-rewards` status line.

`/rank` returns a member's progress. `/top` accepts a limit and role filter. Managers can use `/xp give|remove|set|reset`. Configure permanent roles under `rewards` and choose `configured`, `stack` or `replace`. A dated `boosts` list multiplies message and voice XP between ISO timestamps. The server’s AFK channel is excluded automatically. `voice.afkChannel` can exclude an additional configured channel. Lone listeners and bots earn no voice XP.

On upgrade, `migrate-ranking` advances through at most 1,000 legacy keys per task. Live awards update XP and the ranking atomically. Migration verifies each source version before writing its score. Reads switch to the ranked index after the final batch. A season with an `id` and `end` timestamp archives scores and resets individual accounts transactionally. `GET /seasons/:id` returns its top 100. For a CSV import, grant `files.read` and set `importFile` to an instance file with a `userId,xp` header. Malformed rows are skipped and the `import-csv` status line lists the first ten row numbers; an unreadable file is reported there too. Import and season batches can be replayed.

The plugin serves `memberLevel`, `leaderboard` and `grantXp`. Optional event publishing emits `levelUp`. The `polls.closed` v2 subscriber credits each voter once, uses `polls.voters` when truncated (passing the event's publisher, which polls checks), and spreads large results over scheduled batches. Without the `pollPages` grant a truncated poll credits nobody and sets the `poll-pages` status line instead of failing the delivery. Other event bonuses default to zero. The options in `spec.optional` identify their individual grants. Text rank cards are the default. Set `rankCard: {enabled: true, asset: dusk.png}` for the packaged background, or use `background` and `foreground` hex colors. Operators may explicitly enable image rendering after validating graphics demand with three target communities.

Set `enabled: false` to disable the instance. Exports and erasure cover XP, the level mark, cached profiles, cooldowns, event receipts, the reactions the member gave and seasonal rankings. Reactions other members gave to the member's messages are their data: an export leaves them out, and an erasure deletes them with the references to the erased member's messages. They read only the member's own keys and a per-member index (`by:<member>:`) of message and reaction references, never the whole store. References written before this index existed (0.1 and earlier 0.2 builds) are not indexed; they expire within seven days of the upgrade. Grant `discord.messages.read` to the optional `privacyCopies` feature for erasure of published announcements and the member’s row in a daily recap. Without it, erasure still removes the stored data, keeps only the reference to each published message so a later erasure can redact it, and sets the `privacy-copies` status line. Reaction references expire after seven days and event receipts after thirty. Server administrators control season retention and role configuration.

## Backend acceptance

The default plugin runtime test runs `/rank` through simulated Discord with 100,000 ranked members. It measures 30 completed command replies and reports local p95 latency. To exercise the published migration on both databases, set `CICORD_SOURCE` to the engine checkout and `CICORD_TEST_POSTGRES_URL` to a disposable PostgreSQL database, then run `node test/persistence/run.mjs` from this plugin. The test uses a dedicated schema, stops the VM after the first migration batch, reopens the store, awards fresh XP and checks all 2,001 scores and tie positions.
