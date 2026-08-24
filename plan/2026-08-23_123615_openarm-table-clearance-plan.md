# OpenArm Table-Clearance Refinement Plan

Timestamp: 2026-08-23 12:36:15 -05:00

Execution status: implemented and focused verification complete on 2026-08-23; physical hardware validation remains pending.

## Scope and fidelity contract

- Audience: learners running ordinary synchronous physical-style OpenArm Python in the ScenarioV2 browser workbench.
- Defect: during approach, grasp/latch, carry, release/place, or retreat, the OpenArm fingers or nearby distal-arm geometry can intersect a worktable even though contact, attachment, rendering, UI, and hidden grading are intended to share one authoritative plant.
- Outcome: both left and right OpenArm chains must remain outside configured table volumes on every accepted 20 ms plant tick; contact with a grasped object must remain distinct from table collision.
- Fidelity tier: reference-calibrated kinematic digital model for the pinned OpenArm geometry and joint limits, with conservative collision proxies and workcell surfaces explicitly configured. This is not dynamics, collision recovery, force control, safety certification, or a digital twin.
- Canonical units/frames: metres and radians in the portable plant; configured workcell geometry is converted once at the boundary. FK is authoritative for link, finger, tool, contact, carried-object, and rendered poses.
- Constraints: prevent penetration in the authoritative plant, retain the last valid state on collision, require FK contact plus valid gripper closure for attachment, release at the actual accepted world pose, and minimize base_yaw/J5/J7 motion when reachability allows.

## Implementation sequence

1. Reproduce and quantify the screenshot poses against the current left/right FK, renderer transforms, collision proxies, support layout, scenario frames, and plant fault behavior.
2. Identify whether table-top collision geometry, finger proxies, accepted-state synchronization, or source action generation is incomplete.
3. Repair the owning authoritative plant and any source-owned action generator needed for collision-clear approach/contact/lift/carry/place/release/retreat paths; regenerate only scoped OpenArm outputs.
4. Add focused left/right tests covering table-clearance samples, contact/latch distinction, release at accepted pose, collision fault retention, and J5/J7/base_yaw restraint.
5. Run deterministic generation, OpenArm family/reference tests, static checks, and fresh browser-visible inspection from front, top, and independent left/right oblique views.

## Acceptance cases

- No accepted OpenArm finger, palm, wrist, or relevant distal-link proxy penetrates either configured table during any of the ten reference executions.
- Direct commands that drive either gripper through a table stop at the last valid tick with an honest simulator collision fault and do not attach, place, grade, or visually continue.
- Valid contact closes/latches only the intended left or right object; carry follows the live accepted tool frame; open/release leaves the object at its accepted world pose; retreat remains table-clear.
- Left and right grippers are inspected independently from multiple views rather than inferred from mirrored labels or transforms.
- Existing user-facing limitation claim remains unchanged; physical hardware and dynamics validation remain pending.

## Not simulated

Rigid-body contact dynamics, compliance, friction, grasp forces, payload deflection, contact response/recovery, motor/controller behavior, calibration uncertainty, MoveIt planning, physical collision certification, damage, and hardware validation.
