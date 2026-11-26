# Community events

Schedule Discord events, send opt-in reminders and publish attendance for participation rewards. Staff can run `/event create` to enter a name, start, end and external location. Members run `/event reminders enabled:true` and mark themselves **Interested** on the individual Discord event to receive reminders.

## Recurring events

The first ISO 8601 timestamp sets the weekly recurrence. **The UTC time stays fixed across daylight-saving changes.** Each series has a stable key. Set a voice channel for a voice event or a location for an external event. This example keeps four weeks of Friday events on the calendar.

```yaml
weeksAhead: 4
minMinutes: 10
announcementChannel: general
role: events
series:
  - key: friday-games
    name: Friday games
    start: "2027-01-08T20:00:00Z"
    durationMinutes: 90
    channel: games-voice
```

On startup and hourly, the plugin reconciles future occurrences using the series key and week. It edits or deletes only events owned by this installation. At event start it announces to the configured channel when its audience is the same as or narrower than the source. An unknown audience suppresses the announcement. Each member reminder rechecks opt-in, current server membership and visibility of the source voice channel before sending.

## Portal and interop

The public routes `GET /calendar` and `GET /calendar.ics` list public events. The ICS feed uses stable UIDs and weekly RRULEs. Subscribe to `/api/v1/portal/<server>/plugins/<bot>/<instance>/calendar.ics`. Private voice events are filtered before either representation is sent.

Server-scoped `community-events.started` and `community-events.ended` carry event and channel IDs. The latter includes members meeting `minMinutes`. Voice attendance is sampled once per minute. Two consecutive observations earn one minute, and time between observations separated by an outage earns none.

## Access and retention

Grant `discord.events.read`, `discord.events.manage`, `discord.members.read`, `discord.channels.read`, `discord.messages.send`, `discord.dm.send`, `scheduler`, `storage.kv`, `portal.routes` and `events.publish`. Discord must grant **Manage Events** and access to the chosen channels. Declare the ServerScheduledEvents and ServerVoiceStates intents.

Opt-ins last until the member opts out or requests erasure. Attendance samples, delivery checkpoints and receipts expire after 30 days. The plugin asks Discord to retract reminder DMs at 30 days and on an earlier erasure. Event metadata stays in the calendar history. Erasure also removes the member from unfinished attendance exports.

Each outbound notification reserves a receipt before sending and uses a channel-scoped Discord nonce. Ambiguous sends can retry with the same nonce for one minute. After that interval the plugin logs an unconfirmed delivery and stops sending that notification. The original may have reached Discord. Reminder jobs process one event and at most five opted-in recipients at a time.
