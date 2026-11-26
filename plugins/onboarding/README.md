# Onboarding

```yaml
steps:
  - id: notifications
    title: Which notifications would you like?
    multiple: true
    options:
      - role: events
```

The member-facing portal resolves configured roles at read time. `/onboarding` sends a signed personal link. Configure `completedRole` to grant a completion role. The bot needs Manage Roles and a higher role than every role offered. Custom labels and messages are preserved. Default messages use the English or French catalog.

The instance stores the member's last chosen roles and completion timestamp for 365 days. Privacy export returns only that member's choices. Erasure removes the completion record. A non-identifying aggregate count is retained. Upgrading from 0.1 adds a scheduler grant for the resumable 40-record migration, which expires old records and preserves recent choices and their original completion dates. Set `enabled: false` to disable the instance.

The registry migration acceptance runs the production onboarding and voice-room bundles, stops each VM after one batch, closes and reopens the database, and replays the persisted tasks. Run `node plugins/onboarding/test/persistence/run.mjs` with `CICORD_SOURCE` pointing to the companion engine checkout. Setting `CICORD_TEST_POSTGRES_URL` to a disposable test database adds PostgreSQL checks in fresh isolated schemas alongside SQLite.
