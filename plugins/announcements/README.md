# Announcements

```yaml
timeZone: Europe/Paris
channels: [general, news]
crosspost: true
announcements:
  - name: weekly
    channel: news
    cron: "0 18 * * 5"
    content: "Our weekly meeting starts now."
stickies:
  - channel: general
    message: "Read the community guide before posting."
    afterMessages: 10
```

All settings have defaults. Recurring schedules support `cron`, `every` and `at`, with a bounded catch-up window. Staff with Manage Messages can compose, list or cancel scheduled messages. The portal offers staff-only `POST /preview`, `POST /compose` and `GET /scheduled`. The editor accepts the destination channel ID, text, optional title, ISO timestamp and a `layout` toggle for Components V2. The list and preview check current channel read access.

`/countdown create title date channel [milestones]` publishes a countdown and updates it every five minutes, then every minute in the final hour. The local date uses `YYYY-MM-DD HH:MM`. Milestones default to `7d,1d,1h`. A milestone missed by less than an hour is marked late, and older milestones are skipped. Enable countdowns with `discord.messages.read`.

Stickies require the messages intent, read/manage grants and Discord pin permissions. A burst accumulates until a single refresh after the 30-second debounce. Only configured announcement channels are crossposted. Discord crosspost refusal is logged and the original local post remains accessible. Replayed posts use an enforced nonce and a persisted occurrence record.

Drafts expire after 15 minutes. Authored messages and explicit mentions remain only until posting, cancellation or erasure. A member export contains their pending drafts and posts and a reference for mentions made by others. Erasure cancels authored messages and removes the member from other pending mention lists. Set `enabled: false` to disable the instance.

For scheduled embed posts, grant `discord.messages.read` so an uncertain delivery can find its original receipt in the destination history after a long interruption. History is reconciled three pages at a time. With Components V2, a send whose outcome is still unknown beyond Discord's nonce window requires staff review in dead letters.
