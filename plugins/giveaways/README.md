# Giveaways

Giveaways are **experimental** and opt-in in Cicord 0.2.0. The empty configuration leaves the plugin disabled. It stays experimental until usage is confirmed with three target communities (the specification's usage gate).

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
rewards: {role: winner, durationSeconds: 604800}
```

A role reward is granted through member-roles (the optional `roleReward` feature, `plugins.call:member-roles.grantTemporary`). member-roles refuses roles that are not in its `temp.roles` list, and an empty list refuses every call from another plugin, so list the reward role there. The member-roles instance for the draw above:

```yaml
enabled: true
temp: {maxDays: 7, roles: [winner]}
```

Run `/giveaway start` in the destination channel. Choose the duration and winner count, then enter the prize and description. The announcement contains a SHA-256 commitment to a fresh 32-byte seed. Entrants can join and leave until the deadline. A refused entry names the unmet condition. Role weights are fixed on entry. Each entry writes only its own record and an entrant counter, so simultaneous clicks do not contend. The panel's entrant count refreshes at most every 10 seconds. Giveaways opened by version 0.1.0 keep their recorded entrant count. The draw first closes entries, then reads the entrant list. An entry still in flight at that moment is refused and never left out of the draw. The scheduled draw edits the original message. Staff can list, end, cancel or reroll draws. Unclaimed prizes are redrawn from the remaining participants.

Only viewers who can currently read the draw channel and its history can inspect it. Anonymous verification is available for universally readable channels. A subsequent permission change also restricts old proofs, staff lists and entrant downloads. `GET /giveaways/:id` exposes the commitment immediately and the seed, winners and entrants hash after the draw. The entrant list comes in pages of 1,000 (`entries`). Pass `entriesCursor` back as `?cursor=` for the next page, and sort the concatenated pages by numeric ID before hashing, as the verifier does. Set `publishEntrants: false` to restrict the verification list to the moderator route `GET /giveaways/:id/entries`, which pages the same way. Moderators can page through `GET /giveaways`. To verify a draw, run `node test/verify.mjs <draw URL>` with the `GET /giveaways/:id` portal URL. The verifier fetches every entrant page, following `entriesCursor` until it is absent, then reports `entrantsHashMatches`, `commitmentMatches` and `winnersMatch` against the published fields. For the moderator route `/giveaways/:id/entries`, set `CICORD_PORTAL_TOKEN` to a moderator's portal session token, or pass `url` and `headers` in `input.json`; that route has no seed or winners, so give them in `input.json`. For a redraw, add the winner count and the earlier winners: `node test/verify.mjs <draw URL> 1 <id>,<id>`. Reading only the first page cannot reproduce the proof of a draw above 1,000 entrants. `node test/verify.mjs input.json` also works offline, with the seed, draw ID, entries (or a `url` to fetch them from), winner count and previous winners. Reference vectors are in `test/vectors/gw-draw-v1.json`. The plugin uses fast-sha256 1.3.0. Its source and license are included under `src/fast-sha256`.

The plugin publishes `started` and `ended`. Optional grants enable level, invitation and moderation eligibility checks and XP, currency or temporary-role rewards. Starting a draw with an unverifiable condition is refused. A missing reward provider is reported on the instance status (`reward-<feature>`) at startup and at payout. The line clears after the next successful payout or a startup with the provider available. A condition provider that disappears or fails after launch refuses entries and names the condition. A failed call is retried using the original reward key. Draws work without partner plugins when these options are empty.

Privacy export includes the member’s weight and winner status. Erasure removes their participation, claims, winner notices and identity from the result, edits the announcement and marks the published proof as redacted. The remaining proof shows its original hash until expiration. Completed and cancelled draws are removed after `historyDays` (365 by default), including the participant list and the public message contents.
