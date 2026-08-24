# Physical Rest and Manipulation Fidelity Repair Plan

Timestamp: 2026-08-23 14:07:56 -05:00

Execution status: implementation and verification complete.

## Scope, audience, and learning objective

- Audience: learners programming the portable SO-101, LeKiwi, and OpenArm ScenarioV2 chemistry-lab simulations with Blockly or ordinary synchronous Python.
- Scenario objective: execute credible approach, contact, closure, lift, transfer, placement, opening, and retreat sequences while the visible scene, authoritative 20 ms plant, contact/collision model, attachment state, release pose, and grading agree.
- Repair scope: all portable SO-101, LeKiwi, and OpenArm authored definitions, generated clients, owning generators, workcell/fixture construction, renderer object transforms, grasp/contact frames, collision proxies, attachment/release logic, and focused/full validation.
- Explicit exclusion: unrelated dirty work, Arduino/G1 behavior except shared regression safety, Git history/release operations, deployment, and physical hardware changes.

## Reference-calibrated fidelity contract

- Fidelity tier: **Reference-calibrated kinematic simulation**. Robot geometry, joint limits, axes, FK, tool/contact frames, and pinned reference actions remain tied to the repository's identified robot references. Workcell dimensions and tolerances without an upstream vendor measurement are labeled `configured`. This is not a safety-certified digital twin.
- Honest learner-facing claim (must remain exact): **API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.**
- Runtime/stack: static ES modules served over HTTP in Chrome or Edge; true user Python through the existing browser compatibility layer; immediate `send_action` semantics; fixed 20 ms authoritative plant tick; simulator state and grading remain authoritative.
- Canonical units: metres, radians, seconds, and a right-handed world frame with +Y as world up/gravity-opposing. Scenario millimetre values are converted once at the plant/render boundary.
- Authoritative frames: world, fixed/mobile robot base, per-link FK frames, left/right tool frames, independent left/right finger/contact frames, object body/rest frames, real support-surface frames, and host placement frames. Rendering and UI derive from accepted authoritative state.
- Geometry provenance:
  - Robot mesh/chain, joint axes/limits, and established tool conventions: `referenced` to the repository-pinned robot assets/catalog revisions.
  - Apparatus dimensions already traced in the apparatus source ledger: `referenced` where that record exists.
  - Workcell surface dimensions, conservative collision proxies, rest/contact tolerances, and grasp envelopes: `configured` and named as such in code/tests.
  - Browser screenshot observations: `measured` visual defect evidence only, never a geometry source.

## Physical rules enforced by the repair

1. A portable object may rest only in nonpenetrating contact with a real load-bearing surface or an explicitly source-backed task fixture. Synthetic rods, sticks, registration pins, pedestals, invisible helpers, or renderer-only supports are forbidden.
2. An unsupported watch glass at rest has its local normal aligned to world up. Configured acceptance tolerance: no more than 2 degrees from world up, vertical support gap no more than 2 mm, penetration no more than 0.5 mm, and center-of-mass projection inside the supporting footprint with at least a 2 mm edge margin.
3. Other resting apparatus must have a stable configured footprint, valid support contact, the same nonpenetration tolerance, and an orientation appropriate to its real resting form. Thin tools such as spatulas lie on a real surface unless held by a source-backed rack/holder.
4. Carry attachment occurs only after the intended independent gripper reaches the object's live contact frame and the gripper crosses the configured closed threshold. Carry pose is derived continuously from live FK; no auto-attach or interpolation teleport is allowed.
5. Release occurs at the actual accepted opened-gripper world pose. Placement succeeds only if that pose yields valid support contact, nonpenetration, orientation, and footprint stability; otherwise the object remains where released and grading fails honestly.
6. Robot, payload, worktables, supports, and apparatus collision/contact checks remain active throughout approach, grasp, lift, transfer, placement, opening, and retreat. Tables and task objects do not move to manufacture reachability.
7. OpenArm left and right grippers are verified independently from multiple views and by side-specific geometry/contact witnesses. Planning minimizes base_yaw, J5, and J7 changes unless the lower-motion branch cannot reach without collision.
8. STOP freezes the accepted state and cancels future actions; Reset reconstructs baseline surfaces, object rest poses, attachments, transient faults, and timers.

