# Economy

Economy is an opt-in pilot for Cicord 0.2.0. An empty configuration disables it. Enable the pilot after validating demand with three target communities. Points are internal to the server.

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

Members can use `/balance`, `/daily`, `/weekly`, `/pay`, `/leaderboard`, `/shop`, `/buy` and `/inventory`. Managers use `/eco give|take|set`. Claims reset at midnight in the configured time zone. The week begins on Monday. Transfer fees are credited to a server treasury account. The amount debited equals the recipient’s credit plus the fee. Earned points share a daily cap across event sources.

The wallet, the journal entries for each side of a transfer, its claim or purchase receipt, and the corresponding leaderboard scores share one checked transaction. Replayed operation IDs return the existing balance. A purchase records the selected product and charged price. The fulfillment task verifies permanent role membership or uses a stable action key for a temporary role or staff perk. A missing shop integration hides the affected product before a debit.

Member routes expose `/wallet`, `/history` and `/shop`. Moderators can inspect `/ledger`. The plugin serves `balance`, `credit` and `debit` and publishes `transaction`. Optional earnings include chat, voice minutes, level-ups, poll votes, approved suggestions, highlights, birthdays, attendance and closed tickets. Optional message and voice intents activate only their respective sources. The provider and grants required for each optional product are listed in the manifest.

The member export includes their balances, claims, inventory and journal rows. Erasure removes those rows and the leaderboard entry. The recipient of a transfer retains their own amount and balance. Each side’s row identifies only its account. `journalDays` sets journal and transfer-receipt retention to 365 days by default, with a 31-day minimum.
