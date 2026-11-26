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
      grants: [discord.messages.send, discord.messages.read, discord.channels.read, discord.channels.manage, discord.members.read, storage.kv, portal.routes, portal.links, events.publish, scheduler,
               discord.dm.send, discord.messages.manage]  # optional: modmail and rating DMs; transcript files
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
            retainSourceForTranscript: true
            defaultLabels: [question]
            fields:
              - {label: What happened?, required: true}
          - key: appeals
            name: Moderation appeal
            staffRoles: [appeal-reviewers]
            category: appeals
            logChannel: appeals-log
```

The last two grants are optional features:

- `discord.dm.send` enables `modmail` (with the `DirectMessages` intent) and `ratingPrompts`. Without it, DMs do not open tickets and members rate closed tickets on the portal only.
- `discord.messages.manage` enables `managedMessages`. Without it, log channels receive the content-free summary and portal link but never transcript files, and erasure overwrites the bot's copies with neutral text instead of deleting them. If the erased member wrote in a retained read-only source channel, that channel is deleted. Removing a grant later does not drop receipts: files that were already attached, and DM copies that need retraction, are kept and named in the instance status until the grant returns.

The instance status names each missing grant. It also reports a configured `modmailType` that cannot work, a type log channel that cannot get files, duplicate type keys (the first definition is used) and an unknown `modmailType`. None of these stop the instance.

The English and French catalogs cover commands, forms, replies and transcripts. Set `locale: fr` for an instance-wide language. Custom panel text, welcome templates, type names and form labels are preserved.

Use the role, category and channel keys from the server declaration. Configure the bot's Server Members and Message Content intents in the Discord Developer Portal. Members shared by multiple eligible servers choose a server before their first DM reaches a ticket. The bot remembers their choice for 24 hours and checks membership again before delivery.

At close, the portal offers chronological HTML and Markdown downloads. Typed queues retain the original channel read-only until transcript expiry by default. Set `retainSourceForTranscript: false` to delete it at close and keep a content-free portal link. The legacy general queue also deletes the channel at close. Once the original policy is gone, the portal denies transcript downloads. While its original read policy remains verifiable and the log audience is equal or narrower, the bot attaches both files. Gateway availability (also after a restart), permission changes and periodic reconciliation recheck both channels. Each invocation handles a bounded page of tracked copies, and follow-up tasks handle the rest. If either policy becomes unverifiable, the bot removes the file-bearing message and keeps a portal link. Staff need the role for that ticket type and read access. The portal checks authorization on every request, including downloads.

Transcript retention is 1–365 days. Ticket records, notes and indexes expire after the longer of transcript and record retention.

The minute maintenance job never lists every ticket. It takes at most 25 tickets per run, in order of their next due time: provisioning retries, first-response reminders, inactivity warnings and auto-close, transcript expiry and record deletion. It also takes one page of pending relays and one page of tracked log copies, and resumes from a cursor on the next run. The indexes live in KV schema 2 (`meta:schema`). After an upgrade from 0.2.x or 0.4.0, a `reindex` task indexes the existing records 20 at a time, resumes after a restart and runs again when the timing or retention settings change. Privacy hooks read the tickets that name the member (an involvement index that includes `<@id>` mentions and transcript authors). Erasure also reads every open ticket, so messages in a live channel are hidden from a later transcript. `GET /tickets` is paged, newest first: a page holds at most 50 tickets and reads at most 500 records by number, so a selective filter can return a short page with a `cursor` to pass back as `?cursor=` (absent on the last page). `GET /tickets?status=open` reads only open tickets. Until the migration finishes, the privacy hooks read every record as before, ratings statistics only count indexed tickets, and an `open` retry is matched against the 100 newest tickets. Privacy export includes the requesting member's data. Erasure anonymizes authored records and transcript lines, removes member indexes and retracts tracked bot copies. Ticket ratings are collected by DM or through the member portal.

The plugin publishes `opened` and `closed` at the corresponding transitions and `rated` when the first satisfaction rating arrives. Optional grants enable on-duty mentions (`plugins.query:staff-shifts.onDuty`), staff case context (`plugins.query:moderation.cases`), and case-specific appeal updates (`events.subscribe`). The `openFor` query checks the acting member's ticket access. The `open` action commits a ticket ID and schedules Discord channel provisioning after the action commits. A retry with the same idempotency key from the same calling installation returns the original ID. A direct receipt finds it without a scan, and the receipt, the member's open-ticket slot and the record are committed together, so concurrent duplicates also get one ticket. Policy refusals (unknown type, missing author or staff, open-ticket limit, a key reused for another member) are `denied` interop errors. The channel ID becomes available on the ticket detail route after provisioning.