## State transitions and numerical method

- Fixed-step kinematic plant: `state[n+1] = validate(clamp(command(state[n]), joint limits), dt = 0.020 s)`.
- A candidate state is accepted only after joint-limit, velocity/acceleration (where configured), self/workcell/object collision, and contact prerequisites pass. Invalid candidates retain the last accepted state and produce an honest fault.
- Object state machine: `resting -> contacted -> attached -> carried -> release_candidate -> resting` when all prerequisites pass; invalid contact/closure never advances attachment, and invalid release never fabricates placement.
- Rest validation uses object support points/footprint against real surface bounds, world-up orientation, center-of-mass projection, support gap, and penetration tolerances. It is deterministic and shared by scenario validation/tests and runtime transitions where material.

## Assumptions, approximations, and not simulated

- Assumptions: worktops are rigid, level configured surfaces; apparatus is rigid; center of mass is approximated by the configured collision/body frame; static rest is a deterministic geometric acceptance test rather than a dynamics settle.
- Conservative approximations: renderer meshes and collision proxies may differ, but both must refer to the same authoritative pose and proxies may not permit visibly material penetration.
- Not simulated: rigid-body dynamics, frictional settling, compliance, grasp force, suction, torque/force feedback, payload deflection, controller latency beyond the fixed plant, collision recovery, damage, liquids/multiphysics, physical calibration uncertainty, ROS/DDS transport, safety certification, or hardware validation.

## Implementation sequence

1. Preserve the dirty baseline; map authored definitions -> owning generators -> generated clients -> fixture/renderer/plant/contact/collision/attachment/release/grading paths.
2. Reproduce the reported OpenArm state over local HTTP when feasible and inspect baseline rest/contact/carry/release/retreat from independent left/right, overhead, and oblique views.
3. Remove synthetic supports from owning source rather than hiding meshes; replace object setup and place frames with real-surface rest/contact frames and physically plausible orientations/clearances.
4. Add a shared fail-closed rest/support validator and repair runtime attachment/release/collision state transitions wherever the audit shows divergence.
5. Scan and repair all ten portable scenarios for each of SO-101, LeKiwi, and OpenArm; regenerate affected clients only through owning scripts.
6. Add negative regressions for support sticks/pedestals, unsupported watch-glass tilt, no-contact/unstable/penetrating rest, premature attachment, release teleportation, fixture motion, and left/right OpenArm geometry/contact correspondence.
7. Prove generator idempotence/hash parity, then run focused tests, `validate:v2`, `test:v2:all`, and the full 30-scenario portable reference suite.
8. Validate at 1440x900 and 1366x768 in Chrome or Edge, inspecting several views and phases; record console/runtime results and bounded limitations.

## Acceptance cases

- No authored or generated portable SO-101/LeKiwi/OpenArm scenario contains a synthetic support stick, rod, pedestal, registration pin, hidden support, or fixture transform that moves to accommodate the robot.
- Every initial/final rest pose is support-backed, stable, correctly oriented, and nonpenetrating; every unsupported watch glass is horizontal within 2 degrees.
- Every carried object attaches only after side-correct FK contact plus closure, follows the live tool frame, and releases without teleportation at the actual opened-gripper pose.
- All reference actions retain immediate physical-style Python semantics and the fixed 20 ms plant.
- OpenArm left/right grippers and payload clearance pass independent multi-view inspection through approach, grasp, carry, placement, release, and retreat; no table/object/finger interpenetration is visible.
- Focused negative tests fail closed for every prohibited condition, all 30 portable references pass, generation is idempotent, and generated hashes match their owning outputs.
- Physical hardware validation is reported as pending, never implied by browser or Node results.
