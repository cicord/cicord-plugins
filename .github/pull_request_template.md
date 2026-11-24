<!-- Thanks for contributing! Read CONTRIBUTING.md first. -->

## What

- [ ] New plugin `plugins/<name>/`
- [ ] Change to an existing plugin (`plugins/<name>/`, version bumped in `plugin.yaml`)
- [ ] Repository tooling or docs

## Permissions

<!-- For a new plugin, or when a change adds any of these: why each one is needed. -->

- Capabilities:
- Gateway intents (privileged ones in bold):
- Network hosts (`spec.network.allow`):

## Checklist

- [ ] `bash scripts/check-plugin.sh plugins/<name>` passes locally
- [ ] Unit tests cover the commands, events and routes the plugin adds
- [ ] No obfuscated, minified or generated code (except `src/cicord-env.d.ts`)
- [ ] I agree to license my contribution under Apache-2.0
