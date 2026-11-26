# Reaction roles

```yaml
panels:
  - name: notifications
    channel: roles
    title: Notifications
    style: buttons
    options:
      - role: events
        emoji: "📅"
```

Set `style` to `buttons`, `select` or `reactions`, and `mode` to `single` or `multiple`. `requiredRole` restricts a panel. The bot's role must be above the roles it offers. `/role-panel` refreshes configured panels in place. Reaction panels use the ServerMessageReactions intent. The manifest documents grants for rendering panels and changing roles.

Only shared panel IDs, message IDs and content fingerprints are retained. The plugin reads current member roles directly from Discord. The built-in labels, explanations and command descriptions are available in English and French. Operator-provided panel contents retain their original language. Set `enabled: false` to disable the instance.
