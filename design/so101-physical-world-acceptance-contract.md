# SO-101 Physical-World Acceptance Contract

Status: implementation gate for the SO-101 equipment-handling repair.

This contract is judged from the authoritative fixed-step state and the visible browser scene together. A scripted event name, final object location, or passing grade is insufficient when the rendered contact is physically impossible.

## Scope and claim boundary

- Scope: SO-101 approach, contact, grasp closure, hold, lift, transfer, placement, release, unsupported release, collision response, STOP, and Reset for every SO-101 apparatus profile.
- Model: deterministic reference-calibrated kinematics plus configured rigid contact, nonpenetration, support, and vertical gravity rules.
- Units and time: millimetres, degrees, seconds, right-handed Y-up world, fixed 0.020 s plant step.
- Not established: force/torque control, friction coefficient, material compliance, deformation, breakage, payload rating, controller-current behavior, physical calibration, hardware reachability, or safety certification.
- Required learner-facing boundary: `API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.`

## Mandatory physical behavior

### 1. Approach and first contact

- The open gripper, wrist, servo housing, robot links, apparatus, work surface, and other apparatus remain nonpenetrating throughout the approach.
- Only the exact baked fixed-jaw and moving-jaw contact patches may enter the configured contact tolerance around the named grasp band.
- Broad link-name matches, tool-center proximity, frame visits, or same-side mesh samples cannot establish a grasp.
- The gripper's measured pinch axis must align with the apparatus's configured opposed-pinch axis before closure.

### 2. Grasp closure

- A valid grasp requires independent fixed-jaw and moving-jaw witnesses on opposite faces of the intended grasp band.
- The witnessed jaw gap must agree with the captured apparatus thickness within the configured contact tolerance.
- Contact penetration is limited to 1.0 mm per jaw. A command beyond physical closure is constrained at first valid opposed contact; it must not drive either jaw through the apparatus.
- The servo housing, palm, wrist, or any non-contact robot geometry touching the apparatus is a collision fault, not permitted contact.
- Attachment is created only after the opposed-contact constraint is valid. The attachment event records both contact witnesses, their sides, the captured thickness, the actual held gripper position, and the penetration bounds.

### 3. Holding, lifting, and carrying

- While the close command persists, the actual gripper state remains at the contact-limited hold position instead of closing through the payload.
- The payload follows the live FK tool transform through the contact-captured relative transform; it cannot snap to a frame, disappear, or follow a cached presentation transform.
- The opposed-contact hold remains valid throughout carry. Loss of either contact ends the hold.
- Robot/workcell, payload/workcell, payload/object, robot/object, and non-contact robot/payload collision checks remain active at every accepted 20 ms state.
- A colliding command stops at the last accepted state and cannot receive successful placement or grading credit.

### 4. Placement and release

- The payload reaches nonpenetrating stable support before release credit is possible: its configured bottom meets a real support surface, its center-of-mass projection is inside the supported footprint, and its allowed tilt/gap/penetration limits pass.
- Opening releases the payload when opposed contact is actually lost, at the live world pose. Release cannot wait for an unrelated arbitrary open threshold, and it cannot snap to a semantic destination.
- A supported payload remains at the released world pose while the fingers and arm retreat without contact.
- An unsupported released payload cannot remain suspended. It enters the configured vertical gravity response until it reaches a valid support or leaves the modeled workcell; an airborne release never counts as successful placement.

### 5. STOP and Reset

- STOP cancels future commands and freezes the last accepted robot, gripper, payload, contact, and gravity state without inventing completion.
- Reset reconstructs initial robot state, stable object poses, contact/hold constraints, free-fall state, faults, timers, and grading state.

## Required acceptance evidence

- Independent geometry proof from the pinned SO-101 baked fixed and moving jaw meshes; implementation labels are not the oracle.
- Negative tests for same-side contact, palm/servo contact, excessive penetration, overclosure, wrong grasp band, closure away from contact, airborne opening, payload/worktop collision, release teleport, and retreat contact.
- Every SO-101 reference performs opposed contact, contact-limited hold, continuous carry, support-first release, and clean retreat; all generated clients match their owning definitions.
- Browser inspection at 1440x900 and 1366x768 covers rest, open approach, first contact, closed hold, lift/carry, support contact, release, and retreat from front, top, close, and oblique views.
- Acceptance fails if a bottle or other apparatus visibly hangs from, intersects, or floats beside the gripper even when the UI reports success.

