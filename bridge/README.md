# RoboBuddy Local Bridge

The bridge is optional. The GitHub Pages simulator works without it.

Run from this folder:

```powershell
python -m robobuddy_bridge
```

Default bind: `127.0.0.1:8765`.

Tier 1 supports:

- fake adapter for tests and development
- SO-101 adapter shell that imports LeRobot lazily
- validated RoboBuddy command JSON only
- safe STOP response even when idle or disconnected

The SO-101 real adapter refuses movement when LeRobot is unavailable or calibration cannot be verified.
