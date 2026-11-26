# Knowledge assistant

An **experimental**, off-by-default plugin for answering community questions from reviewed sources. It stays experimental until usage is confirmed with three target communities (the specification's usage gate). Requires Cicord 0.2.0. The minimal disabled configuration is `{enabled: false}`.

```yaml
- name: assistant
  source: cicord/ai-assistant
  version: ^0.1.0
  grants:
    [
      storage.kv,
      storage.index,
      scheduler,
      discord.channels.read,
      discord.members.read,
      discord.messages.send,
      files.read,
      portal.routes,
      http.fetch,
    ]
  files: ["knowledge/**/*.md"]
  secrets:
    API_KEY: { secretRef: CICORD_COMMUNITY_ANTHROPIC }
  config:
    enabled: true
    documentBaseURL: https://docs.example.org/
    fallbackContact: { text: Help desk, url: https://community.example.org/help }
    maxOutputTokens: 800
    dailyTokenBudget: 500000
    minRelevance: 0.35
    # model: claude-haiku-5-5
    # allowedRoles: [members]
    # excludedRoles: [opted-out]
```

Set the bound credential in the admin console or operator secret store. Select a model enabled for your Anthropic account. The host injects `API_KEY` only on approved HTTPS requests to `api.anthropic.com`. A missing key degrades the instance and questions receive the human-contact fallback.

Markdown headings define sections. Optional frontmatter accepts `title` and a source `channel` key. Only mount approved files. Sections without a channel are public to the installation. Citation links append the repository-relative path to `documentBaseURL`. Each revision rebuilds the index. Questions re-read the current file and recheck viewer permissions before sending evidence to the provider. The assistant accepts only an exact quotation of a supplied section. Uncited, malformed and unsupported responses trigger the fallback.

`/ask question` defers the original interaction privately and hands work to a durable runtime task. The host keeps the reply credential encrypted, bound to this installation and reviewed code, for at most 14 minutes. The queue contains only a request ID and erasure subject; pending questions remain in owner-scoped storage. Restart before execution resumes the task. A durable execution claim prevents a second provider charge after an ambiguous outcome; such a task is not executed again. On retry, the host gives a private interruption notice when no reply was attempted. An ambiguous Discord reply is left unchanged to avoid overwriting an answer that may already have arrived. Current member and source access are checked before delivery. The original member identity remains attached to the request. For mentions and configured help channels, add `discord.messages.read` and approve the optional message intents. Gateway questions are queued by message ID. Role filters, channel access, opt-out and the per-member and per-channel cooldowns are applied before a gateway question is queued; a refused or rate-limited message gets no reply and no typing indicator, so the assistant never repeats spam in a help channel. `/ask` reports a refusal privately. Staff may opt in individual solved posts from configured `solvedForums` through the portal. Their current access and contents are checked on retrieval. Per-member and per-channel cooldowns and atomic daily reservations cap provider use. Reservations are reconciled to returned usage. A call is retried once, after a short backoff, only when Anthropic refused it before any generation: `529` overloaded, or a `429` rate limit with `retry-after`. A spend-cap `429` (no `retry-after`) and the host budget refusal are not retried. `500` and other errors, timeouts and transport failures may have been charged and are never retried. A question runs within the 10-second task deadline: the provider gets the remaining time minus two seconds kept for the final access checks and the reply, and no call (or retry) starts with less than two seconds left. All installations of this registry plugin on the same Discord server share the daily ledger. The lowest configured active cap wins. The host reserves the UTF-8 text upper bound plus framing and the maximum output before contacting Anthropic, then reconciles the provider’s reported use. An ambiguous transport failure keeps the reservation until UTC rollover.

Grant `plugins.query:tags.search` to include readable tags with a citation URL. Grant `plugins.call:tickets.open` to offer support tickets. The configured human contact is always available. A private source keeps its channel audience, including during escalation. The provider receives the question and eligible passages. It receives no tools or moderation authority.

`/ask optout` disables further processing. Opt-out lasts until changed. Rate limits expire automatically. Support handoffs expire after 15 minutes. Opt-in unanswered questions and feedback expire after seven days, solved post excerpts after 30 days. Privacy hooks erase member records, pending question/help tasks, host reply receipts and indexed solved posts. Restored queued work is checked against durable erasure markers before delivery. Staff review routes check current channel visibility. [Capabilities and privacy inventory](./plugin.yaml) · [Portal contract](./src/routes.ts)
