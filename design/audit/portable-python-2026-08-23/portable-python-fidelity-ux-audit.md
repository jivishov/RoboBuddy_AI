# Portable Python fidelity and UX audit

Audit start: 2026-08-23 13:00 America/Chicago  
Robots: SO-101, LeKiwi, OpenArm  
Status: before-state recorded; implementation and after-state verification in progress.

## Before-state fidelity findings

| Severity | Finding | Reproduced evidence |
|---|---|---|
| P0 | Solid support surfaces make the current SO-101 reference collide; the OpenArm link/finger path penetrates a worktop. | Focused plant/reference failures plus current Chrome and Edge origin runs. |
| P0 | A collision fault is overwritten by disconnect feedback and rendered as `Ready`, allowing visible/editor/task state to disagree. | Current Chrome/Pyodide OpenArm run. |
| P1 | Interrupted OpenArm generation is non-deterministically partial and uses arbitrary 500 mm clearance plus 99-102 learner-visible micro-waypoints in only tasks 1-3. | Post-stop source/action inventory. |
| P1 | `contact_surface` collision uses sparse baked vertices described as dense; it can miss edge/face penetration and is weaker than the visible-solid contract. | Collision implementation inspection. |
| P1 | Attachment is proximity-plus-current-closure rather than an explicit contact-then-closure latch; carried object orientation is not represented. | Plant and equipment presentation inspection. |
| P2 | OpenArm visible support pads are inferred from frames while authoritative support proxy ownership is inconsistent after the interrupted edit. | Equipment scene/support-layout/source comparison. |

## Before-state UX critique

Personas considered:

- Jordan, first-time learner: needs a clear task, current checkpoint, primary action, and recoverable explanation without interpreting internal predicates.
- Alex, advanced Python user: needs efficient direct code access, stable drafts, truthful execution state, shortcuts, and a real `.py` export.
- Sam, keyboard/accessibility-dependent user: needs visible focus, semantic tabs, announcements, readable text/targets, and no nested-scroll traps.
- Riley, robotics educator/learner: needs visible contact to agree with grading and careful real-versus-simulated claim boundaries.

### Nielsen heuristic scores (0 severe failure, 4 strong)

| Heuristic | Before | Evidence |
|---|---:|---|
| Visibility of system status | 1 | Collision appears as editor error, task `DISCONNECTED`, and stage `Ready`. |
| Match with the real world | 2 | Physical-style source is strong, but raw predicate labels and penetrating geometry break the mental model. |
| User control and freedom | 3 | Run/Pause/STOP/Reset exist, but STOP is duplicated and fault recovery is unclear. |
| Consistency and standards | 2 | Python note describes async code although portable execution is synchronous; status surfaces disagree. |
| Error prevention | 1 | Impossible references run until collision; no preflight or clear recovery. |
| Recognition rather than recall | 2 | Task context stays visible, but 50 tasks, long expanded limitations, and internal checkpoint names increase recall burden. |
| Flexibility and efficiency | 2 | Direct Python and generated Blockly exist; missing `.py` export and keyboard tab navigation slow advanced users. |
| Aesthetic and minimalist design | 2 | Domain-specific workbench is calm, but all panels/details compete simultaneously. |
| Help users recover from errors | 1 | Collision details are buried/overwritten; primary corrective action is not stated. |
| Help and documentation | 3 | Fidelity/limitations are present, but too expanded and not prioritized around the current task. |
| **Total** | **19/40** | Critical truthfulness and recovery gaps dominate the baseline. |

### Cognitive-load checklist

| Item | Before |
|---|---|
| Clear single focus | Fail |
| Information chunked into manageable groups | Fail |
| Related controls grouped | Pass |
| Strong visual hierarchy | Fail |
| One primary action per state | Fail |
| Choice set kept purposeful | Fail |
| Minimal working-memory demand | Fail |
| Progressive disclosure | Fail |

Baseline: 1/8 clear passes.

### AI-slop verdict

Pass. The interface has a credible robotics-workbench identity and avoids neon/glass/gradient spectacle, generic AI copy, ornamental hero content, and game-like physical claims. Its problem is not generic visual branding; it is dense hierarchy, tiny controls/text, duplicated actions, and contradictory runtime truth.

## Prioritized before-state issues

- P0: physically impossible/colliding portable references.
- P0: authoritative collision fault overwritten or displayed as Ready/Disconnected.
- P1: source generation uses arbitrary clearance and mixed partial outputs.
- P1: current task/checkpoint/recovery is hidden behind dense expanded content.
- P1: keyboard focus, tabs, announcements, control sizes, and text size do not meet the supplied baseline.
- P1: no current portable Python source export; sync/async microcopy is wrong.
- P2: task selector exposes all 50 tasks instead of the current robot family.
- P2: duplicate STOP, fully expanded evidence/trace, and nested panel scrolling reduce inspectable 3D area.

## After-state

### Fidelity outcome

