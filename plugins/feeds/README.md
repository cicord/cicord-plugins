# Feeds

Publishes new RSS, Atom and JSON Feed entries. Requires Cicord 0.2.0. The pilot defaults to `enabled: false`. Configure the reviewed destination hosts on the instance in `bot.yaml`.

```yaml
- name: news
  source: cicord/feeds
  version: ^0.1.0
  grants: [storage.kv, scheduler, http.fetch, discord.channels.read, discord.messages.send]
  network:
    allow: [news.example.org]
  config:
    enabled: true
    pollMinutes: 15
    feeds:
      - id: project
        url: https://news.example.org/feed.xml
        channel: general
        keywords: [release]
        template: "{role} **{title}**\n{url}"
        # mentionRole: readers
```

The example uses a placeholder domain. Use a feed's actual public HTTPS host. The runtime validates configured URLs against the reviewed hosts. It also checks public DNS addresses and redirect destinations at request time. Every permission is explained in [plugin.yaml](./plugin.yaml). Only the configured role can receive a ping.

Each feed keeps its due time, error count and published GUIDs in instance KV. Changing the title or restarting Cicord preserves deduplication. Each check publishes at most eight entries and parses at most 500 entries from a 1 MiB response. Errors delay that feed for 5, 10, 20, 40, then 60 minutes. Other feeds continue. Consult the instance status for backoff and uncertain sends.

A GUID is reserved before sending. If Discord accepted a message but its acknowledgement was lost, the reservation prevents a duplicate. If the send failed before Discord received it, an operator must review the channel and deliver the missed entry manually. Deduplication records last for the life of the installation. This plugin has no member records or inter-plugin contracts.
