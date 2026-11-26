# Birthdays

Members opt in using `/birthday set day month` or the birthday form. The public upcoming list shows the next ten opt-ins. Use `/birthday remove` to withdraw consent. The plugin stores a month and day. February 29 moves to February 28 in a non-leap year.

```yaml
channel: general
timeZone: Europe/Paris
hour: 9
role: birthday
eraseOnLeave: true
```

Only the channel is required. A local-time wake-up is persisted for each opt-in, including the last celebrated year and the next wake-up. The next local date is recalculated at least daily. A missed birthday is caught up on restart. The server locale or the instance's `locale` chooses English or French.

Grant `plugins.query:reminders.timezone` for the member's saved zone. An absent provider uses the configured zone. Grant `plugins.call:member-roles.grantTemporary` for the durable birthday role action, and list the birthday role in the member-roles `temp.roles`: member-roles refuses other plugins' calls for any role not listed there, and an empty list refuses them all. For the example above, the member-roles instance has `temp: {roles: [birthday]}`. When that provider is absent, `discord.roles.assign` enables direct 24-hour roles and an expiry task. Give the bot a higher role than the birthday role and keep its membership out of declarative YAML. A pre-existing direct role is preserved. An unavailable grant disables its feature. A failed provider call retries with the same annual key.

The server-scoped `birthdays.today` v1 event contains `{userId}`. Member routes `GET`, `PUT` and `DELETE /birthday` operate on the viewer's own opt-in. A member is greeted, given the role and announced in `birthdays.today` at most once per year: a per-member yearly marker survives `/birthday remove` and a new opt-in, and expires after 400 days. The greeting nonce, the member-roles call and the event use the per-member key `birthday:<userId>:<year>`. Erasing a member removes the opt-in, the yearly markers, upcoming index entry, outstanding tasks and directly managed birthday role. A withdrawal with `/birthday remove` or the form keeps only the yearly marker. With `eraseOnLeave: false`, an opt-in is retained until withdrawal. Set `enabled: false` to disable the instance with an empty configuration.
