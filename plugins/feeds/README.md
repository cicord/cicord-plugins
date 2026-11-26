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
        # backlog: 1
        # mentionRole: readers
```

The example uses a placeholder domain. Use a feed's actual public HTTPS host. The runtime validates configured URLs against the reviewed hosts. It also checks public DNS addresses and redirect destinations at request time. Every permission is explained in [plugin.yaml](./plugin.yaml). Only the configured role can receive a ping.

Each feed keeps its due time, error count and published GUIDs in instance KV. Changing the title or restarting Cicord preserves deduplication. A cron tick every five minutes starts one durable check per due feed, so a slow feed never delays the others. Each check publishes at most eight entries, oldest first, and parses at most 500 entries from a 1 MiB response. Errors delay that feed for 5, 10, 20, 40, then 60 minutes. Other feeds continue. Consult the instance status for backoff and delivery notices.

The first successful check of a feed records the entries already in it as seen without posting them. `backlog` (0 to 8, default 0) publishes that many of the newest existing entries instead. Changing a feed's `id` starts a new feed, so its existing entries are recorded again rather than posted.

Each entry gets a Discord nonce when its send starts. When a send fails ambiguously (timeout, server error, rate limit) or the run is cut by the handler deadline, the scheduler retries the check within seconds with the same nonce, and Discord returns the original message instead of posting a duplicate. A claim older than one minute could already be in the channel: the entry is marked uncertain, never sent again, logged, and named in a status line. When Discord refuses the channel for good (missing permissions or access, unknown channel, missing grant), the check stops, the entry stays unsent, the status line names the problem, and the next check retries it. When Discord rejects one entry itself (for example an invalid or too long message), that entry is marked failed and never sent again, the status line names it, and the following entries are still published. A delivery status line is cleared when a later check delivers an entry. Deduplication records last for the life of the installation. This plugin has no member records or inter-plugin contracts.
