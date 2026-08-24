# Lab Tasks UI/UX audit

Date: 2026-08-23  
Primary target: 1536 x 864, with 1440 x 900 and 1366 x 768 stress checks  
Surface: `lab-scenarios.html` catalog and `lab-workbench.html` Blockly workbench  
User goal: choose an appropriate robot task, understand what success means, program it, run the simulation, and interpret the result without losing task context.

## Evidence captured in this run

1. `01-catalog-1536x864.png` - catalog, Arduino Arm guided task, 1536 x 864.
2. `02-workbench-guided-1536x864.png` - Balance Placement v2, Blockly, 1536 x 864.
3. `03-workbench-challenge-1536x864.png` - Fixture-Assisted Gravimetric Workcell, Blockly, 1536 x 864.
4. `04-workbench-challenge-1366x768.png` - same challenge at the smaller laptop viewport.

All four saved files were opened and visually checked after capture. The 1440 x 900 state was inspected and measured live but is not included as a separate screenshot.

## Overall verdict

The product has a sound expert-workbench model: task guidance, program construction, simulation, and evidence are simultaneously available, the simulation boundary is explicit, and the selected/current states are legible. The main problem is not missing capability; it is competition among too many persistent layers. Task titles lose to metadata, action clusters wrap, technical boundaries precede the student task, and the evidence region creates another scroll context. The result is effective for a patient expert but unnecessarily slow and tiring for a student on a 15-inch laptop.

## Flow health

1. **Choose robot and task - Needs major refinement.** Robot choices and ordered difficulty are clear, and full-row targets are generous. However, all 10 OpenArm titles were ellipsized at both 1536 x 864 and 1440 x 900. In the measured first row, the title received only 64 px of its 178 px content width at 1536, and 40 px at 1440. Repeated fidelity metadata occupies the space needed to identify the task.
2. **Review details and enter the workbench - Needs refinement.** Safety, assistance, fidelity, and provenance establish trust. The primary choices are only 34 px tall and are anchored at y=805 in the 1536 x 864 frame, far from the selected row and title. That travel distance and the weak action hierarchy slow the most common transition.
3. **Understand a guided task - Mixed.** Progress, robot identity, challenge level, and checkpoint states are visible. Code and simulation remain side by side. Yet expanded limitations and safety copy appear before the actionable checkpoints, and generic labels such as `Observable outcome: object_at` require students to translate implementation vocabulary into a goal.
4. **Program and run - Mixed.** Blockly/Python separation, a dominant teal Run button, explicit Stop/Reset, disabled Pause, draft persistence copy, and visible keyboard shortcuts in the implementation are useful signifiers. At the tested laptop sizes, 22 of 30 visible interactive targets had either width or height below 44 px; the camera buttons were 30 x 30 and the run controls were 34 px tall. The editor action bar wraps even at 1536 x 864, placing Generate Python on a second row.
5. **Observe simulation and evidence - Mixed.** The 3D scene is large and persistent, state/evidence/trace are logically related, and status copy exposes home/attachment state. Two identically named Simulation Stop buttons plus the ordinary Stop create an avoidable semantic conflict. At 1366 x 768, the evidence viewport was 203 px high for 376 px of content and sat inside the fixed workbench, while all three evidence groups were expanded.
6. **Use the challenge at smaller laptop size - At risk.** At 1366 x 768, the task panel was 246 px wide, editor 394 px, and simulation/evidence 568 px. The procedure viewport showed 618 px of 1,194 px; the top controls wrapped and placed the emergency stop on a separate row. The core task remains possible, but reading, aiming, and maintaining context become materially harder.

## Confirmed strengths

- The high-level mental model is natural: choose a task, program it, run it, observe the apparatus, and inspect evidence.
- The simulation-only status and physical limitations are not hidden, which protects trust and scientific fidelity.
- Selected robot/task states use a consistent teal signifier, and catalog rows provide large hit areas.
- Code and 3D output stay visible at the same time; this supports rapid action-feedback learning.
- The DOM includes a skip link, labelled regions, selected states, live status regions, icon-button accessible names, and a shared 3 px focus-visible outline.
- Escape and Control+S shortcuts are implemented, and Pause visibly communicates its unavailable state before a run.

## Highest-impact UX risks

### 1. Identification is subordinate to metadata

The catalog makes the task name the narrowest portion of each row. Ellipsis removes the words that differentiate several OpenArm tasks, while identical morphology/fidelity text repeats 10 times. This increases search time and forces selection-detail ping-pong.

**Refinement:** give the title one or two full lines with objective and level directly beneath it. Move repeated robot fidelity to one robot-level disclosure. Keep provenance in details, not in every scanning row.

### 2. Action signifiers are available, but not placed for the task

The catalog's Open actions are visually clear but remote. In the workbench, Run is visible but small, and two emergency-stop signifiers compete with each other while an ordinary Stop sits elsewhere.

