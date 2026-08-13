# RoboBuddy Lab Scenario v2 Sources

`definitions/` contains the authoritative ScenarioV2 authoring sources. Each source contains validation-only reference executions, accepted alternates, and negative cases. Browser-delivered definitions are generated into `generated/scenarios/` with the `validation` member stripped.

The v1 files in `../v1/` are immutable legacy sources. V2 uses separate browser keys under `robobuddy:lab:v2:` and never treats a v1 completion or draft as v2 progress. `legacy-v1-export.json` is an export manifest, not a migration or reinterpretation.

The combined catalog is generated once, after all five robot-family branches are integrated:

```powershell
node scripts\generate-lab-v2-catalog.mjs
```

The generator refuses a second run when `generated/build-metadata.json` exists unless a maintainer explicitly removes that generated output in a later authorized remediation.
