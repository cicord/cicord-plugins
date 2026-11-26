# Community events

Schedule Discord events, send opt-in reminders and publish attendance for participation rewards. Staff can run `/event create` to enter a name, start, end and external location. Members run `/event reminders enabled:true` and mark themselves **Interested** on the individual Discord event to receive reminders.

## Recurring events

The first ISO 8601 timestamp sets the weekly recurrence. `timeZone` (an IANA zone, default `UTC`) keeps each occurrence on the same local weekday and time across daylight-saving changes: the example stays at 21:00 in Paris, which is 20:00 UTC in winter and 19:00 UTC in summer. With `UTC`, the UTC time stays fixed. Each series has a stable key. Set a voice channel for a voice event or a location for an external event. This example keeps four weeks of Friday events on the calendar.

```yaml
weeksAhead: 4
minMinutes: 10
announcementChannel: general
role: events
series:
  - key: friday-games
    name: Friday games
    start: "2027-01-08T20:00:00Z"
    timeZone: Europe/Paris
    durationMinutes: 90
    channel: games-voice
```

On startup and hourly, the plugin reconciles future occurrences using the series key and week. It edits or deletes only events owned by this installation. A run makes at most ten Discord changes and continues in a follow-up task. When Discord refuses for lack of the **Manage Events** permission, the `manageEvents` status line says so and the next run retries. At event start it announces to the configured channel when its audience is the same as or narrower than the source. An unknown audience suppresses the announcement. Each member reminder rechecks opt-in, current server membership and visibility of the source voice channel before sending.

## Portal and interop

The public routes `GET /calendar` and `GET /calendar.ics` list public events that have not ended yet, plus those that ended in the last 30 days. They read two bounded indexes (live events and recently ended ones, at most 200 rows each), never the whole event history. The ICS feed uses stable UIDs and weekly RRULEs. A zoned series is written in its local time with `TZID` and a matching `VTIMEZONE`. Subscribe to `/api/v1/portal/<server>/plugins/<bot>/<instance>/calendar.ics`. Private voice events are filtered before either representation is sent.

Server-scoped `community-events.started` and `community-events.ended` carry event and channel IDs. The latter includes members meeting `minMinutes`. Voice attendance is sampled once per minute. Two consecutive observations earn one minute, and time between observations separated by an outage earns none.

## Access and retention

Grant `discord.events.read`, `discord.events.manage`, `discord.members.read`, `discord.channels.read`, `discord.messages.send`, `discord.dm.send`, `scheduler`, `storage.kv`, `portal.routes` and `events.publish`. Discord must grant **Manage Events** and access to the chosen channels. Declare the ServerScheduledEvents and ServerVoiceStates intents.

Opt-ins last until the member opts out or requests erasure. Attendance samples, delivery checkpoints and receipts expire after 30 days. The plugin asks Discord to retract reminder DMs at 30 days and on an earlier erasure. Event metadata stays in the plugin's history; the public calendar drops an event 30 days after it ends. Erasure also removes the member from unfinished attendance exports.

Each outbound notification reserves a receipt before sending and uses a channel-scoped Discord nonce. Ambiguous sends can retry with the same nonce for one minute. After that interval the plugin logs an unconfirmed delivery and stops sending that notification. The original may have reached Discord. Reminder jobs process one event and at most five opted-in recipients at a time.
