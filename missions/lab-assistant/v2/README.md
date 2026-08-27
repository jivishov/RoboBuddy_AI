# RoboBuddy Lab Scenario v2 Sources

`definitions/` contains the authoritative ScenarioV2 authoring sources. Each source contains validation-only reference executions, accepted alternates, and negative cases. Browser-delivered definitions are generated into `generated/scenarios/` with the `validation` member stripped.

The v1 files in `../v1/` are immutable legacy sources. V2 uses separate browser keys under `robobuddy:lab:v2:` and never treats a v1 completion or draft as v2 progress. `legacy-v1-export.json` is an export manifest, not a migration or reinterpretation.

The combined catalog is generated once, after all five robot-family branches are integrated:

```powershell
node scripts\generate-lab-v2-catalog.mjs
```

The generator refuses a second run when `generated/build-metadata.json` exists unless a maintainer explicitly performs a reviewed refresh:

```powershell
node scripts\generate-lab-v2-catalog.mjs --refresh
```

## Measured workcell missions

A `configured_measurement_ruler` is a visible, `presentationOnly` millimetre reference. It has no collision authority and may not be used as a support, reachability aid, or hidden physics object. Authoritative grading reads the plant's final object poses and event log through the bounded predicates `object_axis_coordinate`, `object_axis_distance`, `object_planar_distance`, `object_planar_offset`, and `event_before`. This keeps measurement outcomes deterministic while preserving the robot family's existing joint-action API, IK, collision checking, stable-rest checks, release semantics, and fixed-step replay.

The reviewed SO-101/OpenArm upgrade is reproducible as one ordered command; OpenArm reference actions must be re-solved after the source geometry is authored and before client scenarios are regenerated:

```powershell
npm run upgrade:v2:complex-lab
```
