# Portable Python Fidelity Implementation Plan

Timestamp: 2026-08-23 11:05:22 -05:00

## Scope and learning contract

- Audience: learners moving ordinary synchronous Python between RoboBuddy's browser simulation and physical SO-101, LeKiwi, or OpenArm setups by changing external transport/workcell JSON, not source structure.
- Learning objective: use pinned public imports, configuration objects, methods, action/observation fields, control flow, return types, and supported ROS 2 source patterns while understanding the boundary between API compatibility and simulated behavior.
- Required learner behavior: execute complete scripts with `__name__ == "__main__"`, connect, command, observe, sleep/loop, and disconnect in `finally`; Blockly must generate and expose the same complete Python.
- Success: the hidden grader observes canonical plant/contact/object/fixture state; learner code contains no simulator-only grading or transport calls.
- User-facing claim: **API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.**

## Fidelity contract

- Tier: reference-calibrated kinematic digital model where immutable official sources pin geometry, frames, limits, and API behavior; response-rate values without official control data are labelled `configured`.
- Separate axes:
  1. Python source compatibility against LeRobot 0.6.1 and OpenArm ROS 2 0.9.2/Humble source patterns.
  2. Digital-model fidelity against independently pinned geometry/control sources and simulator-specific workcell configuration.
- Runtime: current static ES-module application, Pyodide 0.29.x Web Worker, current Chrome and Edge on the deployment-origin arrangement, default 1x simulation time.
- Canonical spatial units: metres/radians internally for the portable plant; renderer boundaries may convert to millimetres/degrees. LeKiwi world axes are +X forward, +Y left, +Z up, positive yaw counter-clockwise.
- Canonical time: seconds on a versioned simulation clock; fixed 0.020 s plant tick independent of render rate. `time.sleep`, `time.monotonic`, and `time.perf_counter` use simulation time; `time.time` remains wall time.
- State transition: `send_action` validates the pinned public schema, performs only source-equivalent clipping, changes commanded targets, and returns immediately. Every fixed tick rate/acceleration-limits actual state, enforces joint limits, advances SE(2), checks incremental collisions, derives FK/contact/carry/fixture state, publishes observations/events, and stops at the last valid state on a simulator fault.
- Provenance labels: every material catalog value is `referenced`, `measured`, or `configured`, with API, geometry, and control sources kept separate.

## Implementation sequence and go/no-go

1. Preserve the recorded dirty baseline and inspect inherited generators/runtime ownership.
2. Reverify immutable upstream sources and derive small contract fixtures; do not vendor whole dependencies.
3. Build the smallest deployment-origin JSPI prototype. It must execute an official-style whole script using synchronous bridge calls and `time.sleep`, prove `__main__`, `finally`, errors, Pause/Resume/STOP/Reset, and pass in current Chrome and Edge. If `can_run_sync`/`run_sync` cannot work under `runPythonAsync` on the actual origin, log the blocker and stop the migration without introducing async learner syntax.
4. Add a versioned compatibility catalog plus separate SO-101, LeKiwi, and OpenArm profile modules.
5. Add one authoritative fixed-step plant and simulation clock. Route FK, contact, renderer snapshots, object/fixture state, UI, and grading through it.
6. Inject exact `lerobot.*`, constrained `rclpy`, message, and action import paths in the worker. Keep all runtime-only attachment and bridge data server/worker-side.
7. Migrate scenario generators and Blockly to complete portable source. Preserve old drafts under their old keys and add versioned portable draft keys with explicit warning/export.
8. Replace symbolic transport/fixture/evidence calls in migrated SO-101, LeKiwi, and OpenArm content with physical-style commands and hidden state/event grading.
9. Independently inspect OpenArm left and right grippers from front, overhead, and oblique views; verify grasp/release from FK-derived contact and real gripper conditions.
10. Run focused contract, plant, time/control, contact, grading, generation, build/static, and actual Chrome/Edge origin checks. Record at least one reference execution per robot and all unrun hardware validation.

## Controls

- Run/Resume continues supported bridge/sleep/future execution.
- Pause freezes simulation time, plant ticks, compatible sleeps, and supported ROS futures while preserving state; it is cooperative at bridge/sleep points.
- STOP rejects pending calls, zeros mobile commands, freezes actual state, and terminates the Python worker; the existing hard timeout remains the guard for CPU-only infinite loops.
- Reset rebuilds the canonical baseline and worker, clearing timers, events, attachments, remote handles, and transient state without fabricating completion.

## Explicitly not simulated

- Rigid-body/contact dynamics, inertia, gravity loading, friction/slip, compliance, backlash, thermal/current behavior, motor firmware, controller-loop emulation, torque/velocity control, custom gains, payload certification, grasp stability, wear, damage, or collision recovery.
- Physical calibration, calibration transfer, motor setup, serial/CAN/ZMQ/socket transport, LeKiwi host transport, threads, real devices, real networks, camera sensing, datasets, policies, training, or hardware safety/certification.
- DDS, a ROS graph, launch, TF, parameters, services, MoveIt, real QoS/timing, or general ROS packages. The OpenArm feature is exactly an **OpenArm ROS 2 source-pattern compatibility profile**.
- Unmodelled sensing, odometry error, SLAM, wheel slip, dynamic balance, force/torque sensing, or plant equivalence. The implementation is not a digital twin.

## Focused acceptance cases

- Pinned imports/config defaults/schema/units/clipping/return types/errors for SOFollower, LeKiwiClient, and OpenArmFollower plus the constrained OpenArm ROS 2 profile.
- Immediate target return versus live actual observation; deterministic 20 ms ticks; velocity/acceleration and joint-limit enforcement; LeKiwi SE(2) and 500 ms watchdog.
- Simulation-clock sleep/monotonic/perf-counter behavior and wall-clock `time.time`; Pause/Resume/STOP/Reset including pending calls and CPU-only timeout boundary.
- Incremental collision stop at last valid state; FK contact plus real close/latch requirement; live carry and world-pose release; physically gated fixture changes; hidden grading only.
- Hand-authored and Blockly-generated reference scripts for every affected scenario, with invalid schema, camera, unsupported hardware, collision, failed grasp, and unsupported ROS creation cases.
- Browser-visible execution and multiple-view inspection on the actual target origin in current Chrome and Edge. Hardware smoke tests remain pending unless actual devices are used and recorded.

