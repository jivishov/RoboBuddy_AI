# RoboBuddy Chemistry Lab Scenario Implementation Plan

Status: approved by the user on 2026-08-12.

## Delivery

- Add `lab-scenarios.html` as a searchable, robot-filtered catalog of exactly 50 chemistry-lab-assistant tasks: 10 tasks for each existing robot pack.
- Add `lab-workbench.html` as a simulation-only Blockly/Python workbench with checkpoint guidance, the existing 3D robot rig, scenario apparatus, state/evidence readouts, recovery, independent drafts, camera movement and zoom toggles, and an emergency simulation stop.
- Add only a `Lab Tasks` navigation entry to existing workbench pages.
- Do not load Web Serial, hardware adapters, bridge, arming, calibration, or virtual-leader modules from either lab page.
- Preserve baked robot mesh modules, canonical rig transforms, joint limits, and all non-lab behavior.

## Architecture

- Store the catalog index and 50 versioned scenario definitions in `missions/lab-assistant/`.
- Store reviewed technique claims in a committed source ledger. Use `M` for Lab Studio source-stated procedural facts, `R` for morphology assignments, and `C` for authored simulation configuration.
- Keep scenario code in cohesive `lab/js/` modules: `objects`, `equipment`, `actions`, `calculations`, `state`, `interactions`, `steps`, `labels`, `instructions`, and `ui`; keep styling in `lab/css/`.
- Reuse existing robot registry, manifests, simulation adapter, and `ArmPreview3D`. Add scenario props through a lab-only scene extension and never change baked mesh data.
- Implement explicit commands: `move_to_pose`, `grasp`, `place`, `pour_into`, `insert_into`, `operate`, `read_instrument`, and `record_observation`. Validate robot capability, effector, proximity, orientation, object state, and checkpoint prerequisites before state mutation.
- Treat all motion and apparatus behavior as deterministic kinematic educational visualization. Do not claim rigid-body physics, fluid dynamics, torque planning, autonomous path planning, or dynamic humanoid balance.

## Staged Build

1. Establish the two page shells, shared schema/source contracts, URL restoration, independent drafts, and simulation-only boot.
2. Prove five morphology-specific vertical slices: Arduino cuvette insertion, SO-101 burette setup, LeKiwi dilution route, OpenArm controlled bimanual pour, and G1 sealed sample carrier.
3. Expand the same validated contract through Guided ranks 1-3, Builder ranks 4-7, and Challenge ranks 8-10.
4. Validate catalog cardinality, source references, scenario traces, command normalization, reset/recovery, hardware isolation, accessibility behavior, supported tablet/laptop/desktop viewports, and preservation of the existing rigs.

## Frontend Record

- Loaded `design-taste-frontend` through the science activity workflow.
- Overrides: `DESIGN_VARIANCE: 4`, `MOTION_INTENSITY: 3`, `VISUAL_DENSITY: 8`.
- Archetypes: compact catalog with detail inspector; simulation workbench/lab-procedure shell.
- Typography: existing DM Sans and IBM Plex Mono. Palette: existing neutrals with one teal accent. Motion: short state transitions only.
- Panel behavior: catalog list plus adjacent inspector; workbench procedure/editor/3D evidence columns that stack or tab on tablet portrait.
- Viewports: 768x1024, 1024x768, 1366x768, 1536x864, 1920x1080, and 2560x1440. Mobile is explicitly out of scope.
- Rejected defaults: React/Tailwind migration, bento layout, decorative glass, oversized hero, perpetual animation, magnetic controls, new fonts, and new dependencies.

## Acceptance Boundary

- Exactly 50 valid tasks, 10 per robot, with ranks 1-10 and stable unique IDs.
- A deterministic successful trace and an invalid/recovery trace for each definition.
- Lab pages contain no physical connection UI and load no hardware/serial/bridge scripts.
- Blockly and Python expose all scenario commands; G1 rejects fine manipulation and only handles secured carriers.
- STOP preserves recoverable task state; Reset reconstructs the authored initial state.
- Configured, simulated, learner-recorded, and completion evidence stay distinct.
- Validation results are reported by layer; no unrun browser, accessibility, performance, mobile, or release checks are claimed.
