# Starboard

A starboard publishes eligible highlights and a link to the source. It never stores the original text or image in KV. The plugin reads Discord's current message reactions and subtracts the author’s own reaction. Bot-authored messages are excluded by default.

```yaml
channel: stars
emoji: "⭐"
threshold: 3
removeBelow: true
boards:
  - {sources: [staff], channel: staff-stars}
```

The default destination accepts publicly readable sources. Explicit mappings can select a private source. In both cases the current destination audience must be equal to or narrower than the source. Permission uncertainty prevents copying. The host also checks age-restricted channels. A source deletion, disqualifying count or shortened audience removes the posted copy. A daily audit and startup audit cover quiet messages. `historyDays` limits source and copy age to 365 days by default. Score edits are coalesced over ten seconds. The plugin records the pending source before sending. A stable nonce and a recoverable message marker protect against repeated sends after interruption.

`/starboard top` checks the reader's live access to both source and destination. The `starred` event carries the message ID, author ID and star count. Subscription partners are optional.

The member export lists the source IDs and star counts of their highlights. Erasure removes those entries, the ranking and the Discord copies, including a highlight still inside its ten-second coalescing window (its author is read from the source message). Reaction membership is fetched from Discord without persisting a list of voters. Set `enabled: false` to disable the instance.
