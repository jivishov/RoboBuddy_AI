# Robot Manipulation Fidelity Lessons Learned

Status: engineering guidance derived from four connected OpenArm v2 remediation sessions on 2026-08-14.

Review status: critically rechecked on 2026-08-15 against the task records and current owning implementation. Statements below distinguish completed proof from remaining limitations.

Scope: use this guidance when refining OpenArm or another fixed-base, mobile, single-arm, bimanual, or humanoid robot; its rendered model; its environmental scene; and its pickup, carry, process, placement, and retreat actions.

Claim boundary: these lessons cover rendered geometry, deterministic educational kinematics, collision proxies, logical contact, and browser-observed choreography. They do not establish hardware behavior, dynamics, force, torque, payload, calibration, control stability, or physical safety.

## 1. What the four sessions solved

### Session 1 — Programmability foundation

Thread: `01a0004b-0efd-7273-907f-e7671ec004d8`

Problems solved:

- OpenArm transports depended on hidden seed and place-frame values; ordinary Blockly and Python programs failed.
- IK and path collision checks evaluated a chain-only state, so the inactive arm could silently revert to defaults.
- Placement semantics depended on explicit magic values instead of the authored frame relationships.
- Generated starters exposed planning seeds and graded evidence answers.
- Blockly could not express the complete transport call.
- Process state omitted the runtime object/fixture association needed by the scene and feedback UI.
- Several rendered apparatus types lacked usable grip sockets or support-height information.

Methods that worked:

- Centralized IK acceptance, interpolation, RRT, and transport cursor handling around the complete bimanual joint state.
- Added deterministic bounded retries while preserving explicit `seed=0` and existing attempt-zero behavior.
- Resolved placement contact by semantic frame metadata and rejected ambiguous matches.
- Separated authored validation/reference data from sanitized learner-visible starter data.
- Extended Blockly and generated Python together, including compatibility for old drafts.
- Made process events retain object and fixture identity.
- Refreshed only generator-owned OpenArm client scenarios and compared two generated hash sets.
- Verified engine, browser/Pyodide, Blockly, and grading behavior separately.
- Synchronized the scoped implementation from its worktree into the saved checkout and SHA-256 checked 39 copied code files before beginning the next fidelity audit.

Critical limitation exposed later:

- Functional and browser-programmability success did not establish acceptable workcell geometry or robot morphology. Large scene intersections survived this session.
- Exact copy hashes proved transfer integrity only; they did not prove that the transferred behavior or visuals were correct.

### Session 2 — Workcell, contact, and visible carry fidelity

Thread: `01a000b5-b9e5-7843-a332-0faa421200cc`

Problems solved:

- Tall station columns, aprons, shelves, and a divider visibly intersected the base, arms, and grippers.
- Planning targeted an unsuitable mid-finger/J7-relative point instead of the measured pinch/contact point.
- Apparatus support heights and grip positions did not consistently follow rendered sockets and footprints.
- Carried objects could inherit arbitrary orientation from position-only IK.
- The environment's visible structure and its collision representation were not sufficiently aligned.

Methods that worked:

- Treated the user's screenshot as a failed acceptance result and reproduced it over HTTP before editing.
- Replaced the obstructive station with two simple floor-anchored tables placed outside the robot body and observed arm paths.
- Derived support layout from authored object footprints, grip sockets, and frame heights.
- Kept visible worktop/leg construction and authored collision descriptions on the same box dimensions. The focused proof checked all workcell proxies at rest and structural legs along executed trajectories; the worktops remained intentional contact surfaces rather than fully forbidden obstacles.
- Corrected the end-effector target to the pinch/contact offset.
- Preserved an attachment-relative transform so carried apparatus stayed upright and continuous.
- Added rest-pose, structural-leg trajectory, support-containment, and multi-view browser checks.

Critical limitations exposed later:

- The simpler scene removed gross intersections but did not by itself prevent gratuitous joint motion.
- Browser checks concentrated on workcell separation and carried objects; they did not isolate finger chirality well enough to catch the right-gripper defect.

### Session 3 — Motion continuity and attempted bilateral gripper correction

