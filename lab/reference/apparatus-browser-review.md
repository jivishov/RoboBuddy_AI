# Apparatus browser review

Date: 2026-08-12

Scope: integrated RoboBuddy laboratory workcells rendered with the current robot rigs. This is an agent-vision review of procedural educational props against the admitted Lab Studio single-view references; it is not a pixel-aligned replica score.

## Review contract

- Critical systems: silhouette identity, companion-hardware completeness, functional socket placement, station separation, and material-family readability.
- Decision: continue for the integrated simulation catalog.
- Estimated fidelity: 0.75–0.84 for the reviewed identity-bearing families at workbench scale. This means the objects read correctly and local details are approximate; it is not a claim of photorealism or reference-exact dimensions.
- Known limit: no standalone fixed-camera comparison sheet or multi-angle per-object scoring was produced. Single-view references do not establish hidden geometry.

## Reviewed workcells

- Analytical balance: raised square pan, ivory/charcoal housing, display, and buttons remain legible. A guided run visibly seated the watch glass on the pan rather than on the station floor.
- Spectrophotometer: control/display region and distinct sample-compartment bay read separately. A guided run visibly inserted the cuvette into the authored bay socket.
- Titration: stand, support rod, burette tube, stopcock region, filling funnel, and receiver clearance remain connected as one apparatus system.
- Vacuum filtration: filter flask, side arm, Buchner funnel, paper, and vacuum-source context remain distinguishable; the OpenArm station was moved clear of the rotating base.
- Mobile/humanoid logistics: secured carriers use visible lids, handles, clasps, and destination fixtures rather than generic unlabeled boxes.

## Browser evidence

- Representative initial scenes reviewed for Arduino Arm, SO-101 Follower, LeKiwi, OpenArm V2 Bimanual, and Unitree G1.
- Interaction states reviewed for grasp/place on the balance and grasp/insert on the spectrophotometer.
- Expanded full-window scene reviewed for cuvette/instrument and OpenArm/vacuum-filtration workcells.
- Layout reviewed at 1366×768, 1024×768, and 768×1024.
- Console errors after final reload: zero.

## Final action-contact review

- Arduino Arm: the whole arm remained above the work surface while the watch glass rose on a visible contact lift, attached at the real gripper socket, followed the live end-effector, and lowered onto the analytical-balance pan before release.
- SO-101: a four-command grasp/carry/insert sample reached the spectrophotometer checkpoint with the cuvette visibly seated in the authored bay and no browser warning/error.
- LeKiwi: the beaker remained attached after grasp; Pause reported the preserved held state, Resume continued, STOP preserved the recoverable state, and Reset restored the authored initial scene.
- OpenArm V2: separate left- and right-effector grasps completed in one bimanual sample, leaving the volumetric flask held by Left and solvent bottle held by Right. No canonical joint or limit data changed.
- Unitree G1: the grounded humanoid completed secured-rack pickup, transport, release, and home. The visible lift performs the fixed-hand carrier handoff; this is logistics choreography, not fine manipulation or dynamic balance.
- Expanded-scene enter/exit completed after the G1 trace. The final state showed the carrier at the instrument destination and the humanoid grounded at home.
- STOP during an active Arduino grasp restored the presentation root and removed the transient lift; the logical held state remained recoverable until Reset returned the apparatus to its authored start.

Final post-change browser coverage: 50 Ready scenes at 1366×768, plus 10 first/most-complex representative scenes at each of 1024×768 and 768×1024. All reviewed scenes retained the canvas and stage-local STOP with no horizontal overflow or load error. The accumulated warning/error log was empty. The observed page-asset inventory contained no serial, hardware, bridge, virtual-leader, WebSocket, or local hardware-endpoint asset.

## Remaining approximation

- Glass wall thickness, hidden connectors, brand markings, exact capacities, and true manufacturer dimensions are not reconstructed.
- No fluid surface dynamics, force response, rigid-body settling, or photometric material calibration is claimed.
- Apparatus uses low-cost real-time geometry and restrained labels so all five current robot rigs remain usable in the shared workbench.
- Contact lifts and robot-root offsets are lab-only presentation aids. They do not establish inverse-kinematic reachability, collision-free paths, torque safety, rigid-body contact, or physical apparatus support.
