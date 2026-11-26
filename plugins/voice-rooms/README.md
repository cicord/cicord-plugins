# Voice rooms

Joining a configured lobby creates a temporary voice channel and moves the member into it. Owners can rename, cap, lock, permit, kick, transfer and claim rooms through `/voice`. The bot needs permission to create and manage channels, move members and grant the configured owner permissions.

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
