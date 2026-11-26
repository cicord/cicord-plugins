# Cicord plugins

The official plugin registry of [Cicord](https://github.com/cicord/cicord), the GitOps
runtime for Discord: the plugins maintained by the Cicord project and community plugins
accepted by review, in one repository, with a **signed** index.

## Plugin catalogue

Descriptions cover the source on this branch. Published versions come from the signed registry. Bundled versions identify the offline copies in the matching core source tree. Released binaries carry the versions embedded at build time. A dash means that distribution has no entry for the plugin.

| Plugin | What it does | Published | Bundled |
|---|---|---|---|
| [`ai-assistant`](plugins/ai-assistant) | Answers questions from approved Markdown, checks the reader’s access to citations and caps provider spending. Opt-in pilot. | — | — |
| [`announcements`](plugins/announcements) | Schedules one-off and recurring announcements in a configured time zone with controlled mentions, pinned messages and crossposting. | 0.1.0 | 0.1.0 |
| [`anti-nuke`](plugins/anti-nuke) | Monitor administrative changes using audit evidence. Staff can inspect uncertain, delayed and confirmed observations. | — | — |
| [`audit-log`](plugins/audit-log) | Sends staff evidence-backed observations of server changes and message deletions, with attribution, privacy controls and optional search. | 0.1.0 | 0.1.0 |
| [`birthdays`](plugins/birthdays) | Opt-in birthday greetings and 24-hour roles using each member’s local date. | — | — |
| [`channel-automations`](plugins/channel-automations) | Per-channel thread, reaction, publication, media and cleanup rules. | — | — |
| [`community-events`](plugins/community-events) | Recurring Discord events, attendance and opt-in reminders with a public calendar feed. | — | — |
| [`economy`](plugins/economy) | Maintains server wallets and an atomic ledger for daily claims, transfers, engagement rewards and shop purchases. Opt-in pilot. | — | — |
| [`feeds`](plugins/feeds) | Announces new RSS, Atom and JSON Feed entries in configured channels. | — | — |
| [`github-releases`](plugins/github-releases) | Announces releases from selected GitHub repositories. Members can look up release notes with the changelog command. | 0.1.0 | — |
| [`giveaways`](plugins/giveaways) | Runs weighted prize draws with a published seed commitment, eligibility checks, claims and independently verifiable results. Opt-in pilot. | — | — |
| [`guard`](plugins/guard) | Detect unsafe links, repeated messages and join surges. Message content is inspected transiently. Monitoring is the default. | — | — |
| [`invite-tracker`](plugins/invite-tracker) | Compares invitation counters on join, records attribution confidence and ranks valid invitations. | — | — |
| [`levels`](plugins/levels) | Awards XP for chat, reactions, voice minutes and community events. Includes role rewards, season archives and an indexed leaderboard. | 0.1.0 | 0.1.0 |
| [`member-roles`](plugins/member-roles) | Timed grants, sticky roles, membership milestones and booster benefits. | — | — |
| [`moderation`](plugins/moderation) | Handles warnings, timeouts, bans, quarantines and reviewed purges. Tracks cases, staff notes and scoped appeals. | 0.1.1 | 0.1.1 |
| [`onboarding`](plugins/onboarding) | Guides members through portal onboarding and their role choices with a personalized Discord link. | 0.1.0 | 0.1.0 |
| [`polls`](plugins/polls) | Runs native Discord polls and button or select ballots, closes them on schedule and publishes versioned results for reward plugins. | 0.1.1 | 0.1.1 |
| [`reaction-roles`](plugins/reaction-roles) | Keeps role panels up to date and lets eligible members select roles with buttons, menus or emoji reactions. | 0.1.1 | 0.1.1 |
| [`reminders`](plugins/reminders) | Private and channel reminders with local dates, repeat intervals and snooze. | — | — |
| [`staff-shifts`](plugins/staff-shifts) | Staff duty roles, weekly shifts, timezone-aware coverage and moderation statistics. | — | — |
| [`starboard`](plugins/starboard) | Highlights starred messages, compares source and destination audiences and removes invalidated copies. | — | — |
| [`stats-reports`](plugins/stats-reports) | Weekly and monthly aggregate activity reports, short-stay counts and voice channel counters. | — | — |
| [`suggestions`](plugins/suggestions) | Collects proposals and editable votes, publishes decisions and rechecks access to the public and staff boards. | — | — |
| [`tags`](plugins/tags) | Find and share reviewed Markdown replies and staff-managed answers. | — | — |
| [`tickets`](plugins/tickets) | Runs private support queues with type-specific staff, forms, portal replies, transcripts, satisfaction ratings and optional modmail. | 0.2.1 | 0.2.1 |
| [`verification`](plugins/verification) | Member-bound challenges, age checks and a staff approval queue. Role assignment uses the existing server permission policy. | — | — |
| [`voice-rooms`](plugins/voice-rooms) | Creates temporary voice rooms when members enter a hub. Owners can set a limit, lock, transfer or claim a room. Empty rooms are removed. | 0.1.0 | 0.1.1 |
| [`welcome`](plugins/welcome) | Greets new members with optional graphics and role assignment, and links members to onboarding. | 0.1.1 | 0.1.1 |

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

A bundled install copies the core catalogue version into `plugins/<name>/` in your repository. The signed registry can supply a newer published version. To test branch source before publication, copy the plugin directory into your repository, set the bot instance’s `source` to its local path and grant the required capabilities.

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
bash scripts/check-all.sh --allow-unlisted   # full checks for a development branch
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

Copyright 2026 Cicord team. [Apache-2.0](LICENSE). Each plugin is under the same license
unless its directory says otherwise.

The plugins are provided "AS IS", WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
or implied, including, without limitation, any warranties or conditions of title,
non-infringement, merchantability or fitness for a particular purpose. In no event shall the
Cicord team or its contributors be liable for any claim, damages or other liability arising
from the use of or the inability to use them. See sections 7 and 8 of the [License](LICENSE).
