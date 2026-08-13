# Chemistry Lab Fidelity Refinement

Status: implemented and validated on 2026-08-12.

## Resolution summary

All ten findings below were addressed. The rendered pass additionally found and fixed a disposed-workspace draft overwrite, light-rig/fog contrast loss, G1 demo-object leakage, and camera-control occlusion. No canonical mesh, rig transform, robot pack, hardware adapter, or serial file was changed.

## Evidence-backed findings to resolve

1. Replace the shared safety bootstrap on the dedicated lab page with a simulation-only joint-state shim so arming, bridge, connection, calibration, and virtual-leader state are not loaded.
2. Make G1 `pick_nearest(hand)` and `release(hand)` resolve the authored secured carrier and destination; return a morphology-specific rejection for fine manipulation.
3. Make joint updates atomic, reject unknown/out-of-range joints, and validate every generated named pose against the canonical robot manifest.
4. Attach held and inserted lab props to live rig end-effector/target transforms rather than fixed world coordinates.
5. Replace hidden mobile-station advancement with explicit world-frame LeKiwi routes and turn/walk G1 routes, including authored no-entry volume checks.
6. Reduce Builder helper poses, preserve Challenge helper restrictions, and keep Guided scaffolding broad.
7. Scope each task's Lab Studio action references to the actions it actually represents; label robot handling/configuration checkpoints as `R/C` instead of overclaiming `M`.
8. Validate the committed source ledger against the user-designated Lab Studio technique JSON through a separate build-time script without serializing local paths or hashes.
9. Preserve both drafts on task changes, disclose the supported Python command subset, apply authored camera presets, and expose more consequential apparatus state.
10. Add adversarial tests for atomicity, morphology, gripper ambiguity, contamination, spill, connection, route/hazard, source-ledger, attachment, reset, and isolation behavior.

## Validation boundary

- Re-run generator, schema/source checks, deterministic runtime traces, five morphology slices, all 50 scene loads, focused browser accessibility/isolation checks, and the six requested tablet/laptop/desktop viewports.
- Do not run or claim mobile, physical-hardware, deployment, performance/load, cross-browser, or formal accessibility-conformance QA.
- Preserve canonical mesh data, rig configurations, robot packs, hardware behavior, and unrelated files. No commit, push, PR, or deployment.