Thread: `01a000e5-e362-7240-8e94-c5e93d972deb`

Problems solved:

- Simple transports used unnecessary shared base yaw and gratuitous J5/J7 motion because randomized IK seeds could change nominally inactive joints.
- Handoff and place-contact frames did not express an unambiguous lift, transfer, vertical placement, and retreat sequence.
- The planner needed continuity preference without making reachable tasks impossible.

Methods that worked:

- Measured joint-family motion rather than labeling every visible articulation as “dancing.”
- Added a staged continuity policy: stable base/distal wrist first, fixed-base fallback next, unrestricted fallback only when required.
- Kept legitimate shoulder, elbow, and wrist-pitch motion available for reachability.
- Authored clearance approach, vertical contact, reverse lift, short level transfer, vertical place, and reverse retreat as distinct frames.
- Added per-sample continuity bounds and deterministic path assertions.
- Re-ran tasks uninterrupted after discovering that pausing during attachment could contaminate the inspection state.

What did not work:

- A symmetric 180-degree local-Y J7 correction was applied to both arms. This treated a finger-mesh chirality problem as a rigid wrist-mount problem.
- The orientation test relied on declared facing metadata rather than independent baked geometry, so implementation and oracle could be wrong together.
- Multi-view browser inspection was still insufficiently discriminating: the left claw looked correct, but a later top view showed the right curved faces pointing outward.

Lesson:

- A rigid transform can rotate a whole gripper, but it cannot change whether two complementary finger curves face toward or away from their shared pinch plane. Left/right visual symmetry must be proven from transformed geometry, not inferred from matching quaternions or labels.

### Session 4 — Right-gripper mesh/frame correction

Thread: `01a00105-e8b4-70c0-b8c0-2a2361875940`

Problem solved:

- The unmirrored right hand bound the same inner/outer raw meshes as the mirrored left hand. Its distal hooked regions therefore diverged from the pinch plane even though the whole wrist mount had been rotated.

Methods that worked:

- Reproduced the defect at rest and during right-hand contact/carry/place from top, front, opposing oblique, and close-up views.
- Decoded the baked finger vertices and compared stable distal-region centroids with hinge and pinch-plane positions.
- Traced scale signs, transforms, winding/normals, J7 base quaternions, FK offsets, collision proxies, and sockets as one chain.
- Distinguished renderer part binding from wrist orientation and IK motion.
- Restored the canonical J7 identity and swapped the complementary right inner/outer mesh bindings in the owning rig configuration.
- Applied corrected part bindings centrally so canonical renderer parts, render-geometry samples, and derived finger collision boxes consume the corrected geometry. The FK chain and fingertip offset remained canonical and were checked separately against the pinch/socket frame; the mesh swap did not itself alter FK.
- Replaced the tautological facing assertion with transformed-vertex, signed-volume/winding, collision-enclosure, pinch-centering, and right-hand runtime checks.
- Verified two different right-hand objects through contact, attachment, carry, placement, detachment, and retreat.

Remaining boundary:

- This proves the current rendered/kinematic behavior, not physical grasp stability or hardware performance.

### What remains unproven after the four sessions

- The finger geometry is static during these transports. Logical attachment follows visible contact, but no jaw-closing sequence, contact force, friction, grasp stability, or slip is simulated.
- Collision coverage uses simplified capsules and boxes rather than mesh-level contact. Current focused runtime assertions check the complete workcell at home and the structural legs along trajectories; browser inspection supplies the visible worktop/contact check.
- The final right-gripper browser acceptance covered two representative tasks, not a full multi-phase, multi-view browser pass of all ten OpenArm tasks and every apparatus morphology.
- OpenArm records the logical detach destination as the handoff/destination frame while the renderer preserves the world transform reached at the distinct place-contact frame. This avoids a visible release jump, but the semantic destination and physical placement pose remain separate concepts and should be modeled explicitly in future refinements.
- The current apparatus meshes, sockets, footprints, collision proxies, and clearances are educational approximations. They are not dimensional validation against physical equipment or the OpenArm hardware.
- Pause/resume behavior was not accepted as a manipulation-fidelity mechanism. One paused inspection produced an inconsistent ready/attached state; uninterrupted reruns were used for the final motion evidence. Pause/resume needs its own focused validation if it becomes part of acceptance.

