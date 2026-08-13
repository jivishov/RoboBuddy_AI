# Lab apparatus visual-fidelity refinement

Status: implemented and post-change verified on 2026-08-12 following the user's request to refine the scenes and use Lab Studio's realistic equipment PNGs as visual authority. The output is a procedural real-time approximation; no photorealism claim is made.

## Critical findings

- The shared prop factory reduces most apparatus to a box, cylinder, or generic vessel; labels carry more identity than the geometry.
- Several control identifiers are misclassified as complete apparatus (`burette_stopcock`, `separatory_funnel_stopcock`, `pipette_pump`, and `flask_stopper`).
- Workflow-only object collection omits visually necessary companion equipment, so a stopcock can appear without a burette and a vacuum connection without a vacuum-filtration assembly.
- Every apparatus at a station receives the exact same transform, creating overlap rather than an intelligible workcell.
- Camera distance, low-contrast transparent materials, and thin zone rings make small equipment nearly unreadable in the workbench viewport.

## Reference and fidelity contract

- Use only reviewed images under Lab Studio `public/assets/equipment-realistic/v1` as visual references.
- Record only relative asset identifiers in the committed ledger; never expose the local Lab Studio path, hashes, or source payloads to the client.
- Reconstruct apparatus as procedural Three.js assemblies with recognizable silhouette, functional landmarks, material families, and interaction anchors. Do not claim reference-exact dimensions or photorealistic rendering.
- Keep the discrete kinematic and no-fluid simulation boundary. Visual liquid surfaces may indicate configured contents but do not simulate volume or flow.
- Preserve baked robot meshes, canonical kinematics, checkpoints, and hardware isolation.

## Implementation

1. Add a centralized visual/reference catalog with per-type dimensions, reference asset, station offset, and held-object scale.
2. Replace generic apparatus with component-based factories for balances, glassware, funnels, filtration assemblies, burettes, instruments, ovens, racks, bottles, pumps, stoppers, tools, controls, carriers, and stations.
3. Add companion apparatus for controls and assemblies without adding learner checkpoints.
4. Lay out apparatus within each station, add raised station surfaces and restrained identification markers, and attach inserted objects to authored sockets.
5. Improve lighting/material contrast and author tighter robot-specific cameras without changing movement/zoom preferences.
6. Add a reference-ledger validator and visual/type coverage tests.

## Verification gates

- All scenario apparatus types and IDs resolve to intentional visuals; no generic fallback is used by the 50 definitions.
- Reference ledger resolves against the Lab Studio realistic asset directory.
- Success and invalid/recovery traces remain deterministic.
- Representative simple and complex scenes for all five robots are inspected at desktop and tablet viewports.
- Browser console remains free of errors; reset, grasp/place/insert, camera toggles, STOP, and task switching remain functional.

## Implemented outcome

- Replaced the generic prop factory with 31 reviewed apparatus families built from component-level geometry and material cues.
- Added explicit attachment sockets for pans, racks, instrument bays, flask necks, funnels, ovens, and robot effectors.
- Added 35 scene-only companion fixtures so functional stations remain visually complete without becoming programmable shortcuts.
- Corrected OpenArm filter assembly to insert the funnel into the held ring stand instead of placing it on an empty zone.
- Added a dedicated expanded-scene control and preserved camera movement/zoom preferences.
- Kept the three-pane workbench visible at 1024×768; preserved the intentional stacked tablet layout at 768×1024.
- Replaced prop-to-gripper flight with a reusable lab-only contact choreography. A grounded robot receives a horizontal presentation offset while an adjustable contact lift bridges only the remaining vertical gap; the object attaches only at the resolved grip socket, follows the live end-effector while held, and meets the exact host socket before release or insertion.
- Kept Unitree G1 grounded and within its fixed-hand secured-carrier logistics boundary. G1 carriers use the same visible lift/handoff pattern without fine-glassware or dynamic-balance claims.
- Made the contact choreography pause-aware and cancelable. STOP restores the presentation root, removes the transient lift, and renders the current recoverable engine state; Reset reconstructs the authored initial scene.
- Preserved canonical robot joints, baked meshes, limits, named-pose gates, deterministic traces, and simulation-only isolation. The choreography is explicitly presentation-only and is not inverse kinematics, collision planning, rigid-body physics, or a hardware-control path.

## Executed verification

- Scenario validation: 50 unique definitions; 10 per robot; ranks 1–10; source, trace, assistance, and hardware-isolation gates passed.
- Runtime validation: 50 successful traces, 50 invalid proximity traces, recovery, STOP/reset, morphology, thermal, contamination, orientation, and command-normalization gates passed.
- Apparatus audit: 31 reference families, 146 apparatus records, 35 companion props, 9 aliases, complete workstation fixtures, and no generic fallback types passed.
- Final live in-app-browser sweep after the action-contact change: all 50 scenes reached Ready at 1366×768 with five robot families, visible canvases and stage-local STOP controls, no horizontal overflow/load error, and a minimum stage of approximately 567×415 px.
- Final responsive in-app-browser matrix: first/most-complex scene for every robot (10 scenes) passed at 1024×768 with minimum stage approximately 498×422 px and at 768×1024 with minimum stage 655×460 px; scene and STOP remained visible with no horizontal overflow.
- Final interaction samples passed for Arduino grasp/carry/place, SO-101 grasp/insert, LeKiwi hold/pause/resume/STOP/Reset, OpenArm left- and right-effector grasp, G1 secured-carrier grasp/carry/release/home, an apparatus `operate` action, and expanded-scene enter/exit. Accumulated browser warning/error log was empty.
- Observed in-app-browser page assets contained no serial, hardware, bridge, virtual-leader, WebSocket, or local hardware-endpoint asset. Static scenario validation also confirmed the dedicated workbench excludes those modules.
- Not run here: mobile QA, performance/load testing, physical hardware, deployment, formal accessibility conformance, or cross-browser coverage. `npm test` is unavailable because this repository has no package manifest.
