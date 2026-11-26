# Suggestions

Members submit a proposal through `/suggest`. An explicitly configured forum can also accept its starter message. The Discord card carries changeable thumbs-up and thumbs-down votes. The score and the portal ranking update together. Discord card edits are grouped over five seconds.

```yaml
channel: suggestions
anonymous: true
retainText: false
managerRoles: [staff]
archive: decisions
```

Configure `discussion` to open a thread, `authorNotice` to DM decisions, or `duplicateSearch` with `retainText: true` for full-text duplicate suggestions. Each feature requires its declared grant. Duplicate matches must be visible to the submitting member.

`GET /suggestions` accepts a status and offset. Anonymous readers see only publicly readable proposals. Authenticated readers must still have access to the source. Public cards hide author IDs when anonymity is enabled. The moderator route `GET /suggestions/moderation` includes authors with current read access. `POST /suggestions/:id/status` accepts `open`, `considered`, `approved`, `denied` or `implemented` and a reason. Approved, implemented and denied suggestions can have an archive copy when its audience is suitable. The daily audit rechecks archived copies. The plugin publishes `created` and `statusChanged`.

The default KV record contains IDs, status, votes and decision reason. Proposal text is retained in KV and the search index only on explicit opt-in. Member erasure removes their proposals, search entries and bot copies, and removes their votes on other proposals while adjusting scores. Set `enabled: false` to disable the instance.