## 2. Reusable engineering principles

### 2.1 Treat fidelity as a chain of correspondence

A manipulation result is credible only when these layers agree:

1. canonical mesh parts and local transforms;
2. rig hierarchy, joint origins, axes, limits, and base mounts;
3. FK end-effector, fingertip, pinch, and tool frames;
4. collision proxies derived from the corrected geometry;
5. object grip sockets and attachment transforms;
6. authored pickup, process, placement, and retreat frames;
7. planner state, interpolation, and collision evaluation;
8. runtime contact/attach/detach events;
9. visible renderer state in the real browser.

A change in one layer requires an explicit audit of every downstream consumer. Do not “fix” a mismatch with a camera angle, per-scenario offset, hidden animation, or duplicated compensating transform.

### 2.2 Classify the defect before changing transforms

Use the observed symptom to select the owning layer:

| Symptom | First suspects | Do not assume |
|---|---|---|
| Entire hand has the wrong pose | wrist/tool mount, base quaternion, joint origin | finger mesh itself is wrong |
| Fingers curve away from each other | part binding, local scale/mirror, mesh chirality | a wrist rotation can repair it |
| Planner reaches J7 but misses the object | end-effector/pinch offset | object frame alone is wrong |
| Object jumps at attach/detach | event ordering, socket transform, relative attachment matrix | animation timing alone is wrong |
| Object is carried tilted | attachment orientation contract, target orientation handling | position-only IK is visually sufficient |
| Robot intersects furniture | frame convention, support derivation, visible/collision parity | a different camera is acceptable |
| Robot “dances” | seed policy, branch selection, inactive joints, shared-state cursor | all moving joints are unnecessary |

### 2.3 Prove mirroring and chirality from geometry

For every mirrored or paired limb:

- Inventory raw part names, hierarchy, scale signs, determinant signs, and base quaternions separately for left and right.
- Identify stable named or geometric features: hinge region, distal curved region, jaw centerline, palm normal, tool axis, or asymmetric marker.
- Transform those features into the common hand/tool frame.
- Verify that closed-jaw distal features move toward the pinch plane and open-jaw features move away as intended.
- Check signed volume or transformed winding/normals when negative scale or part swapping is involved.
- Never use the same config field being tested as the test oracle.
- Never infer correctness from “same quaternion on both sides”; mirrored meshes often require different binding or transform logic.

Prefer a positive-determinant part swap when it expresses the source model's intended complementary geometry. Use negative scaling only when normals, winding, culling, collisions, and derived frames are all deliberately handled.

### 2.4 Keep one corrected renderer/model source

Apply model-specific corrections once, near canonical rig/model loading. Renderer parts, render-derived samples, collision proxies, and downstream geometry tests should consume the corrected result.

Avoid:

- a render-only correction while planning still uses the old frame;
- a collision-only offset that hides a visible intersection;
- a scenario-specific socket that compensates for a wrong tool frame;
- duplicate left/right conditionals scattered across renderer, planner, and tests.

### 2.5 Model intentional contact without disabling the environment

Contact surfaces require narrower rules than ordinary obstacles:

- Classify each proxy as structural, support/contact, keep-out, or purely presentational.
- Keep structural proxies active throughout planning and execution.
- Permit contact only for the named effector/object, named contact frame, and relevant phase.
- If a collision exception is required, scope it to the specific proxy or fixture surface. Do not exclude an entire workcell merely because one worktop is a contact target.
- Check all proxies at rest, all non-contact structure along the trajectory, and the intended contact relationship at the contact sample.
- Report simplified-proxy coverage accurately; leg-only trajectory assertions plus browser worktop inspection are not mesh-level collision proof.

### 2.6 Plan against the complete robot state

For bimanual or multi-chain robots:

- Merge a candidate chain state over the complete segment-start state before collision checking.
- Hold inactive joints at their actual segment-start values during interpolation and sampling.
- Merge the final chain result back into the persistent cursor; never replace the full cursor with a chain-only result.
- Evaluate inter-effector and environment clearance across every executed sample.
- Use sequential scheduling when the scene and tasks are authored for sequential manipulation; do not silently imply coordinated simultaneous planning.

The same rule applies to a mobile manipulator: arm planning must retain the current base pose, mast, torso, and inactive joints.

### 2.7 Prefer continuity, but preserve reachability

A useful selection order is:

1. nearest valid posture with stable shared base and distal wrist;
2. fixed-base solution with limited distal relaxation;
3. broader valid solution only when the earlier profiles cannot reach safely.

Continuity costs and locked-joint profiles must be explicit and observable in diagnostics. Do not globally freeze a joint merely because it moved unnecessarily in one task.

Measure:

- total and peak joint change by family;
- discontinuity between consecutive samples;
- distance from the segment-start posture;
- whether a fallback profile was used;
- deterministic repeatability for omitted and explicit seeds.

### 2.8 Author actions as physical-looking phases

For ordinary tabletop transport, use this semantic sequence unless the task requires another:

1. clearance approach aligned over the pickup;
2. controlled descent to pickup contact;
3. contact confirmation;
4. attachment only after contact;
5. reverse lift to clearance;
6. short transfer in a clear lane;
7. controlled descent to placement contact;
8. detachment immediately after placement contact;
9. reverse retreat with the object left at the authored support frame.

Required runtime invariants:

- No attachment before the matching contact event.
- No object disappearance/reappearance as a substitute for carry motion.
- The object remains socket-relative and continuous while attached.
- Placement uses the authored contact/support frame, not merely a nearby destination label.
- Detachment does not change the object's world pose.
- Retreat begins only after detachment and does not intersect the released object.
- Process events occur only after their authored transport prerequisites.
- A semantic destination/zone and the physical place-contact pose must be stored as separate named facts when they differ; a cached render transform must not be the only record of that distinction.

### 2.9 Build the environment from task and robot envelopes

Environment geometry is part of manipulation correctness.

- Derive support height from the object frame and its rendered grip socket.
- Derive worktop footprint from all supported object footprints plus deliberate margin.
- Place legs, aprons, shelves, dividers, guards, and fixtures outside the robot's rest envelope and sampled action paths.
- Give every visible structural obstacle a corresponding collision proxy with the same transform and dimensions.
- Test robot-vs-environment clearance at home and throughout representative trajectories.
- Inspect from views that reveal depth; a clean front view can conceal a side or top intersection.
- Prefer a simple, legible workcell over decorative structures that occupy the manipulation volume.

For mobile robots, also check approach corridors, turning footprint, sensor sightlines, base clearance, and whether arm reach assumes an impossible base pose. For humanoids, include torso, legs, fixed hands/tools, and support/contact assumptions without implying balance dynamics.

### 2.10 Make attachment geometry explicit

Each manipulable object should define, as appropriate:

- visible dimensions and scale;
- support footprint;
- grip socket position and orientation;
- attachment anchor;
- allowed effector/tool;
- authored initial and placement support frames.

At first valid contact, cache the object-to-socket relative transform. Reuse it throughout carry. At placement contact, preserve the world transform while changing logical ownership, then settle the object at the authored contact frame only if that equality is part of the scene contract.

### 2.11 Use non-tautological tests

Tests should derive facts from independent evidence:

- Decode actual mesh vertices rather than checking a `facesInward: true` label.
- Compare visible geometry with collision-proxy enclosure rather than checking that both share an ID.
- Compute socket-to-distal-center distance rather than checking that a socket field exists.
- Check event ordering and world-pose continuity rather than only final logical state.
- Check the logical destination and physical placement-contact frame independently when the model distinguishes them.
- Check full-state collision samples rather than chain-only paths.
- Re-run identical programs and compare trajectories rather than checking that a seed field exists.
- Validate generated files against the owning transform and verify two-run determinism.

A regression test that repeats the implementation's declaration is documentation, not an independent oracle.

### 2.12 Browser acceptance needs a matrix, not one screenshot

