# RoboBuddy AI Lab Fidelity-First v2 Implementation Plan

Approved by the user in Codex source task `019ff7e0-4378-7d41-ae70-5ca4fd39c902`.

Approval state: IMPLEMENTATION AUTHORIZED

Created: 2026-08-12 19:51:30 -05:00

## Outcome

Replace the current synthetic robot-lab behavior with a browser-based, fidelity-bounded v2 in which rendering and planning use the same canonical robot models; paths are executable and collision checked; object and process state changes are contact/event gated; Python runs asynchronously in Pyodide; robot morphologies expose only supportable capabilities; and grading evaluates observable outcomes, hard causal/safety constraints, and required evidence.

All 50 legacy tasks will receive one explicit v2 successor (10 per robot). V1 remains immutable, exportable legacy data with separate v2 progress.

## Non-Negotiable Scope and Safety

- Work only in `C:\Users\EmilJivishov\Projects\RoboBuddy_AI_Lab`.
- Initialize a standalone local Git repository only after verifying no existing `.git` is present.
- Use a `codex/` branch, local commits, and five isolated Codex worktree tasks only after the shared foundation is validated and frozen.
- Do not add a remote, push, publish, deploy, enroll in the parent Projects repository, or operate on siblings.
- Preserve all existing source files. V1 may be copied into an immutable/exportable archive but not rewritten as v2.
- Use the configured Git identity; stop and ask if it is absent.
- English-only UI; retain camera movement and zoom toggles.

## Fidelity Contract

- Arduino: CAD-derived fixed-base chain from `simulator/js/arm-rig-config.js`; FK/IK and linkage-aware gripper; no certified calibration or dynamics claim.
- SO-101: baked official-model chain with explicit official/configured limit provenance; fixture-assisted manipulation; no force/payload claim.
- LeKiwi: planar occupancy-grid A* base planning, stow-before-drive, arm FK/IK and grasping; no wheel-slip/dynamics claim.
- OpenArm: per-arm and coordinated bimanual kinematics under shared-base constraints; no torque/force-control claim.
- Unitree G1: constrained waypoint logistics, turns, docking, and secured-carrier attachment only; no free grasping, leg IK, balance, collision recovery, or dynamic locomotion claim.

Each model claim will state source revision, joints/frames/limits, collision-proxy provenance, supported fidelity, and unsupported physics.

## Execution Phases

### Phase 0 - Repository Baseline

1. Inspect applicable instructions and the repository without traversing siblings.
2. Verify `.git` is absent; verify the configured Git user name and email exist.
3. Initialize the standalone repository, create a `codex/robobuddy-v2-foundation` branch, record existing files as the preservation baseline, and make a local baseline commit.
4. Inventory runtime, legacy tasks, tests, build tooling, and existing Pyodide/renderer/planner boundaries.

Checkpoint: baseline commit exists locally; no remote exists; working tree is understood and preserved.

### Phase 1 - Shared V2 Foundation

1. Add a pure-data robot model catalog used by both renderer and planner.
2. Add canonical transforms/FK and deterministic seeded multi-start damped-least-squares IK with joint-limit enforcement.
3. Add conservative capsule/box/convex collision proxies, sampled render-enclosure validation, bounded joint interpolation, and seeded bounded joint-space RRT-Connect fallback.
4. Add contact-sequence planning and event-gated execution for pre-contact, contact, lift, transfer, place/insert/operate/pour, and retreat. Fixed roots never translate.
5. Add trajectory-executor pause/resume/STOP/reset semantics. STOP retains the last executed joint sample; attachment begins only at contact.
6. Convert the Pyodide worker bridge to bidirectional asynchronous RPC with `RUN`, `API_CALL`, `API_RESULT`, `API_ERROR`, `PAUSE`, `RESUME`, `CANCEL`, and `STOPPED`, strict `runId`/`callId` matching, timeouts, and stale-call rejection.
7. Expose layered Python and Blockly APIs:
   - Guided: semantic skills.
   - Builder: observations, planning, execution, gripper, recovery.
   - Challenge: discoverable frames, joint state, explicit waypoints, loops/branches, alternate IK seeds, and replanning.
