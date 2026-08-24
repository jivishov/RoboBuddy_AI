# SO-101 Physical-World Grasp Repair Plan

Timestamp: 2026-08-23 19:17:45 -05:00

Execution status: complete.

## Observed rejection

The reproduced task-1 contact state reports an attachment while the closed jaw penetrates the capped reagent bottle. The current contact oracle accepts broad body-name samples, does not require opposite faces, allows an 80 mm contact neighborhood, and lets the normalized close command drive through the configured rigid object.

## Implementation sequence

1. Preserve the inherited dirty checkout and record the pre-fix multi-view browser state.
2. Encode the physical-world acceptance contract in `design/so101-physical-world-acceptance-contract.md`.
3. Derive exact fixed/moving jaw contact witnesses and pinch geometry from the pinned baked SO-101 mesh correspondence.
4. Give each SO-101 object an explicit opposed-pinch band, captured thickness, tool alignment, and exact contact bodies in owning generated source.
5. Enforce target-only grasp orientation, non-contact robot/object collision, first-contact gripper clamping, contact-limited holding, live-pose release, and unsupported-release gravity in the authoritative 20 ms plant.
6. Regenerate only SO-101 definitions/clients/reference actions through their owning scripts and prove idempotence.
7. Add independent positive and negative geometry/runtime tests, then run focused and combined validation.
8. Repeat the browser acceptance matrix at both target viewports and report any remaining physical-model limits honestly.

## Completion evidence

- The ten-scenario SO-101 family passes exact opposed-jaw contact, collision-free approach/carry/retreat, live attachment-transform holding, support-first non-teleporting release, and the closure-away-from-contact negative case.
- A dedicated airborne-opening probe confirms unsupported detach, no placement credit, and immediate vertical gravity response.
- `npm run test:v2:so101` and `node tests/v2/portable-physical-rest.test.mjs` pass after final regeneration.
- A second generator/extractor pass leaves all 20 SO-101 source/generated scenario hashes unchanged.
- Chrome 151 completed the physical reference at 1440x900 and 1366x768 with rest/contact/release/complete multi-view captures, no console exceptions, and no skills shortcut in the official starter.
- The claim remains a configured rigid-contact browser simulation. No force, friction, compliance, controller-current, payload-rating, hardware-reachability, or safety-certification claim was added.

## Task 10 follow-up

- Reproduced a renderer/contact mismatch in Endpoint Assistant: the oracle used a 31 mm half-width at 82 mm while the rendered Erlenmeyer profile was only about 15.6 mm there.
- Centralized the renderer's radial flask profile, moved the grip to the real neck at 96 mm, and require both jaw witnesses to remain within 1.5 mm of that shared rendered surface before attachment.
- Browser and runtime verification now place the fixed and moving witnesses 0.14 mm and 1.02 mm from the rendered glass surface, respectively; task 10 carries and releases normally.
