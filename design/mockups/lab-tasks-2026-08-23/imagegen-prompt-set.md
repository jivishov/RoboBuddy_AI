# Lab Tasks workbench ImageGen prompt set

Date: 2026-08-23  
Use case: `ui-mockup`  
Reference image for all three generations: `design/audit/lab-tasks-2026-08-23/03-workbench-challenge-1536x864.png`  
Target: one 1536 x 864 laptop web-app screen per generation  
Generation mode: built-in ImageGen, one independent call per direction

## Shared visual and fidelity contract

- Create a realistic, production-quality, student-first redesign of the current RoboBuddy Lab Workbench, not concept art.
- Preserve the current dark navy product rail, teal/white/navy palette, RoboBuddy identity, DM Sans and IBM Plex Mono typography, low-radius controls, restrained dividers, and actual OpenArm V2 Bimanual scene.
- Preserve `Fixture-Assisted Gravimetric Workcell`, OpenArm V2 Bimanual, 0/6 initial progress, Blockly/Python, Objects/Evidence/Trace, the simulation-only boundary, and current task facts.
- Keep code and 3D simulation visible simultaneously.
- Use 14-16px body text, at least 12px secondary technical text, at least 44px frequent targets, one dominant 48px Run action, and one global Simulation Stop.
- Avoid toolbar/topbar wrapping, clipped titles, tiny tables, nested cards, gradients, decorative illustration, emoji, invented logos, watermarks, and unnecessary shadows.
- Keep safety, model limitations, provenance M/F/R/C, and raw predicate ids discoverable but secondary.
- Do not invent hardware, physics, measurements, scientific results, dates, robots, assets, features, or capabilities.

## Direction: Docked Focus

Saved image: `option-1-docked-focus.png`

Prompt-specific art direction:

- Keep the existing product rail, then a 220-240px task rail with 0/6 progress, robot identity, six student-readable steps, and collapsed Task details.
- Use a practical Blockly editor in the center and the existing simulation on the right.
- Put the stable Run/Pause/Stop/Reset strip at the bottom of the editor.
- Place Objects/Evidence/Trace as horizontal tabs below the scene, with Objects selected and the two existing carrier rows visible.
- Keep header, full title, current-robot selector, simulation chip, and one Simulation Stop on one line.
- Keep Load Starter, Save Draft, Generate Python, Blockly/Python tabs, and a More action for legacy export.

## Direction: Guided Cockpit

Saved image: `option-2-guided-cockpit.png`

Prompt-specific art direction:

- Keep the existing product rail, then a 200-220px guided step navigator, balanced editor, and equally prominent simulation.
- Add a thin progress/status band tying together `Step 1 of 6` and `Ready · home · No object attached`.
- Emphasize one current-step block and show remaining steps as a compact pending timeline.
- Use one stable command bar for Run/Pause/Stop/Reset and keep editor actions concise.
- Use a low-height contextual Objects/Evidence/Trace drawer spanning below editor and simulation with a one-line summary.
- Keep header and emergency control on one line.

## Direction: Command Canvas

Saved image: `option-3-command-canvas.png`

Prompt-specific art direction:

- Keep the product rail, then an ultra-compact 72-88px six-step map with step 1 selected and 0/6 progress.
- Put the exact current step, `Place empty filter-flask carrier at left contact.`, in one banner above the canvas.
- Use a 46/54 editor/simulation split and a no-wrap command strip across the top of the working canvas.
- Attach a slim contextual result tray to the simulation's right edge with labelled vertical Objects/Evidence/Trace tabs.
- Show only the two existing object/location pairs: `Empty filter-flask carrier - left_contact` and `Secured dry-tray carrier - right_contact`.

## Critical fidelity review

The generated images are authoritative for layout, hierarchy, spacing, control placement, and visual direction only. Image-generated text and state decoration are not scenario authority.

- Direction 1 most closely satisfies the complete six-step and tabbed-results contract, but any generic state reassurance in the generated table footer must not be copied into production without source support.
- Direction 2 is structurally useful, but several generated later-step labels drifted from the supplied scenario. Those labels are rejected and must be replaced with source-derived presentation copy during implementation.
- Direction 3 provides the strongest space efficiency, but generated green object markers must not imply checkpoint completion while progress remains 0/6. Production state signifiers must come from the real runtime.
- For every direction, the selected build must preserve raw ids, grading predicates, evidence data, safety boundaries, and simulator behavior from current source. No image-generated scientific or runtime claim should enter code.
