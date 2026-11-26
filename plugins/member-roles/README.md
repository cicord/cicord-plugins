# Member roles

Enable this instance with `enabled: true`. The bot needs Manage Roles and a role above each role it changes. Configure the Server Members intent in the Developer Portal. Temporary grants, sticky restoration, membership milestones and boosts all refuse roles that declare their holders in server YAML, roles owned by Discord integrations and the everyone role.

```yaml
enabled: true
sticky: {roles: [muted], retentionDays: 90}
tenure: [{days: 30, role: regular}]
boost: {role: booster-perks, announce: general}
temp: {maxDays: 90, managerRoles: [moderator], roles: [visitor], privilegedRoles: []}
```

Use `/temprole add`, `list` and `remove` to manage grants. Durations accept s, m, h, d or w. With no manager role configured, a manager needs Discord’s Manage Roles permission. The guild owner can always manage grants. A temporary-role allowlist (`temp.roles`) limits both commands and inter-plugin actions. With an empty list, `/temprole` may grant any assignable role, but `grantTemporary` and `revoke` calls from other plugins are refused: list the roles other plugins may grant. The operator must also explicitly grant each caller access to `member-roles.grantTemporary` or `member-roles.revoke`. When a call is made on behalf of a person for another member, that person must be a temporary-role manager ranked above the role, as for `/temprole`. A member's own request, such as a shop purchase or a giveaway claim, needs only the allowlist. Economy and giveaways role rewards therefore need their role in `temp.roles`. Temporary grants, from `/temprole` or another plugin, refuse a role that carries Administrator, Manage Roles, Manage Server, Ban Members, Kick Members, Manage Channels, Manage Webhooks, Mention Everyone or Timeout Members. They also refuse a role whose permissions the runtime does not know yet (fail closed). To grant such a role temporarily on purpose, list it in `temp.privilegedRoles` as well. A privileged role in `temp.roles` without that opt-in gets a `privileged:<role>` status line at startup.

An extension adds its duration to the remaining grant. The runtime deduplicates action calls by their idempotency key. Expiry checks the stored deadline, so superseded jobs are harmless. Startup validates every configured role. A role whose holders are declared in YAML, that an integration owns, that is missing or that sits above the bot gets its own instance status line naming it; the rules using that role skip it and everything else keeps running. Membership changes trigger tenure and boost checks. The daily scan uses batches of 25 members, checkpoints its cursor after each successful page and resumes on startup or at the next five-minute scheduling interval. Only one page chain runs at a time. Sticky roles use the last known snapshot when the gateway has no leave-time member record. Missing announcement grants disable the optional boost announcement.

## Member data

Temporary grants and their expiry jobs identify a member and role until the grant ends. Audit reasons are passed to role operations. Sticky snapshots identify current holders and expire 90 days after departure by default. Boost markers last until the next observed end of a boost. Announcements disclose a new boost without naming the member. Exports cover role records, sticky snapshots, boost markers, expiry jobs and the scan cursor. Erasure removes sticky snapshots, boost markers, the scan cursor and the request token of temporary grants. A live temporary grant (member, role, deadline and its expiry job) is retained until it expires, so the role is still removed on schedule instead of becoming permanent. Other current role assignments remain under Discord administration.
