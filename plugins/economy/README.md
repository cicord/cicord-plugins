# Economy

Economy is **experimental** and opt-in in Cicord 0.2.0. An empty configuration disables it. It stays experimental until usage is confirmed with three target communities (the specification's usage gate). Points are internal to the server.

```yaml
enabled: true
timezone: Europe/Paris
daily: 20
weekly: 100
streakBonus: 2
dailyCap: 1000
taxPercent: 2
minimumDays: 7
earnings: {poll: 5, level: 10}
shop:
  - {id: supporter, label: Supporter, price: 250, type: temporary, role: supporter, durationSeconds: 604800}
```

A `temporary` product is granted through member-roles (the optional `temporaryRole` feature, `plugins.call:member-roles.grantTemporary`). member-roles refuses roles that are not in its `temp.roles` list, and an empty list refuses every call from another plugin, so list each temporary product's role there. Otherwise the purchase is a definitive refusal and is refunded at once. The member-roles instance for the shop above:

```yaml
enabled: true
temp: {maxDays: 30, roles: [supporter]}
```

Members can use `/balance`, `/daily`, `/weekly`, `/pay`, `/leaderboard`, `/shop`, `/buy` and `/inventory`. Managers use `/eco give|take|set`. Claims reset at midnight in the configured time zone. The week begins on Monday. Transfer fees are credited to a server treasury account. The amount debited equals the recipient’s credit plus the fee. Earned points share a daily cap across event sources.

The wallet, the journal entries for each side of a transfer, the operation's idempotency receipt, its claim or order, and the corresponding leaderboard scores share one checked transaction. A replayed operation ID (an interaction, an event, or a caller's `credit`/`debit` key) changes nothing and returns the current balance. Receipts are kept for at least 400 days (or `journalDays`, if longer), independently of journal rows. Their key is a digest and their value a timestamp, so they hold no member ID in clear. Erasure keeps them, and a replay after an erasure or after the journal expires does not pay twice.

### Shop delivery

A purchase records the product and the price it charged. Delivery happens in the buyer's own `/buy` interaction or portal checkout request. That is where Cicord attaches the member as the call principal, which `tickets.open` requires. Background tasks carry no principal. A staff perk opens a ticket with the key `order:<order id>` and the subject and description frozen at purchase, so every retry is the same request. A permanent role is checked before it is added. A temporary role uses the same stable key with `member-roles`.

- **Delivered.** The order is complete.
- **Definitive refusal.** This covers a provider that is not installed, a call denied by a grant, an allow list or the provider itself, a call cycle, or an ambiguous provider configuration. The order is refunded at once. Its state, the restored balance and a `refund <product>` journal row share one commit.
- **Ambiguous failure** (a timeout, a provider error or a Discord error). The order stays pending, and the member is told to retry. Running `/buy <product>` again retries the pending order instead of charging again. `/inventory` and `POST /inventory/deliver` retry up to three pending orders, and so does reposting the same portal purchase UUID. Retries use the original key. A staff status line (`orders`) names the product and the error.
- **Background passes.** An hourly pass visits only the pending-order index. It retries roles and temporary roles. It never calls `tickets.open`, because it has no principal.
- **Refund window.** An order still undelivered 72 hours after purchase is refunded. A refund never overlaps a delivery attempt from the last minute.

An order whose product becomes unavailable is refunded at the next attempt. This happens when a grant is removed or the partner plugin is uninstalled. If a timed-out ticket request had in fact succeeded and the member never retries, the refund after 72 hours leaves both the ticket and the points. Staff can see this in the `refund` journal row. A product whose integration is missing is hidden before any debit. The `shop-products` status line names the missing grant or partner.

Member routes expose `/wallet`, `/history`, `/shop` and `POST /inventory/deliver`. The portal checkout posts a unique purchase UUID to `POST /shop/:id/buy`. Retrying that UUID returns the existing order. When a purchase is redirected to an earlier undelivered order, an alias makes later replays return that order. Moderators can inspect `/ledger`. The plugin serves `balance`, `credit` and `debit` and publishes `transaction`. `debit` spends a member's points. It accepts only calls made on behalf of the debited member, from a consumer's interaction or member route; a scoped portal session does not count. Any other call is rejected with `denied`. No official plugin calls `debit`. `credit` has no principal requirement, so background rewards such as giveaways can use it. Optional earnings include chat, voice minutes, level-ups, poll votes, approved suggestions, highlights, birthdays, attendance and closed tickets. Optional message and voice intents activate only their respective sources. Each voice session holds a per-join token, so leaving and rejoining keeps a single reward timer. The provider and grants required for each optional product are listed in the manifest. The `rewards` status line names every configured earning source that cannot pay, with the missing feature, grant, intent or publisher plugin. A closed poll whose event lists only part of its voters pays those voters when `pollPages` (`plugins.query:polls.voters`) is not granted, and the `poll-voters` line says so. With the grant, every voter is paid.

The member export includes their balances, claims, inventory, pending-order index and journal rows. Erasure removes those rows and the leaderboard entry. It keeps the idempotency receipts. Those are keyed by a digest of the account and operation, so no member ID appears in clear. They are pseudonymous rather than anonymous: anyone who knows both values can recompute the digest. The recipient of a transfer retains their own amount and balance. Each side’s row identifies only its account. `journalDays` sets journal retention to 365 days by default, with a 31-day minimum.
