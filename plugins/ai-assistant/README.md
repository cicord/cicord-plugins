# Knowledge assistant

An off-by-default pilot for answering community questions from reviewed sources. Keep general rollout gated on confirmed demand from three target communities. Requires Cicord 0.2.0. The minimal disabled configuration is `{enabled: false}`.

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

`/ask question` acknowledges privately with a human-contact link and queues the provider call. The task sends a private follow-up. A restart drops the short-lived interaction handle and question; the original contact link remains available. For mentions and configured help channels, add `discord.messages.read` and approve the optional message intents. Gateway questions are queued by message ID. Staff may opt in individual solved posts from configured `solvedForums` through the portal. Their current access and contents are checked on retrieval. Per-member and per-channel cooldowns and atomic daily reservations cap provider use. Reservations are reconciled to returned usage, with one short retry on transient failures. All installations of this registry plugin on the same Discord server share the daily ledger. The lowest configured active cap wins. The host reserves the UTF-8 text upper bound plus framing and the maximum output before contacting Anthropic, then reconciles the provider’s reported use. An ambiguous transport failure keeps the reservation until UTC rollover.

Grant `plugins.query:tags.search` to include readable tags with a citation URL. Grant `plugins.call:tickets.open` to offer support tickets. The configured human contact is always available. A private source keeps its channel audience, including during escalation. The provider receives the question and eligible passages. It receives no tools or moderation authority.

`/ask optout` disables further processing. Opt-out lasts until changed. Rate limits expire automatically. Support handoffs expire after 15 minutes. Opt-in unanswered questions and feedback expire after seven days, solved post excerpts after 30 days. Privacy hooks erase member records, pending help tasks and indexed solved posts. Staff review routes check current channel visibility. [Capabilities and privacy inventory](./plugin.yaml) · [Portal contract](./src/routes.ts)
