# Staff shifts

```yaml
staffRole: moderator
dutyRole: on-duty
maxHours: 8
reminderMinutes: 15
```

Both roles are required. The bot needs Manage Roles and a role above the duty role. Leave the duty role's membership out of declarative YAML. Members of the staff role can use `/duty on`. `/duty off` and the durable deadline end a shift. Directly pre-existing duty roles are preserved. The `staff-shifts.onDuty` v1 query returns `{userIds}`, rechecking the staff and duty roles and each shift's expiry.

The portal serves `GET /me`, `PUT /me/plan` and `GET /coverage?from=<ISO timestamp>`. All three recheck the viewer's staff role. Plans contain an IANA zone and up to 28 weekly shifts. A shift gives a weekday (Sunday = 0), the starting minute on that local clock and the number of elapsed minutes. Coverage lists uncovered UTC intervals in the requested seven-day window. This allows different local clocks, DST changes and overnight shifts.

Grant `discord.dm.send` to enable advance shift reminders. Grant `events.subscribe` to count completed tickets by assignee and `moderation.case` v2 cases by their moderator (`moderator.id`). Automatic cases without a moderator and cases by members who no longer hold the staff role are not counted. A redelivered event counts once. The plugin works without either source. Event receipts are kept for 31 days. Totals expire after one year without an update. Member data export covers the plan, active duty, statistics and replay receipts. Erasure or departure clears those records and scheduled reminders. Set `enabled: false` to disable the instance.
