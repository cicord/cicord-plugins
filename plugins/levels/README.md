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

`/rank` returns a member's progress. `/top` accepts a limit and role filter. Managers can use `/xp give|remove|set|reset`. Configure permanent roles under `rewards` and choose `configured`, `stack` or `replace`. A dated `boosts` list multiplies message and voice XP between ISO timestamps. Configure the server’s AFK channel to exclude it from voice XP. Lone listeners and bots earn no voice XP.

On upgrade, `migrate-ranking` advances through at most 1,000 legacy keys per task. Live awards update XP and the ranking atomically. Migration verifies each source version before writing its score. Reads switch to the ranked index after the final batch. A season with an `id` and `end` timestamp archives scores and resets individual accounts transactionally. `GET /seasons/:id` returns its top 100. For a CSV import, grant `files.read` and set `importFile` to an instance file with a `userId,xp` header. Import and season batches can be replayed.

The plugin serves `memberLevel`, `leaderboard` and `grantXp`. Optional event publishing emits `levelUp`. The `polls.closed` v2 subscriber credits each voter once, uses `polls.voters` when truncated, and spreads large results over scheduled batches. Other event bonuses default to zero. The options in `spec.optional` identify their individual grants. Text rank cards are the default. Operators may explicitly enable image rendering after validating graphics demand with three target communities.

Set `enabled: false` to disable the instance. Exports and erasure cover XP, cached profiles, cooldowns, event receipts, reaction references and seasonal rankings. Reaction references expire after seven days and event receipts after thirty. Server administrators control season retention and role configuration.