8. Define and validate `ScenarioV2`: canonical model, frames, fixtures, objects, grasps, process models, goal predicates, prohibited states, evidence requirements, M/F/R/C provenance, model claims, validation-only reference solutions, and `supersedes`.
9. Add outcome/evidence grading that accepts safe alternative algorithms and only causally safe ordering variation.
10. Keep chemistry/process changes discrete and contact-gated, using source-supported or visibly teacher-configured values only.
11. Add separate v2 catalog/storage/progress and read-only/exportable v1 archive behavior.

Foundation acceptance checks: FK parity, IK round-trip/unreachable, limits, proxy enclosure, collision paths, fixed roots, no attachment/state mutation before contact, STOP/reset, Python loops/conditions/errors/timeouts/stale calls, schema validation, legacy preservation, and camera-toggle regression.

Checkpoint: foundation tests pass, interfaces are documented and frozen, and a local foundation commit is created.

### Phase 2 - Five Isolated Robot Task Worktrees

Create exactly five Codex project tasks from the frozen foundation branch, each with model `gpt-5.6-sol` and medium reasoning:

1. RoboBuddy v2 - Arduino Tasks
2. RoboBuddy v2 - SO-101 Tasks
3. RoboBuddy v2 - LeKiwi Tasks
4. RoboBuddy v2 - OpenArm Tasks
5. RoboBuddy v2 - G1 Tasks

Each prompt will be self-contained and include exact owned paths, frozen schema/API, robot fidelity contract, task-migration rules, tests, local-commit requirement, and an integration-report contract. Workers may edit only robot-specific scenarios, fixtures/adapters, model claims, reference solutions, and robot-specific tests. Shared runtime/schema/generated catalog/migration/other-robot edits are forbidden and blockers return to the master task.

Monitor with Codex task waits, resolve shared blockers centrally, and require branch name, commit, tests, classification table, and caveats before integration.

### Phase 3 - One-to-One Task Migration

For each legacy task:

1. Classify A (direct), B (fixture-assisted), or C (unsupported/redesigned role).
2. Preserve rank slot and learning objective while replacing physically implausible actions.
3. Provide an explicit `supersedes` mapping.
4. Define reachable approach/contact/lift/retreat/destination frames, visible fixture assumptions, process prerequisites, evidence requirements, reference execution, at least one accepted alternate route/IK seed/safe ordering, and negative cases.
5. Keep G1 strictly logistics-only with compatible secured carriers and docking/latch frames.

### Phase 4 - Controlled Integration

1. Review each worker result against owned-path and fidelity boundaries.
2. Integrate worker branches one at a time into the master integration branch.
3. Resolve shared blockers, schema issues, and conflicts only in the master task.
4. Regenerate the combined v2 catalog exactly once after all five branches are integrated.
5. Make local integration commits only.

### Phase 5 - Acceptance and Browser Inspection

Run and report exact outcomes for:

- all 50 `ScenarioV2` schema validations;
- FK parity; IK round-trip and unreachable targets; joint limits;
- collision proxy enclosure and path checks;
- fixed-root invariant and no-object-before-contact;
- STOP/pause/resume/reset behavior;
- Pyodide loops, conditions, error propagation, timeout/cancel, and stale-call rejection;
- for every task: reference execution passes, a legitimate alternate algorithm passes, and perturbations fail for the intended reason;
- targeted browser inspection for Arduino, SO-101, LeKiwi, OpenArm, and G1, including camera movement/zoom toggles and visible motion/contact timing;
- v1 read-only/export and independent fresh v2 progress.

Static checks, runtime tests, browser checks, and any unrun physical/E2E/performance checks will be reported as distinct evidence categories. No static audit will be labeled browser/E2E or physical proof.

## Frozen-Interface Policy

Foundation interfaces are frozen only after the foundation acceptance checkpoint. Robot workers consume those interfaces and must report shared blockers rather than editing shared modules. Any necessary shared change is made centrally, followed by compatibility checks and a focused worker follow-up if required.

## Completion Definition

Completion requires all five worktree results reviewed and integrated; exactly 50 validated v2 successors with one-to-one mappings; combined catalog regenerated once; required automated and targeted browser checks executed with exact results; local commits present; and no remote, push, publication, deployment, or parent-workspace enrollment.