For at least two representative tasks per affected effector, inspect:

| Phase | Required observations |
|---|---|
| Rest | morphology, finger/tool orientation, robot/scene separation |
| Approach | clearance and absence of gratuitous branch changes |
| Contact | actual visible alignment before attachment |
| Carry | centered/socket-relative object, stable orientation, continuous motion |
| Place | descent onto the authored support/contact frame |
| Detach | no jump, disappearance, or interpenetration |
| Retreat | clean separation while the object remains stable |

Use front, side/rear oblique, top, and close-up views. Keep robot-left/robot-right labels or frame axes unambiguous when rotating the camera. Choose tasks by risk: include at least one asymmetric object and one object whose socket height, orientation, footprint, or clearance differs from the first.

Do not rely solely on paused animation snapshots. If pause/resume is not itself under test, also run the scenario uninterrupted and capture live phases without changing execution state.

### 2.13 Keep evidence layers honest

Report separately:

- Static evidence: schema, syntax, geometry arithmetic, transformed vertices, winding, generated-file correspondence.
- Node/runtime evidence: IK/path outcomes, collision samples, continuity, event causality, grading, deterministic generation.
- Browser/Pyodide evidence: real UI, generated program, visible scene, animation phases, console state.
- Unrun physical evidence: hardware reachability, dynamics, force, torque, payload, calibration, controller behavior, and safety.

Passing one layer never implies the others.

## 3. Values that must not be generalized blindly

The current OpenArm implementation contains useful but model/task-specific values, including the fingertip offset, clearance heights, transfer distance, table dimensions, separation thresholds, joint-change bounds, collision simplifications, and retry seeds.

When adapting to another robot or scene:

- Preserve the invariant or derivation method, not the number.
- Re-measure mesh features and tool frames from that robot's canonical source.
- Re-derive support heights and footprints from its objects.
- Recompute clearance from its actual geometry and authored action lanes.
- Re-tune continuity weights within its joint axes and limits.
- Revalidate both mirrored and asymmetric limbs independently.

## 4. Recommended refinement workflow

1. Preserve the checkout and inventory authored, generated, and unrelated dirty files.
2. Record the visible defect with task, phase, object, effector, and camera view.
3. Reproduce it in the real browser before editing.
4. Trace the full correspondence chain from mesh to runtime event.
5. State the evidence-based diagnosis and smallest owning correction.
6. Modify the owning rig/model, planner, scene factory, or scenario definition—not the camera or a one-off scenario visual.
7. Update all dependent frames, proxies, sockets, and tests.
8. Regenerate only affected generated artifacts from their sources.
9. If work moves between a worktree and saved checkout, compare the exact scoped file list and hashes, then re-run checks in the destination; transfer equality is not behavioral acceptance.
10. Run static and focused runtime checks.
11. Perform the browser acceptance matrix on multiple tasks and views.
12. Reinspect the dirty diff and report exactly what changed, what was preserved, and what remains unvalidated.

## 5. Definition of done for rendered manipulation fidelity

A refinement is complete only when all applicable statements are supported:

- The robot morphology is correct at rest from diagnostic views.
- Left/right or paired parts have independently verified chirality and transforms.
- FK, renderer, collision, fingertip/pinch, and socket frames correspond.
- Structural obstacles remain clear at rest and along sampled accepted paths; intended contact surfaces have explicit, phase-scoped contact rules.
- The object visibly contacts before attaching.
- Carry motion is continuous and socket-relative.
- Placement and detachment preserve the authored world/contact frame.
- Logical destination state and physical placement pose agree, or their deliberate distinction is explicit and tested.
- Retreat is clean and leaves the released object stable.
- Simple tasks avoid gratuitous motion while fallbacks retain reachability.
- Focused tests use independent geometric and behavioral oracles.
- At least two representative tasks pass the multi-phase, multi-view browser matrix.
- Generated artifacts match owning sources.
- Any copied implementation is revalidated in its destination checkout rather than accepted by hashes alone.
- Static, runtime, browser, and unrun physical evidence are reported separately.

Anything less should be described as partial or inconclusive rather than visually accepted.
