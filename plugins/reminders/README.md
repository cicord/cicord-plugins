# Reminders

Use `/remind create when message`. Discord registers personal reminder operations as subcommands of one command. Times include `2h`, `30m`, `tomorrow 9am`, `demain 9h` and `2026-12-24 18:00`. Set `where: channel` to deliver in the originating channel. The default is a DM. A repeat interval such as `2h` is an elapsed duration. `/remind list` and `/remind cancel` are private to the requester.

```yaml
timeZone: Europe/Paris
maxActive: 20
minRepeatMinutes: 60
```

All settings have defaults. The `/timezone set` autocomplete lists supported IANA zones. The time zone's daylight-saving rules are applied to local dates. A skipped clock time moves forward one hour, and a repeated time resolves to its first occurrence. `reminders.timezone` v1 accepts `{userId}` and returns `{timeZone?}`. Delegated requests can read the caller's own preference.

The **Remind me** message menu creates a private reminder with the source link for one hour later. Delivery rechecks the owner's access to the source and any destination channel. Snooze buttons belong to the original requester, expire in 24 hours and can be used once per delivery. A missed occurrence is delivered once with its delay in minutes. A recurring reminder resumes on its original interval and skips additional missed occurrences.

The plugin stores the text a member enters, the destination and schedule until delivery or cancellation. The snooze copy expires in one day. Member erasure clears active reminders, all snooze copies, time zone and pending tasks. A scheduled payload contains only a reminder number and due time. The manifest lists required Discord, scheduling and storage grants. Set `enabled: false` to disable the instance.
