# RoboBuddy AI

Static GitHub Pages version of RoboBuddy.

Browser entry points:

- `index.html`
- `python.html`
- `gemini.html`
- `python-docs.html`

Tier 1 adds a robot-pack foundation while preserving the deployed Arduino robotic arm experience. The default robot id is `arduino_arm`; old saved programs without a robot id are treated as `arduino_arm`.

Tier 1 robots:

- `arduino_arm`: Arduino Arm, simulation plus Web Serial hardware.
- `so101_follower`: LeRobot SO-101 F, simulation plus optional localhost bridge.
- `lekiwi_sim`: LeKiwi-style mobile manipulator simulator, simulation only.

Run locally with any static server from this folder:

```powershell
python -m http.server 8090 --bind 127.0.0.1
```

Run tests:

```powershell
npm test
```

Run the optional bridge:

```powershell
cd bridge
python -m robobuddy_bridge
```

The 3D Arduino arm preview does not load raw STL, 3MF, or CAD files at runtime. Mesh geometry is baked into `simulator/js/arm-preview-mesh-data.js`.
