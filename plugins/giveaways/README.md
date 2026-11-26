# Giveaways

Giveaways are an opt-in pilot for Cicord 0.2.0. The empty configuration leaves the pilot disabled. Operators should enable the pilot after confirming demand with three target communities.

```yaml
enabled: true
channels: [community]
managerRoles: [events-team]
defaultDurationHours: 24
maxWinners: 3
bonus: [{role: booster, entries: 1}]
conditions: {memberDays: 3}
claim: {enabled: true, hours: 24}
publishEntrants: true
```

Run `/giveaway start` in the destination channel. Choose the duration and winner count, then enter the prize and description. The announcement contains a SHA-256 commitment to a fresh 32-byte seed. Entrants can join and leave until the deadline. Role weights are fixed on entry. The scheduled draw edits the original message. Staff can list, end, cancel or reroll draws. Unclaimed prizes are redrawn from the remaining participants.

Only viewers who can currently read the draw channel and its history can inspect it. Anonymous verification is available for universally readable channels. A subsequent permission change also restricts old proofs, staff lists and entrant downloads. `GET /giveaways/:id` exposes the commitment immediately and the seed, winners and entrants hash after the draw. Set `publishEntrants: false` to restrict the verification list to the moderator route `GET /giveaways/:id/entries`. Moderators can page through `GET /giveaways`. Use `node test/verify.mjs input.json` with the seed, draw ID, entries, winner count and previous winners. Reference vectors are in `test/vectors/gw-draw-v1.json`. The plugin uses fast-sha256 1.3.0. Its source and license are included under `src/fast-sha256`.

The plugin publishes `started` and `ended`. Optional grants enable level, invitation and moderation eligibility checks and XP, currency or temporary-role rewards. Starting a draw with an unverifiable condition is refused. A missing reward provider is reported in the instance log. A failed call is retried using the original reward key. Draws work without partner plugins when these options are empty.

Privacy export includes the member’s weight and winner status. Erasure removes their participation, claims, winner notices and identity from the result, edits the announcement and marks the published proof as redacted. The remaining proof shows its original hash until expiration. Completed and cancelled draws are removed after `historyDays` (365 by default), including the participant list and the public message contents.
