# Welcome

```yaml
channel: general
trigger: join
variants:
  - "Welcome {member} to {server}!"
  - "Hello {member}! You are member #{number}."
card: true
showInviter: true
```

Only `channel` is required. `trigger` can be `join`, `verified` (the `verification.passed` v1 event) or `onboarded` (the member's completed-onboarding flag). A configured verification trigger waits for the event. A randomly chosen variant stays stable when the greeting is replayed.

Enable optional features through the instance grants. `events.subscribe` enables the verification trigger. `render` adds a card with the bundled background, avatar, display name and welcome number. `files.read` enables a greeting from `templateFile`, which must belong to the instance's files declaration. `plugins.query:invite-tracker.inviterOf` adds the known inviter. Missing partners omit that line. `discord.roles.assign` gives `autoRole`, and `portal.links` plus `discord.dm.send` sends the private onboarding link. Set `leaveMessage` for a farewell.

The preview and statistics commands retain their original names. The aggregate welcome count survives upgrades. The per-membership receipt prevents repeat greetings, is included in member exports and is deleted on erasure or departure. Set `enabled: false` to disable the instance.

The 700 × 220 card took 155 ms at p95 across 30 warmed renders on the integration host (maximum 161 ms), using the bundled background, a cached 128 × 128 avatar and both text layers. Timing begins at renderer invocation and ends when PNG bytes are returned. Avatar downloads and Discord sends are outside this interval.
