# Contributing a plugin

Community plugins are welcome. A plugin accepted here is installable from every Cicord
runtime as `cicord/<name>`, so it is reviewed like code that runs on thousands of Discord
servers. Read this before opening a pull request.

## Submit

1. Fork this repository and add `plugins/<name>/` (start from `cicord plugin new`):
   `plugin.yaml`, `config.schema.json`, `src/`, `test/` (unit tests with
   `@cicord/sdk/testing`), and `tsconfig.json` like the other plugins.
   `<name>` is `metadata.name`: lowercase letters, digits and dashes, not taken.
2. Run `bash scripts/check-plugin.sh plugins/<name>` (the CI runs the same).
3. Open a pull request and fill in the template, in particular **why** each capability,
   intent and network host is needed.
4. Do not edit `index.yaml`, `index.yaml.sig` or tags: maintainers release accepted plugins.

Changes to an existing plugin bump `metadata.version` (semver: a breaking config or behaviour
change is a new major version) and keep its unit tests passing.

## Review rules

A pull request is merged when two maintainers approve it (one for a fix to an existing
plugin) and the checks pass. Reviewers check that:

- the code is readable source: no obfuscated, minified or generated code (except
  `src/cicord-env.d.ts`, written by `cicord plugin typegen`), no encoded payloads, no code
  loaded at run time;
- the plugin only does what its description says: no telemetry, no tracking, no calls home,
  no collection of message content or member data beyond its feature, and stored data is
  limited to what it needs;
- user-facing text is clear, configurable where it is posted to members, and never
  impersonates Discord, the server staff or another bot;
- the config schema has safe defaults, documents every field, and references Discord
  resources with `x-cicord-ref` (never raw IDs typed by hand);
- unit tests cover its commands, components, events and portal routes;
- the license of every contributed file is compatible with Apache-2.0.

## Permissions policy

What a plugin requests is shown to every admin before install; ask for the least.

- **Capabilities**: only those the code uses, each justified in the pull request.
  `discord.members.manage`, `discord.members.moderate`, `discord.channels.manage` and
  `discord.messages.manage` (moderation-grade powers) need a feature that cannot work
  without them.
- **Gateway intents**: privileged intents (`ServerMembers`, `MessageContent`) are
  accepted only when the feature needs them and the description says so. A plugin that reads
  message content must explain what it reads and keep nothing it does not need.
- **Network** (`http.fetch` with `spec.network.allow`): explicit hosts, each justified; a
  `*.example.com` wildcard only for a service that really spreads over subdomains; no URL shorteners, paste sites or generic proxies. Secrets
  (API keys) come from the plugin config, never from the code.
- **Portal routes** that change state check the member's identity and the plugin's own
  rules; routes that expose data only expose what the member may see on Discord.

A new capability, intent or host in an update is reviewed like a new plugin, and is shown to
admins as new before they update.

## Verified publishers

`publisher` names who maintains a plugin; `verified: true` marks a publisher whose identity
the maintainers checked. It is set by maintainers in `index.yaml`, never by a pull request,
and the runtime only honours it from this signed index. To become verified, a publisher:

- is a GitHub organization or user with two-factor authentication, linked from the plugin's
  documentation and reachable for security reports;
- has at least one plugin accepted here and maintained (issues answered, fixes released);
- agrees to the review rules above for every release.

Verification is withdrawn when these stop being true or after a security incident. A
plugin with a serious unfixed issue is removed from `index.yaml` (runtimes stop offering
it; installed copies keep their locked version until their admins act).

## Security issues

Do not open a public issue: see [SECURITY.md](SECURITY.md).
