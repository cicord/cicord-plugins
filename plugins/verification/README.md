# Verification

Declare server permissions in YAML so new arrivals can see the verification channel and the verified role grants community access. Give the bot a role above the verified role. Publish or update the channel panel with `/verify-panel`. Its button creates an authenticated challenge link for the member who pressed it.

```yaml
panelChannel: verify
verifiedRole: verified
method: visual
locale: en
minAccountAgeDays: 3
youngAccount: hold
kickAfterHours: 0
```

The button method checks account age. When visual rendering is granted, accounts with a default avatar receive a visual challenge even in button mode. The visual method renders an image via the optional `render` grant. Provider methods require a public site key (`turnstileSiteKey` or `hcaptchaSiteKey`), the optional `http.fetch` grant and a host-bound instance secret. Set `TURNSTILE_SECRET` for challenges.cloudflare.com or `HCAPTCHA_SECRET` for api.hcaptcha.com. The member’s browser submits the provider token to the portal. The host injects the opaque secret into the verification form sent to the configured provider. Missing credentials appear in instance status and activate the available local fallback. Provider failures return a generic challenge failure.

Verification assigns only `verifiedRole`. The `hold` policy puts young members in the moderator queue. With `delay`, they retry after `delayHours`. The explicit `kick` policy and optional `kickAfterHours` expiry need the DM and sanction grants. Held accounts await staff review. A kick sends the earliest return time and a one-day recovery link bound to that person’s OAuth identity. Unknown account-age information never triggers an age sanction.

When moderation is installed, grant `plugins.call:moderation.sanction`. An absent installation permits direct kick with `discord.members.moderate`. The plugin preserves a stable origin key for delegated kicks. The member query and successful role assignment use current Discord membership. `passed` and `failed` events support welcome and guard integrations.

## Portal and commands

Members use `GET /challenge` to start or inspect their challenge, then `POST /challenge` with its ID and visual answer or provider token. The authenticated member is always the subject. Staff use `GET /queue`, `POST /queue/:id` with an approve or deny decision, or `/verify approve|deny user`. `/verify status user` permits self and staff lookups. A signed case session permits its subject to inspect `GET /return/:id` after leaving the guild. Set `locale: fr` to display French interaction and notification messages.

## Data retention

Result, method and decision time expire after 30 days. Pending and age-review records expire after 30 days. The visual answer and challenge ID expire after three minutes and are consumed atomically. A five-failure limit lasts five minutes. A role grant in progress can resume for one day. Delivery of a recorded result retries for up to 30 days. Discord roles continue to represent live access after decision records expire. Privacy export and erasure cover the member’s result, pending state, challenge and rate limit. Provider response tokens, IP addresses and browser fingerprints are never stored.
