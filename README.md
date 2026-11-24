# Cicord plugins

The official plugin registry of [Cicord](https://github.com/cicord/cicord), the GitOps
runtime for Discord: the plugins maintained by the Cicord project and community plugins
accepted by review, in one repository, with a **signed** index.

| Plugin | What it does |
|---|---|
| [`welcome`](plugins/welcome) | Greets new members, gives them a default role and sends an onboarding link. |
| [`onboarding`](plugins/onboarding) | Step-by-step role picking on the community portal (games, platforms, notifications…), with a /onboarding command that links to it. |
| [`tickets`](plugins/tickets) | Support tickets in private channels. Members open a ticket from a panel button and a short form; staff and the member talk in a channel only they can see; closing it posts a summary to the staff log. |
| [`polls`](plugins/polls) | Quick polls with buttons or a select menu, live results, automatic closing and an optional discussion thread. Publishes polls.closed for other plugins. |
| [`levels`](plugins/levels) | XP and levels for chatting, receiving reactions and voting in polls. Level-up announcements, role rewards, /rank, /top, a daily recap and a public leaderboard on the community portal. |
| [`moderation`](plugins/moderation) | /warn, /timeout, /kick and /ban with an audit log, expiring warnings, automatic escalation, flood protection, member DMs and an optional Slack or Discord webhook. |
| [`reaction-roles`](plugins/reaction-roles) | Self-assignable roles from panels defined in the config, with buttons, a select menu or emoji reactions. Single or multiple choice, an optional required role, and panel messages kept up to date in place. |
| [`audit-log`](plugins/audit-log) | Posts server events to a staff log channel in compact batched embeds. Joins and leaves, role and nickname changes, message edits and deletions, moderation cases and closed polls from the other plugins. Each category can be turned off or sent to its own channel. |
| [`announcements`](plugins/announcements) | Recurring or one-off announcements from the config (cron, interval or date, in your time zone), and /announce for moderators to schedule, list and cancel their own. Mentions ping only who you say. |

## Install a plugin

Every Cicord runtime knows this registry: it is source `cicord`, with no `cicord.yaml` entry.

- **Admin console**: *Store* → source *cicord* → a plugin → *Install*. The Store shows what the
  plugin requests (capabilities, gateway intents, network hosts, config) before you confirm.
- **Command line**, in your Cicord repository:

  ```sh
  cicord registry search polls
  cicord plugin add cicord/polls --bot moderator
  ```

  This pins the version in `cicord.lock` (commit and content hash) and adds the instance to
  `bots/moderator/bot.yaml`; commit both. `cicord plugin update` lists and applies updates.

The official plugins are also **bundled in the `cicord` binary** (for offline and first
installs): a bundled plugin is installed by copying it to `plugins/<name>/` of your
repository, and this registry is used for a plugin only when its version here is newer than
the bundled one.

## Trust model

- **Signed index.** `index.yaml` lists the plugins; `index.yaml.sig` is an ed25519 signature
  envelope over its exact bytes, bound to this registry's URL, a serial that only goes up, and
  an expiry (30 days, re-signed weekly). The public keys are embedded in the Cicord runtime;
  a runtime ignores an index whose signature does not verify, has expired, names another
  registry, or is older than one it has already seen (no rollback). There is no fallback to an
  unsigned reading.
- **Pinned content.** Each entry names a plugin directory (`path: plugins/<name>`); releases
  are the tags `<name>/v<version>`, and `commit` pins the tag of the published version (a
  moved tag is refused). Installing locks the commit and a hash of the plugin directory in
  your `cicord.lock`; the runtime refuses content that does not match.
- **Review.** Every change to `main` is a reviewed pull request. The sign workflow signs what
  is on `main`, so `main`'s branch protection is what decides what becomes official. The
  signing key is a secret of this repository's `registry-signing` environment, used only by
  `.github/workflows/sign.yml`, never by pull request workflows.
- **Permissions are explicit.** A plugin only gets the capabilities, intents and network hosts
  it declares in `plugin.yaml`, and only once an admin grants them in `bot.yaml` (the Store
  asks). The review rules for what a plugin may request are in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Verified publishers.** `verified: true` in the index (set by maintainers only) marks a
  publisher whose identity the maintainers checked; the runtime honours it only from this
  signed index.

## Repository layout

```
plugins/<name>/          a plugin: plugin.yaml, config.schema.json, src/, test/, tsconfig.json
index.yaml               the registry index (written by `cicord plugin publish`)
index.yaml.sig           its signature (written by the sign workflow)
keys/official.pub        the official public keys (what the runtime embeds)
vendor/                  the @cicord/sdk package used by the unit tests
scripts/                 the checks the CI runs (check-plugin.sh, check-index.sh, verify.sh)
```

## Develop a plugin here

Requirements: Node 26, pnpm 12, and the `cicord` CLI on `PATH`.

```sh
pnpm install
bash scripts/check-plugin.sh plugins/polls   # SDK types, typegen, build, simulator, tsc, tests
pnpm test                                    # every plugin's unit tests
cicord dev --sim                             # in a Cicord repository using the plugin
```

`cicord plugin sdk-types plugins/<name>` writes the SDK types to `plugins/<name>/.cicord/`
(git-ignored) for editors and `tsc`.

## Maintainers

Releasing a plugin (after its pull request is merged, with `metadata.version` bumped):

```sh
git switch main && git pull
cicord plugin publish plugins/<name> --registry . --push --publisher <publisher>
git commit -m "index: <name> <version>" index.yaml && git push
```

`publish` validates the plugin, tags `<name>/v<version>`, pushes the tag and updates the
entry; the sign workflow then signs the new index. Set `verified: true` by hand for a verified
publisher.

Repository settings: the `CICORD_REGISTRY_SIGNING_KEY` secret (in the `registry-signing`
environment, restricted to `main`), the `CICORD_VERSION` variable (the Cicord release tag
the CI builds; the sign workflow refuses to run without one), `CICORD_SOURCE_TOKEN` while
github.com/cicord/cicord is private, the `@cicord/maintainers` team of `.github/CODEOWNERS`,
and branch protection on `main` (required reviews) that lets the sign workflow push
`index.yaml.sig`.

## License

[Apache-2.0](LICENSE). Each plugin is under the same license unless its directory says
otherwise.
