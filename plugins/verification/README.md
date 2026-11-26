# Verification

Declare server permissions in YAML so new arrivals can see the verification channel and the verified role grants community access. Give the bot a role above the verified role. Publish or update the channel panel with `/verify-panel`. Its button creates an authenticated challenge link for the member who pressed it.

```yaml
panelChannel: verify
verifiedRole: verified
method: typed
fallback: review
locale: en
minAccountAgeDays: 3
youngAccount: hold
kickAfterHours: 0
```

The default `typed` method shows an image of a six-character code, drawn from the platform CSPRNG over an unambiguous 31-symbol alphabet (A-Z and 2-9, without 0/O and 1/I/L), with jittered glyphs and noise. The member types it; the answer is case-insensitive and must have the exact length and alphabet. The code stays in the plugin's storage for three minutes and never leaves it. A blind guess succeeds about once in 31^6 (one in 887 million). The `visual` method remains an option: a four-digit code to pick among twelve similar numbers, which a blind guess gets right one time in twelve. Three failures lock the challenge for 15 minutes, and six failures within a day send the member to the staff queue. Both image methods slow down scripts; they are not an anti-bot measure, since image recognition can read them. Use Turnstile or hCaptcha against automated accounts.

Both image methods need the optional `render` grant, and image rendering is experimental in Cicord 0.2.0. Without it, or when rendering fails, the challenge is never replaced by a silent pass. `fallback: review` (the default) sends new members to the staff queue, and `fallback: button` offers the one-click button. A missing grant sets the `challenge` status line, and a rendering failure sets the `render` line. The button method checks account age. When rendering is granted, accounts with a default avatar get the typed challenge even in button mode. Use Turnstile or hCaptcha against automated accounts. Provider methods require a public site key (`turnstileSiteKey` or `hcaptchaSiteKey`), the optional `http.fetch` grant and a host-bound instance secret. Set `TURNSTILE_SECRET` for challenges.cloudflare.com or `HCAPTCHA_SECRET` for api.hcaptcha.com. The member’s browser submits the provider token to the portal. The host injects the opaque secret into the verification form sent to the configured provider. Missing credentials appear in instance status and activate the available local fallback. Provider failures return a generic challenge failure.

Verification assigns only `verifiedRole`. The `hold` policy puts young members in the moderator queue. With `delay`, they retry after `delayHours`. The explicit `kick` policy and optional `kickAfterHours` expiry need the sanction grant: `plugins.call:moderation.sanction` when moderation is installed, else `discord.members.moderate`. Instance status names a missing grant at start. Without it, young accounts under `kick` go to the staff queue and expired pending members stay until the grant is added. A delayed member keeps the whole `kickAfterHours` window after their retry time, so expiry never kicks them before they could retry. Held accounts await staff review. With `discord.dm.send`, a kick first sends the earliest return time and a recovery link valid through the earliest return date plus one day, up to seven days, bound to that person’s OAuth identity. The notice is best effort: closed DMs or a missing DM grant never block the kick, and status says when notices are off. A member whose kick fails is retried on the next pass without holding up the others, and status reports the failures. Unknown account-age information never triggers an age sanction.

When moderation is installed, grant `plugins.call:moderation.sanction`. An absent installation permits direct kick with `discord.members.moderate`. The plugin preserves a stable origin key for delegated kicks. The member query and successful role assignment use current Discord membership. `passed` and `failed` events support welcome and guard integrations. The `status` query returns a verification flag to background callers. A delegated member can inspect their own status, and staff can inspect another member. Case-scoped sessions cannot read verification records.

## Portal and commands

Members use `GET /challenge` to start or inspect their challenge, then `POST /challenge` with its ID and the typed code (a string), the visual choice (a number) or the provider token. The authenticated member is always the subject. Staff use `GET /queue`, `POST /queue/:id` with an approve or deny decision, or `/verify approve|deny user`. `/verify status user` permits self and staff lookups. Set an optional server-owned Discord invitation in `returnInvite` to offer re-entry when the allowed time arrives. A signed case session permits its subject to inspect `GET /return/:id` after leaving the guild. Set `locale: fr` to display French interaction and notification messages.

## Data retention

Result, method and decision time expire after 30 days. Pending and age-review records expire after 30 days. The typed code or visual answer and the challenge ID expire after three minutes and are consumed atomically by every attempt. The three-failure lock lasts 15 minutes and the six-failure review counter one day. A role grant in progress can resume for one day. Delivery of a recorded result retries for up to 30 days. Discord roles continue to represent live access after decision records expire. Privacy export and erasure cover the member’s result, pending state, challenge and failure counters. Provider response tokens, IP addresses and browser fingerprints are never stored.

Turnstile and hCaptcha are checked against mocked provider responses only. An end-to-end run with the vendors’ public test keys has not been recorded yet. The plugin does not yet compare the provider’s `hostname` with the portal host.
