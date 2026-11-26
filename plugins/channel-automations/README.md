# Channel automations

Declare one rule per channel. The plugin handles posts only in the configured channels.

```yaml
rules:
  - channel: showcase
    autoThread: "Discussion with {author}"
    autoReact: ["⭐"]
    mediaOnly: true
    onePostPer: 60
    autoDelete: 168
    cleanBots: 15
  - channel: news
    autoCrosspost: true
```

`autoThread` accepts `{author}` and `{id}`. A starter message has at most one Discord thread. `onePostPer` and `cleanBots` use minutes. `autoDelete` uses hours. The durable cleanup task checks current pins immediately before deletion, including when processing an overdue task after a restart.

| Feature | Required grant |
| --- | --- |
| Start threads | `discord.threads.manage` |
| Reactions | `discord.reactions.manage` |
| Publish in announcement channels | `discord.messages.send` |
| Rate limits and timed cleanup | `discord.messages.manage` |
| Require an attachment or HTTP(S) link | `MessageContent` intent, `discord.messages.manage`, `discord.dm.send`, `discord.members.read` |

Each optional feature is gated by its granted capabilities and intents. Media checks are skipped when the content intent is absent. The bot needs permission to read message history and manage the affected messages. Crosspost failures are logged without repeatedly publishing. The media-only DM is limited to once per user per hour.

The plugin stores identifiers for cooldowns, pending deletions and thread receipts. Text and attachment contents are never saved. Cooldowns expire after the configured interval, thread receipts after 31 days, and cleanup references after the task finishes. Export and erasure cover the member's pending tasks and receipts. Set `enabled: false` to disable the instance.
