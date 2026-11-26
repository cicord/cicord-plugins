# Reminders

Use `/remind create when message`. Discord registers personal reminder operations as subcommands of one command. Times include `2h`, `30m`, `tomorrow 9am`, `demain 9h` and `2026-12-24 18:00`. Set `where: channel` to deliver in the originating channel. The default is a DM. The bot posts the member's text, so a channel reminder is refused unless the member can view the channel and send messages there (Send Messages in Threads for a thread). Delivery checks this again: a member who lost it gets that occurrence by DM with a note instead. A repeat of whole days or weeks (`1d`, `2d`, `1w`) keeps its local time in the member's time zone at creation across daylight-saving changes, so a daily 09:00 reminder stays at 09:00. A shorter interval such as `2h` is an elapsed duration. `/remind list` and `/remind cancel` are private to the requester.

```yaml
timeZone: Europe/Paris
maxActive: 20
minRepeatMinutes: 60
```

All settings have defaults. The `/timezone set` autocomplete lists supported IANA zones. The time zone's daylight-saving rules are applied to local dates. A skipped clock time moves forward one hour, and a repeated time resolves to its first occurrence. `reminders.timezone` v1 accepts `{userId}` and returns `{timeZone?}`. Delegated requests can read the caller's own preference.

The **Remind me** message menu creates a private reminder with the source link for one hour later. Delivery rechecks the owner's access to the source and any destination channel. Snooze buttons belong to the original requester, expire in 24 hours and can be used once per delivery. A missed occurrence is delivered once with its delay in minutes. A recurring reminder resumes on its original interval and skips additional missed occurrences. When Discord refuses a reminder DM for good (the member does not accept DMs), that occurrence is skipped, the next one stays scheduled and the `dm` status line says so. When Discord refuses a channel post (for example a missing bot permission), the reminder goes by DM and the `channel` status line names the channel. Both lines clear after the next successful delivery of that kind. Ambiguous failures retry with the same Discord nonce.

The plugin stores the text a member enters, the destination and schedule until delivery or cancellation. The snooze copy expires in one day. Member erasure clears active reminders, all snooze copies, time zone and pending tasks. Reminders already delivered in a channel are ordinary channel messages: the plugin keeps no record of them and erasure does not delete them (it would need the message management grant); staff can delete them. A scheduled payload contains only a reminder number and due time. The manifest lists required Discord, scheduling and storage grants. Set `enabled: false` to disable the instance.
