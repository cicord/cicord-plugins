# Voice rooms

Joining a configured lobby creates a temporary voice channel and moves the member into it. Owners can rename, cap, lock, permit, kick, transfer and claim rooms through `/voice`. Discord allows two renames of a channel per ten minutes. The instance records each room's renames in its storage, so the limit holds across restarts and concurrent handlers. A third `/voice rename` inside the window is refused. Renames made by member erasure count toward the window and are never refused. The bot needs permission to create and manage channels, move members and grant the configured owner permissions. Before creating a room it checks its own Move Members on the hub, and Manage Channels, Connect and Move Members on the room category. A missing one gets a `permissions:<hub>` status line, and joins create nothing until it is fixed. A Discord refusal while creating or moving sets the same line, and the hub waits five minutes between attempts instead of creating and deleting a channel on every join. Missing overwrite permissions get the `owner-permissions` line; the room still works. Each creation writes a marker first and creates the channel with a provisioning key (`provisionKey`). A redelivered or interrupted join resumes with the same key, so the host returns the channel already created instead of a second room. The five-minute sweep finds markers older than two minutes and deletes the empty, untracked channel of an interrupted creation. One window remains: a crash inside the host call, between Discord creating the channel and the host recording its ownership receipt, can leave one channel the plugin cannot recognize. Delete it by hand.

```yaml
hubs:
  - channel: create-voice
    name: "🔊 {member}"
    userLimit: 6
emptyDelaySeconds: 30
onRestart: adopt
```

Hubs are required on an enabled instance. Set `enabled: false` for a disabled configuration. Built-in wording is provided in English and French. Operator-supplied room names and configuration retain their original language. `onRestart: adopt` waits for the gateway's voice state before checking rooms. Explicitly choosing `delete` deletes the instance's temporary rooms after a restart. Cleanup rechecks occupancy and its deadline, including a delayed replay after an earlier timer was cancelled.

Grant `events.publish` to publish the server-scoped v1 events `voice-rooms.roomCreated` and `voice-rooms.roomClosed`. Each contains the channel and owner IDs. The close event also reports elapsed minutes and peak *observed* human occupancy. A durable key identifies each room/transition across delivery attempts. Room creation continues when the publication feature is disabled.

The instance stores ownership, the room name when member-derived, individual permission changes and a creation cooldown. Member export returns the member's own associations. Erasure restores the affected permission bits, preserves later staff decisions, removes the member's recorded name and clears their cooldown. A shared room stays open under bot stewardship until an eligible occupant claims it. The bot retains its own channel access.

Version 0.1.1 runs on engine 0.1.10. Version 0.2 adopts existing rooms in batches of 25 and adds lifecycle events. The previous version recorded room ownership but had no provenance for guest changes. The privacy report identifies remaining legacy Discord overrides. Staff can review those overrides, which disappear with the temporary room. Historic voice chat content is never stored.
