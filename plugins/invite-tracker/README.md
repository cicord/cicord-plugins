# Invite tracker

Track which invitation brought a member to the server. `/invites [user]` shows valid, fake and departed counts. `/invite-leaderboard` and the member-only portal route `GET /leaderboard` rank inviters by valid members currently present.

```yaml
minAccountDays: 7
minStayDays: 7
```

The plugin reads invite-use counters on startup, follows create/delete events and serializes member joins. Each join compares the counters with the previous snapshot. Discord reports how many times an invite was used, never by whom. A join is attributed only when every use that could be that member's points at the same invite. A positive delta on a single known code identifies its inviter. Two uses of that code identify both joining members. A vanity delta identifies the vanity URL. When different codes of the same inviter advance together, the joins get that inviter without a code. When codes of different inviters advance in the same snapshot, those joins stay unknown. A join with no counter change stays unknown. A leftover use from a missed join is never handed to a later join. Uses only count for members who joined between the snapshot before them and the snapshot that showed them, with a 15-second clock tolerance. A previously unseen code after an outage leaves the joins around it unknown. A capped invite that disappears (Discord deletes a single-use invite when it is used) does the same. The plugin takes a fresh baseline after a gateway resume.

A young account or a departure inside `minStayDays` marks the join as fake. The left count includes every departed invitee with an attribution, including fake joins. Valid counts exclude fake and departed members.

## Access and retention

Grant `scheduler`, `discord.invites.read`, `storage.kv`, `events.publish` and `portal.routes`. The bot needs Manage Server to read use counters and access to invite gateway events. Declare ServerMembers and ServerInvites. Without Manage Server, or while the counters cannot be read, the instance status says that attribution is paused. Joins are still recorded and published without an inviter. Attribution resumes from a fresh baseline once the counters can be read again: on the next join, a role change, a change to the bot's own roles or a gateway resume.

`invite-tracker.joined` publishes a join with optional inviter/code and the fake flag to authorized server subscribers. `inviterOf` serves background integrations and allows a member to inspect their own attribution. Staff may inspect another member. `count` exposes totals. Case-scoped sessions cannot read invite data. An unauthorized delegated lookup returns the interop error `denied`.

The current join record per member contains the timestamp, status, optional code and inviter. It stays available after departure for counts until the member requests erasure or the installation data is removed. Erasing an invitee removes their record. Erasing an inviter removes their identifier and invite code from other members’ records. The live invite snapshot is rebuilt on startup.


## Ranking and upgrades

A member lookup reads one inviter total. The leaderboard reads the sorted index. The portal accepts `limit` (1–100, default 100) and `offset`. Invite balances, ranks and attribution records change in the same transaction.

The first start after upgrading indexes existing joins in batches of 16. Grant `scheduler` so durable continuation jobs can complete. A persisted cursor records progress across restarts. Commands show the number checked during backfill. The leaderboard returns HTTP 503 and the count query reports that indexing is in progress until all balances are ready. New joins and departures can continue during migration.