**Refinement:** place the primary language action beside the selected task heading and make it at least 44 px tall. Use one persistent, visually unmistakable Simulation Stop. Keep the ordinary program Stop adjacent to Run and label the difference in plain language.

### 3. The task rail spends scarce attention on reference material

Limitations and safety are important, but expanded reference text precedes the current checkpoint. Five of six challenge checkpoints use raw predicate names. Students must keep the procedure, editor, scene, and evidence state in working memory while scrolling nested regions.

**Refinement:** pin the current step and progress at the top of a compact task rail; collapse Task details by default; render human-readable checkpoint copy while preserving raw predicate ids in an optional technical view. Safety remains persistently reachable and opens without losing work.

### 4. Laptop sizing increases aim and reading effort

The 44 px comparison is a comfort/target-size heuristic, not Fitts' Law itself. The Fitts risk comes from the combination of 30-34 px targets, repeated long cursor travel across three panes, and frequent actions. Text reaches 9.76 px in checkpoints and state tables.

**Refinement:** use 44 px minimum frequent controls, 48 px for Run, 14-16 px body text, and at least 12 px secondary technical text. Put camera toggles in one compact labelled group and keep the most frequent controls near the editor/scene boundary.

### 5. Responsive behavior preserves everything instead of preserving priority

At 1440 x 900, the topbar becomes a 94 px wrapped control stack, and at 1366 x 768 the emergency stop occupies its own row. The workbench retains all toolbar actions, all 50 task choices, three expanded result groups, and all reference copy.

**Refinement:** scope the in-workbench task switcher to the current robot; move legacy export and low-frequency actions into a clearly labelled More menu; use Objects, Evidence, and Trace tabs or a contextual drawer; keep the topbar on one line across the three target viewports.

## Accessibility risks

- **Target size:** frequent controls and disclosures are 30-34 px high. This is a visible motor-comfort risk and should be verified against the chosen accessibility target.
- **Text size and zoom resilience:** checkpoint states, table labels, and several technical strings render between 9.76 and 11.68 px. A 200% zoom and browser text-spacing test was not run.
- **Listbox keyboard model:** all 10 catalog options currently have `tabIndex=0`. Arrow/Home/End handling exists, but the composite widget does not use a roving tab stop, so keyboard users must traverse every option.
- **Tabs keyboard model:** the language tabs update `aria-selected` and roving `tabIndex`, but the current event binding only handles click; ArrowLeft/ArrowRight/Home/End behavior was not found.
- **State changes:** live regions and disabled states are present, but announcements during a real run were not tested.
- **Contrast:** screenshots show generally strong dark-on-light contrast, but no computed contrast audit was performed.

## Refined design contract

### Catalog

- Keep the existing left product navigation, teal/white/navy palette, typography, simulation boundary, URL parameters, and task data.
- Replace the permanent morphology column with a compact horizontal robot selector above a two-column task list/detail layout.
- Let task titles wrap to two lines; show objective, level, and rank before technical metadata.
- Put **Start in Blockly** next to the selected title and expose Python as a clear secondary choice.
- Collapse robot fidelity, migration, and provenance into one discoverable technical disclosure.

### Workbench

- Preserve a focused two-pane core: program editor and 3D simulation remain visible together.
- Use a compact left task rail with overall progress and the current step pinned; Task details contains limitations, safety, provenance, and raw predicate ids.
- Use one persistent 48 px Run action, ordinary Stop/Reset beside it, and one global Simulation Stop. Do not duplicate the emergency control inside the stage.
- Keep a 44 px target minimum for frequent controls and prevent the topbar/editor controls from wrapping at 1536, 1440, and 1366 widths.
- Replace three expanded evidence accordions with Objects/Evidence/Trace tabs or a single contextual drawer.
- Humanize checkpoint language without modifying scenario ids, grading predicates, evidence data, simulation behavior, or renderer behavior.

## Critical fidelity review of the recommendation

- The three-column model is not inherently wrong; it exposes the complete learning loop. The redesign should compress and prioritize it, not hide code or simulation behind mutually exclusive pages.
- Safety and provenance are not clutter to delete. They should move into stable progressive disclosure so student focus improves without weakening scientific boundaries.
- A 44 px rule alone will not make the workbench natural. Frequent controls also need shorter pointer travel, stable placement, distinct semantics, and visible state.
- Student-first language must be a presentation layer. Raw ids and exact evidence remain available for debugging and assessment fidelity.
- The redesign must not invent capabilities, hardware behavior, physics, data, robot morphology, or new learning claims. It is a layout, copy, affordance, and interaction-hierarchy refinement over the current implementation.

## Evidence limits

This audit covered the catalog and two initial Blockly workbench states in the in-app browser. It did not execute a program, grade a result, test Python/Pyodide, test screen readers, verify color contrast numerically, run browser zoom/text-spacing checks, measure pointer trajectories with users, test touch/mobile, or claim WCAG conformance. The findings about target size, reading comfort, responsive reflow, and keyboard implementation are risks supported by captured UI and current source inspection, not a substitute for assisted-technology or learner usability testing.
