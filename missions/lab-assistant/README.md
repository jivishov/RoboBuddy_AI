# Chemistry Lab Assistant Scenarios

This package contains 50 simulation-only robot-programming scenarios: 10 ranks for each RoboBuddy robot pack. Open `lab-scenarios.html` through an HTTP server to choose a task, then use `lab-workbench.html` to program its existing 3D rig with Blockly or the supported line-oriented Python command subset.

## Regeneration and validation

```powershell
node scripts\generate-lab-scenarios.mjs
node scripts\validate-lab-scenarios.mjs
node --no-warnings scripts\test-lab-runtime.mjs
```

The generator reads `scripts/lab-scenario-specs.mjs` and writes `index.json`, `source-ledger.json`, and the 50 versioned definitions under `v1/`.

## Fidelity boundary

- `M` marks reviewed Lab Studio technique actions copied into the source ledger.
- `R` marks a morphology-specific assignment or limitation.
- `C` marks authored educational configuration such as poses, station locations, and tolerance gates.
- Robot and apparatus behavior is deterministic kinematic visualization with discrete state. It does not claim fluid dynamics, torque planning, autonomous path planning, force safety, or dynamic humanoid balance.
- The lab pages do not load RoboBuddy's hardware, Web Serial, bridge, arming, calibration, or virtual-leader modules.

The local Lab Studio checkout is a build-time review source only. Local paths, content hashes, and provider file handles are not serialized into browser-visible scenario state.
