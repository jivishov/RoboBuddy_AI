# Portable Python fidelity and UX audit/refinement plan

Timestamp: 2026-08-23 13:00:37 America/Chicago  
Scope: SO-101, LeKiwi, and OpenArm portable-Python workbench only  
Authority: implementation authorized; preserve unrelated dirty work; no reset, clean, stage, commit, push, publish, or deploy.

## Fidelity contract

- Audience: learners and educators using the browser workbench, primarily on 15-inch laptops.
- Model tier: API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.
- Canonical state: the fixed-step plant joint/root state, FK contact, attachment latch, object world pose, event log, and grader state. Presentation reads that state and cannot invent completion or contact.
- Timing: deterministic 20 ms plant ticks; position commands begin immediately and advance continuously within configured velocity/acceleration limits. Pause freezes advancement; STOP cancels without fabricating success; Reset restores the authored initial state while preserving the learner draft.
- Units: public portable Python uses degrees, normalized gripper values, metres/seconds, and degrees/second as cataloged. Plant geometry uses millimetres and degrees at the documented boundary.
- Contact: every visible worktop, support, fixture, target, and task object remains solid to every robot link and finger. Attachment requires live FK contact followed by a valid gripper closure/latch transition. A carried object follows the live tool/socket transform and releases at its actual world pose.
- Route selection: task-source frames and a configured workcell clearance envelope own routing. Generated references may use only collision-checked, semantically named route stages. Arbitrary absolute clearance coordinates and dense learner-visible Cartesian micro-waypoints are rejected.
- OpenArm continuity: hold `base_yaw`, J5, and J7 unless a documented reachability fallback is necessary; independently inspect both grippers from outside, inside, side/rear-oblique, and top views.
- LeKiwi: learner code must explicitly stow before drive, command explicit stops, and respect the base watchdog.
- Not simulated: forces/torques, payload capacity, friction, compliance, backlash, motor/controller dynamics, sensing, calibration, ROS/DDS transport, physical safety, and hardware validation.

## Untrusted baseline reproduced before editing

- A stale `--openarm-only` generator process was independently found mutating sources and was stopped by its exact PIDs before this plan was created.
- OpenArm tasks 1-3 had 99-102 generated actions using hard-coded `clearanceY = 500`; tasks 4-10 still had 16 actions. This mixed partial output fails ownership and determinism acceptance.
- `test:v2:portable-references` faulted on SO-101 task 01 when a rendered wrist/gripper proxy contacted the now-solid pickup adapter.
- `test:v2:openarm-workbench-regression` faulted on OpenArm task 01 when `left_link6-8` contacted the left worktop.
- The current Edge-origin portable run reproduced `SIMULATOR_COLLISION_FAULT`; Chrome/Pyodide reproduced the same visible failure.
- After the Chrome collision, the editor reported an error while the task feedback said `DISCONNECTED` and the 3D status said `Ready`; this violates the authoritative-state contract.
- Prior screenshots show OpenArm links/fingers visibly entering the worktop during contact/retreat.
- At 1440x900 and 1366x768 the task panel is dense, checkpoints use internal predicate names, evidence/trace consume scarce height, frequent controls are 30-34 px, several labels render below 12 px, the editor has no visible keyboard focus, and the two Simulation Stop controls duplicate one global action.

## Work sequence

1. Freeze and record the dirty baseline, inspect prior evidence, catalog/model/plant/generators/tests, and reproduce Chrome plus automated Edge-origin failures.
2. Repair source-owned support/clearance geometry, mesh/proxy contact checks, latch/release semantics, and reference generation. Regenerate all 30 source/client pairs twice and compare hashes.
3. Repair fault/state truthfulness and Run/Pause/STOP/Reset invariants; add regression tests for each reproduced failure.
4. Refine the established workbench hierarchy, task scope, human-readable progress, action status/recovery, Python/Blockly clarity, source export, focus/keyboard/ARIA behavior, text/target sizing, overflow, and progressive disclosure.
5. Run focused compatibility, plant/contact/grasp/release/control, 30-task hand-code/Blockly, family, validation, and full v2 suites.
6. Re-run actual current-origin Chrome/Pyodide motion and installed Edge-origin automation. Capture 1440x900, 1366x768, 200%-equivalent reflow, keyboard/focus, reduced-motion, and independent left/right gripper evidence.

## Acceptance gates

- All 30 portable task references complete from public `send_action` source in both hand-code and Blockly-generated forms without collision, early attachment, snapping, tunneling, symbolic transport, or hidden-grader/visible-state disagreement.
- Source generators are deterministic across two consecutive runs; no generated scenario JSON is hand-edited.
- OpenArm worktops and cradles are visually and collision-solid; close multi-view inspection shows neither gripper embedded at approach/contact/lift/place/release/retreat.
- Representative SO-101 and LeKiwi support-surface grasps are visibly and authoritatively clear; LeKiwi stow/watchdog behavior remains explicit.
- Run, Pause/Resume, STOP, Reset, collision fault, unsupported API, timeout, success, and reset each produce distinct immediate accessible feedback without inventing state.
- 3D, code, task context, primary action, recovery, and reachable bottom content remain usable at 1440x900, 1366x768, and a 200%-equivalent reflow.
- Final claims separate executed static, Node/runtime, browser/Pyodide, accessibility, performance, mobile, deployment, and physical-hardware evidence.

## Completion record

Completed 2026-08-23. All implementation gates above passed except the deliberately broader evidence categories explicitly left pending in the audit log: 30 individual browser screenshot sequences, screen-reader/axe, Lighthouse/performance, phone/mobile, deployment, and physical hardware. The generator double-run was stable for 61 files; 30/30 portable references passed in hand-code and Blockly form; representative current-origin Edge/Pyodide references passed for all three robot families; Chrome and Edge visual/contact/control evidence is retained under `design/audit/portable-python-2026-08-23/`.
