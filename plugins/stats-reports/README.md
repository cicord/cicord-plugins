# Statistics reports

Post aggregate weekly and monthly reports to a private staff channel. The hourly job checks the preceding complete UTC calendar week (Monday to Monday) and month. Reports include member arrivals and departures, daily active members, public-channel message counts, voice activity, invitations, moderation and the busiest posting time. Chart rendering is optional.

```yaml
staffChannel: reports
counters: [members.total, members.online, members.boosting]
```

Set `locale: fr` or `locale: en` to choose the report language, including period headings and UTC weekday labels. Enable server analytics and restrict `reports` to the intended staff members using Discord overwrites. The plugin withholds reports when the channel is public or its audience cannot be determined. Reports use the same aggregate reader as the Analytics page. Channel rankings include publicly visible channels only. An active-member distinct is daily, and the weekly value averages those daily counts.

## Short stays

The optional cohorts feature requires `discord.members.read` and ServerMembers. A join records its time under HMAC-SHA256 of the member ID, keyed by a random 32-byte secret that the instance creates in its own storage on the first observed join. Departure within seven days increases the original arrival day's early-departure count. The report shows this number with the number of observed arrivals in that period, as of publication. With collection disabled the report labels the figure unavailable. A join marker expires after 30 days, on departure or when the member requests erasure. Day counts contain no identifiers. The store never holds a raw member ID, but the secret sits in the same store: this is pseudonymization, not anonymization. Whoever can read the instance storage and knows a member ID can find that member's marker. Member export and erasure compute the same key. They never create the secret, and the secret is not exported. SHA-256 comes from fast-sha256 1.3.0 (public domain), included under `src/fast-sha256`.

## Delivery, counters and grants

Grant `analytics.read`, `discord.channels.read`, `discord.messages.send`, `discord.messages.read`, `scheduler` and `storage.kv`. Grant `render` for charts. The counters feature needs `discord.channels.manage` and permission to create and rename server voice channels. Public counter names expose only the selected aggregate. Each owned channel has at most two rename attempts within a rolling ten-minute window.

A persistent receipt reserves each period before sending. A retry within one minute uses the same Discord nonce. After that, the plugin checks a bounded recent history for its installation-specific marker. If the outcome cannot be established, the log records an unconfirmed report and the plugin stops automatic retries for that period. Report receipts expire after 400 days. Discord message retention follows the staff channel's policy.

Counter creation is reserved before calling Discord. After an interrupted creation the plugin keeps that metric blocked. A server administrator inspects Discord and runs `/stats-counter metric:<metric> checked:true`. Supply the existing owned voice channel to adopt it, or leave the channel empty only after verifying that Discord created none. The host verifies installation ownership before an existing channel can be adopted.
