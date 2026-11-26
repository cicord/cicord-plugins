# GitHub releases

Announces the releases of public GitHub repositories in Discord channels: one embed per
release with the release notes, a link to the release, its author, a pre-release badge when
it is one and an optional role ping. `/changelog` shows the latest release of a repository or
checks right away.

## Configuration

In `bots/<bot>/bot.yaml`, for the Cicord community server announcing
[github.com/cicord/cicord](https://github.com/cicord/cicord) releases in `#changelog`:

```yaml
plugins:
  - name: github-releases
    source: cicord/github-releases
    grants:
      - discord.messages.send
      - discord.channels.read
      - storage.kv
      - scheduler
      - http.fetch
    config:
      feeds:
        - repo: cicord/cicord
          channel: changelog          # channel key of servers/<server>.yaml
          label: Cicord               # shown instead of "cicord/cicord"
          mentionRole: updates        # optional: role key, pinged with each release
      pollMinutes: 15
```

`cicord plugin add cicord/github-releases --bot <bot>` (or the admin console's Store) adds the
instance and its grants; the channel and role are picked from your server's resources.

| Field | Default | |
|---|---|---|
| `feeds[].repo` | (required) | `owner/name` of a public repository. |
| `feeds[].channel` | (required) | Where its releases are announced. |
| `feeds[].includePrereleases` | `false` | Also announce pre-releases (with a 🧪 Pre-release badge). |
| `feeds[].mentionRole` | none | Role pinged in each announcement. Nothing else pings: the notes are in the embed. A role that is not mentionable needs the bot to have *Mention @everyone, @here and All Roles*. |
| `feeds[].label` | the repository | Display name in the titles (`Cicord v0.2.0`). |
| `pollMinutes` | `15` | How often each feed is checked (5–1440 minutes). |
| `announceExisting` | `false` | On a feed's first check, announce its recent releases (5 per check). Off: they are recorded as seen and only later releases are announced, so adding a feed does not flood the channel. |
| `color` | `#2da44e` | Embed color. |

The same repository can be listed twice, for instance stable releases in `#changelog` and
pre-releases in `#beta` with `includePrereleases: true`.

## How it works

- A tick every 5 minutes checks the feeds whose `pollMinutes` have elapsed, with
  `GET https://api.github.com/repos/<repo>/releases?per_page=10` (the 10 newest releases).
- The request sends the ETag of the last answer (`If-None-Match`): an unchanged list is a
  `304 Not Modified` with no body.
- Drafts are never announced; pre-releases only where `includePrereleases` is on.
- Releases published after the last one announced are announced oldest first, at most 5 per
  feed and check (the rest follow at the next checks). A pre-release skipped by a feed is
  still announced there if it is later marked as a full release. Progress is saved after each post, so a
  failed post is retried and a release is never announced twice. More than 10 releases
  published between two checks: only the 10 newest are seen.
- Long notes are cut to Discord's 4096-character embed limit with a *Read the full notes*
  link.
- A repository that answers 404 (missing, renamed or made private) is logged once and checked
  again at every poll. Network errors and unexpected answers are logged once until they change.
- Rate limits: a 403/429 rate-limit answer stops the check and every feed waits for
  `Retry-After`, or for `X-RateLimit-Reset` when `X-RateLimit-Remaining` is `0`, or else
  1 minute, then 2, 4… up to an hour.

## Rate limits

The plugin calls the GitHub API **without a token**. GitHub allows unauthenticated clients
**60 requests per hour per IP address**, shared by everything that calls GitHub from that
address (other instances of this plugin, other bots or tools on the server).

GitHub's documentation only exempts `304 Not Modified` answers from the rate limit for
authenticated requests. For unauthenticated ones, count every check: the ETag saves the
bandwidth and the processing, not the request. A check uses one request per feed, so
budget `feeds × 60 / pollMinutes` per hour:

| Feeds | `pollMinutes` | Requests per hour |
|---|---|---|
| 1 | 15 (default) | 4 |
| 5 | 15 | 20 |
| 10 | 30 | 20 |
| 20 | 60 | 20 |

The plugin logs a warning at start when its feeds use more than half of the 60 requests.
When the limit is reached anyway, it waits as GitHub asks and catches up afterwards. Nothing
is lost, because each check reads the 10 newest releases.

## Commands

Both subcommands need *Manage Server*. Discord sets command permissions per command, not
per subcommand. Server admins can open `/changelog` to more roles in *Server Settings →
Integrations*, and that opens both subcommands.

- `/changelog latest repo:<repository>`: posts the embed of the latest release of a
  configured repository in the channel, publicly. The repository autocompletes from the
  configured feeds, and other repositories are refused. The answer comes from the last check
  when there was one, so it costs no request.
- `/changelog check`: checks every feed now, without waiting for `pollMinutes`, and answers
  with a summary that only you see. Releases found are announced in their channels as usual.

## Permissions

| Capability | Why |
|---|---|
| `discord.messages.send` | Post the announcements. |
| `discord.channels.read` | Resolve the configured channels. |
| `storage.kv` | Per feed: the last release seen, the ETag and the last check. The rate-limit backoff. |
| `scheduler` | The polling tick. |
| `http.fetch` | GitHub's REST API, restricted to `api.github.com` (`spec.network.allow`). |

No gateway intents. The plugin reads no messages and no member data.

### Language and retention

Version 0.2.0 includes English and French for Discord messages and commands. Set `locale: fr` to override the interaction or server language. Set `enabled: false` to disable the feed without specifying repositories. The plugin stores public GitHub release data, each feed's cursor and the 30 most recently announced release IDs. It does not keep per-member Discord records. The GitHub feed cursor and recent-release state from 0.1 remain readable.
