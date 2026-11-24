# Official public keys

`official.pub` holds the public key(s) of the official registry, one base64 line each, as
printed by `cicord registry keygen`. They are the keys embedded in the Cicord runtime
(`internal/registry` `OfficialKeys`); the CI of this repository verifies `index.yaml.sig`
with them (`cicord registry verify --public-key`).

Public keys only. The private key never enters this repository: it is the
`CICORD_REGISTRY_SIGNING_KEY` Actions secret, read by `.github/workflows/sign.yml`.
