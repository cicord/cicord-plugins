# Polls

Run `/poll` with a question and two to ten choices separated by `|`. The default uses buttons. Choose `select` for a menu or `native` for a Discord poll. Use `/polls results` to inspect a tally. The author, a configured manager or a member with Manage Server or Administrator can use `/polls close`.

| Option | Buttons or menu | Native |
| --- | --- | --- |
| Multiple answers | Optional per-voter maximum | On or off |
| Eligible roles and role weights | Supported | Rejected at creation |
| Anonymous voting | Supported | Rejected at creation |
| Duration | Fractional hours | 1–768 whole hours within the server limit |
| Future start | ISO 8601 timestamp | ISO 8601 timestamp |

A scheduled start supports neither the optional ping nor a discussion thread. Set `channels` to limit posting and `managerRoles` to delegate closing. Voters need at least one configured eligible role. The highest applicable role weight counts once per selected answer.

```yaml
defaultHours: 24
maxHours: 168
eligibleRoles: [member]
roleWeights:
  - role: organizer
    weight: 2
```

Leave eligibility and weights empty for native polls. Discord supplies their live and final choice counts. For native multi-select polls the reported participant total deduplicates voters across every answer and page. Native answers have a 55-character maximum.

## Results, grants and retention

`GET /polls/:id` returns aggregate results. Anonymous viewers can read public source channels. Private channels require a member who can currently read the source. Discord results, autocomplete, voting controls and closure also check current source-channel access. Removing that access hides the poll even from its author or a poll manager. The plugin publishes `polls.closed` v1 within the bot and v2 across the server. V2 includes the distinct voter count. Above 10,000 participants it omits the ID array and sets `votersTruncated`. A consumer granted `plugins.query:polls.voters` can request up to 1,000 distinct participants per page to award participation. A member-delegated call checks current channel access and returns the interop error `denied` on refusal. Case-scoped sessions cannot query ballots.

Anonymous button and menu polls keep ballots only during voting. Closing deletes them before publishing. Both event versions suppress voters and the closing operator, and the voter query returns an empty page. Non-anonymous ballots and archived poll metadata stay available for results and reward queries until member erasure or instance data removal. Erasure covers ballot keys, native voter pages and creator/closer references. Discord controls the visibility and retention of votes on its native poll messages.

Grant `discord.messages.send`, `discord.messages.read`, `discord.channels.read`, `discord.threads.manage`, `discord.members.read`, `storage.kv`, `scheduler`, `events.publish` and `portal.routes`. On Discord the bot needs Send Polls for native mode and the corresponding message, history and thread permissions for the chosen features.