| Before problem | Safe implemented refinement | After evidence |
|---|---|---|
| SO-101 support adapters collided with the gripper/wrist. | Source-owned edge cradles and narrow tabs preserve an open pinch corridor; renderer and plant share the boxes. | Ten SO-101 references and family/programmability suites pass; representative Edge/Pyodide reference reaches authoritative completion. |
| OpenArm links/fingers entered a worktop; interrupted tasks used 99-102 arbitrary micro-waypoints. | Worktops remain fixed/solid; visible registration pins own object support; oriented collision and bounded mesh samples guard geometry; 16 semantic actions use direct collision checks and only a configured fallback transit plane. | Ten references, 4,224 trajectory samples, unsafe-below-table regressions, Chrome success, and paused Edge multi-view contact captures pass. |
| Attachment was current-proximity/current-closure and carried orientation was not authoritative. | Live open-contact latch followed by closure is mandatory; broken contact and starting closed fail; carried pose includes live socket rotation and releases in place. | Focused plant/contact/grasp/release tests plus Chrome/Edge attached-contact and released-success evidence pass. |
| Collision feedback could become `DISCONNECTED`/`Ready`. | Plant fault survives cleanup; state renderer is fault-first; paused/running state reads canonical plant state, including after camera changes. | Collision regression, current Chrome Pause/STOP/Reset/keyboard paths, and final full suite pass. |

No fixture, worktop, support, or task object is translated during execution to make a route pass. `contact_surface` remains solid to every link and finger. The one collision exclusion is the authored robot-mount contact.

### Nielsen heuristic scores after refinement

| Heuristic | Before | After | Evidence |
|---|---:|---:|---|
| Visibility of system status | 1 | 4 | Ready/running/paused/stopped/fault/success/reset are immediate, textual, announced, and renderer-consistent. |
| Match with the real world | 2 | 3 | Physical-style source, live contact latch, continuous plant, and fixed fixtures align; exact dynamics/hardware remain explicitly unclaimed. |
| User control and freedom | 3 | 4 | One STOP plus Run/Pause/Resume/Reset, keyboard equivalents, stable draft, and camera reset. |
| Consistency and standards | 2 | 4 | Portable sync copy, action hierarchy, checkpoint language, and all status surfaces agree. |
| Error prevention | 1 | 3 | Collision-checked generation and last-safe-pose faults prevent authored failures; arbitrary learner routes can still fault honestly. |
| Recognition rather than recall | 2 | 4 | Current-robot tasks, one current checkpoint, human labels, visible state, and next recovery action. |
| Flexibility and efficiency | 2 | 4 | Direct Python, Blockly-to-Python, `.py` export, shortcuts, drafts, and authored inspection views. |
| Aesthetic and minimalist design | 2 | 3 | Existing technical language is preserved; progressive disclosure reduces competition, though this remains a deliberately information-dense workbench. |
| Help users recover from errors | 1 | 4 | Collision pair, last-safe-pose language, Reset-first recovery, and preserved learner source. |
| Help and documentation | 3 | 4 | Simulation/hardware boundary, fidelity tier, safety, provenance, requirements, and checkpoints remain reachable. |
| **Total** | **19/40** | **37/40** | Remaining points reflect bounded kinematic fidelity and intentional workbench density. |

### Cognitive-load checklist after refinement

| Item | Before | After |
|---|---|---|
| Clear single focus | Fail | Pass |
| Information chunked into manageable groups | Fail | Pass |
| Related controls grouped | Pass | Pass |
| Strong visual hierarchy | Fail | Pass |
| One primary action per state | Fail | Pass |
| Choice set kept purposeful | Fail | Pass |
| Minimal working-memory demand | Fail | Pass |
| Progressive disclosure | Fail | Pass |

After: 8/8 clear passes. AI-slop verdict remains Pass: no rebrand, glass/neon spectacle, ornamental cards, game language, or inflated physical claim was introduced.

### Executed verification

- Owning generators: stable hashes for 61 definition/generated/index files across two consecutive complete passes.
- Node/static/runtime: focused SO-101, LeKiwi, OpenArm, compatibility, unsafe-collision, workbench UX, 30/30 hand-code + Blockly references, `validate:v2`, and final `test:v2:all` all pass.
- Installed Edge current-origin Pyodide: representative SO-101, LeKiwi, and OpenArm compatibility/Blockly/full-reference executions pass without console exceptions.
- Chrome current-origin OpenArm: actual run success 6/6; live Pause stability; camera-state consistency; STOP at actual pose; Reset/draft preservation; keyboard control path.
- Visual: Chrome 1440x900 and 1366x768; Edge left/right contact across all five inspection views; completed release/retreat; DPR-2 200%-equivalent/reduced-motion capture.
- Export: Edge downloaded and verified the 936-byte OpenArm Python source.

Screenshots and the exported source are stored beside this report. The Edge contact sequence is in `edge-openarm-contact/`.

### Remaining limitations

- Structural geometry uses OBB/capsule collision. Curved contact supports use 96 bounded baked samples per part, not triangle-mesh continuous collision or dynamics; visual acceptance remains required.
- The configured registration pins do not model forces, friction, gravity, compliance, payload, stability, motors, control loops, sensing, calibration, or physical safety.
- All 30 references have Node/runtime hand-code and Blockly execution evidence. Browser screenshot sequences cover OpenArm task 01 deeply and the three families representatively, not all 30 tasks individually.
- Executed accessibility evidence covers keyboard/focus, live status text, reduced motion, target size, and 200%-equivalent reflow. Screen-reader, axe, Lighthouse/performance, phone/mobile, deployment, and physical hardware were not run.
- Public claim: **API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.**
