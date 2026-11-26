# Tags

Staff can curate short answers in Markdown and through the moderator portal API. Members can use `/tag`, an optional mention or the **Reply with a tag** message menu. Requires Cicord 0.2.0. Installing with `config: {enabled: false}` keeps all responses disabled.

```yaml
- name: tags
  source: cicord/tags
  version: ^0.1.0
  grants:
    [
      storage.kv,
      discord.messages.send,
      discord.channels.read,
      discord.members.read,
      portal.routes,
      files.read,
    ]
  files: ["tags/**/*.md"]
  config:
    enabled: true
    editableOnPortal: true
    # channels: [help]
    # debounceSeconds: 60
```

For a portal-only pilot, omit the file grant and glob. To enable automatic keyword replies, grant `discord.messages.read`, approve `MessageContent` for the bot and list the destination channels. Empty channel lists disable automatic replies.

```markdown
---
name: Restore access
aliases: [login, reset]
keywords: [locked out]
url: https://docs.example.org/access
channel: support
---

Open the recovery page and choose “Restore access”.
```

Supported frontmatter fields are `name`, `aliases`, `keywords`, `url` and the optional source channel key. File-backed names take precedence. An invalid file or a duplicate name stops the instance at startup. Every command, auto-reply, portal route and `tags.search` call reads the catalog from the bound files and the stored portal tags, so a provider call sees the same catalog as the plugin's own routes, and a revision or portal edit applies to the next call, including deletions. The member catalog and `tags.search` check the current viewer (`onBehalfOf` for interop calls) before returning a restricted tag. Public channel replies also check that the destination audience fits the source. Calls without a member identity, such as a partner's tasks or event handlers, receive only unrestricted tags.

The typed routes provide a member search and moderator-only PUT/DELETE operations. A concurrent edit of the same tag is refused with status 409. Portal editing requires `editableOnPortal`. The current catalog permits 1,000 portal entries, each up to 1,800 characters. Tag text, channel restrictions and per-tag usage counters last until removed by staff or the installation is deleted. Counters record no member identity. [Route types](./src/routes.ts) · [Search contract](./contracts/search.v1.json) · [Capabilities](./plugin.yaml)
