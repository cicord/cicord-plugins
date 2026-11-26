# Tickets

Members can open a private ticket from a Discord panel, a selected message, the portal, or a DM. Use `/ticket-panel` to post the panel. Staff can claim a ticket in Discord and manage assignments, replies and private notes on the portal. The plugin keeps existing general tickets under the type key `default`. Include that key and its staff roles when introducing types to an existing installation.

The bot manifest selects one instance to receive its DMs. For example, an installation named `support` can use the following configuration.

```yaml
spec:
  directMessages: {instance: support}
  plugins:
    - name: support
      source: cicord/tickets
      version: 0.4.0
      grants: [discord.messages.send, discord.messages.read, discord.messages.manage, discord.channels.read, discord.channels.manage, discord.members.read, discord.dm.send, storage.kv, portal.routes, portal.links, events.publish, scheduler]
      config:
        panelChannel: help
        modmailType: default
        appealType: appeals
        firstResponseMinutes: 30
        inactivityHours: 48
        transcriptRetentionDays: 30
        recordRetentionDays: 365
        types:
          - key: default
            name: General support
            staffRoles: [support]
            category: helpdesk
            logChannel: support-log
            defaultLabels: [question]
            fields:
              - {label: What happened?, required: true}
          - key: appeals
            name: Moderation appeal
            staffRoles: [appeal-reviewers]
            category: appeals
            logChannel: appeals-log
```

Use the role, category and channel keys from the server declaration. Configure the bot's Server Members and Message Content intents in the Discord Developer Portal. Members shared by multiple eligible servers choose a server before their first DM reaches a ticket. The bot remembers their choice for 24 hours and checks membership again before delivery.

At close, the portal offers chronological HTML and Markdown downloads. The configured log receives both files only when its audience is equal to or narrower than the ticket channel. Staff need the role for that ticket type and read access. The portal checks authorization on every request, including downloads.

Transcript retention is 1–365 days. Ticket records, notes and indexes expire after the longer of transcript and record retention. Privacy export includes the requesting member's data. Erasure anonymizes authored records and transcript lines, removes member indexes and retracts tracked bot copies. Ticket ratings are collected by DM or through the member portal.

The plugin publishes `opened` and `closed` at the corresponding transitions and `rated` when the first satisfaction rating arrives. Optional grants enable on-duty mentions (`plugins.query:staff-shifts.onDuty`), staff case context (`plugins.query:moderation.cases`), and case-specific appeal updates (`events.subscribe`). The `openFor` query checks the acting member's ticket access. The `open` action accepts a caller idempotency key.
