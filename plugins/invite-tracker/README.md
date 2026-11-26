# Invite tracker

Track which invitation brought a member to the server. `/invites [user]` shows valid, fake and departed counts. `/invite-leaderboard` and the member-only portal route `GET /leaderboard` rank inviters by valid members currently present.

```yaml
minAccountDays: 7
minStayDays: 7
```

The plugin reads invite-use counters on startup, follows create/delete events and serializes member joins. A positive delta on a single known code can identify its inviter. Two uses of that code can identify both joining members. A vanity delta identifies the vanity URL. Discord supplies no per-member evidence when different codes both advance in the same snapshot, so both joins stay unknown. A previously unseen code after an outage also stays unknown while the cache resynchronizes.

A young account or a departure inside `minStayDays` marks the join as fake. The left count includes every departed invitee with an attribution, including fake joins. Valid counts exclude fake and departed members.

## Access and retention

Grant `discord.invites.read`, `storage.kv`, `events.publish` and `portal.routes`. The bot needs Manage Server to read use counters and access to invite gateway events. Declare ServerMembers and ServerInvites. An unavailable initial invite listing prevents attribution until the instance can initialize.

`invite-tracker.joined` publishes a join with optional inviter/code and the fake flag to authorized server subscribers. `inviterOf` serves background integrations and allows a member to inspect their own attribution. Staff may inspect another member. `count` exposes totals.

The current join record per member contains the timestamp, status, optional code and inviter. It stays available after departure for counts until the member requests erasure or the installation data is removed. Erasing an invitee removes their record. Erasing an inviter removes their identifier and invite code from other members’ records. The live invite snapshot is rebuilt on startup.
