# Robot Pack Format

Robot manifests are browser-loaded JavaScript files under `robots/packs/<robot_id>/manifest.js`.

Required fields:

- `id`
- `name`
- `shortName`
- `formFactor`
- `maturity`
- `defaultMode`
- `supportedModes`
- `hardware`
- `capabilities`
- `joints`
- `ui`

Joints define `id`, `label`, `type`, `unit`, `min`, `max`, `home`, and optional `open`/`close` for grippers. Arduino joints also include `servoIndex` so universal commands can map back to the existing serial protocol.

Register a pack with:

```js
RoboAdmin.RobotRegistry.register(manifest);
```

The active robot is persisted in `localStorage` key `robobuddy.activeRobotId`. Invalid or legacy ids fall back to `arduino_arm`.
