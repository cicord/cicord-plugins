# Member roles

Enable this instance with `enabled: true`. The bot needs Manage Roles and a role above each role it changes. Configure the Server Members intent in the Developer Portal. Temporary grants, sticky restoration, membership milestones and boosts all refuse roles that declare their holders in server YAML, roles owned by Discord integrations and the everyone role.

```yaml
enabled: true
sticky: {roles: [muted], retentionDays: 90}
tenure: [{days: 30, role: regular}]
boost: {role: booster-perks, announce: general}
temp: {maxDays: 90, managerRoles: [moderator], roles: [visitor]}
```

Use `/temprole add`, `list` and `remove` to manage grants. Durations accept s, m, h, d or w. With no manager role configured, a manager needs Discord’s Manage Roles permission. The guild owner can always manage grants. A temporary-role allowlist limits both commands and inter-plugin actions. The operator must explicitly grant each caller access to `member-roles.grantTemporary` or `member-roles.revoke`.

An extension adds its duration to the remaining grant. The runtime deduplicates action calls by their idempotency key. Expiry checks the stored deadline, so superseded jobs are harmless. Startup validates role ownership and hierarchy. Membership changes trigger tenure and boost checks. The daily scan uses batches of 25 members, checkpoints its cursor after each successful page and resumes on startup or at the next five-minute scheduling interval. Sticky roles use the last known snapshot when the gateway has no leave-time member record. Missing announcement grants disable the optional boost announcement.

## Member data

Temporary grants and their expiry jobs identify a member and role until the grant ends. Audit reasons are passed to role operations. Sticky snapshots identify current holders and expire 90 days after departure by default. Boost markers last until the next observed end of a boost. Announcements disclose a new boost without naming the member. Exports and erasure cover role records, sticky snapshots, boost markers, expiry jobs and the scan cursor. Erasure removes stored personal data. The server's current role assignments remain under Discord administration.
