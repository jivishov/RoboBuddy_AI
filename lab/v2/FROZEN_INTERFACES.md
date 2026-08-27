# RoboBuddy Lab v2 Frozen Foundation Interfaces

Frozen from local foundation branch `codex/robobuddy-v2-foundation` after `npm run test:v2:foundation` passed on 2026-08-12.

Workers consume these interfaces. They must report a shared blocker instead of editing `lab/v2/`, `js/python-worker.js`, `simulator/js/arm-preview-3d.js`, any script under `scripts/`, the combined/generated catalog, or another robot family.

## ScenarioV2 source contract

Every authored source is JSON with `schema: "robobuddy.lab-scenario.v2"` and these required members:

- identity: `id`, `title`, `brief`, `robotId`, `rank`, `supersedes`, `assistanceLevel`;
- migration: `{ class: "A" | "B" | "C", legacyLearningObjective, redesignRationale? }`;
- canonical model: `{ id: robotId, sourceRevision }`;
- discoverable `frames` with finite `positionMm`, `role`, and `tolerance.positionMm`;
- visible `fixtures`, task `objects`, morphology-valid `grasps`, discrete/contact-gated `processModels` and their prerequisites;
- observable `goalPredicates`, `prohibitedStates`, and learner `evidenceRequirements`;
- `provenance` entries using `M`, `F`, `R`, or `C` (M/F require `sourceRef`);
- full `modelClaim` from the canonical catalog;
- `api.level` (`guided`, `builder`, or `challenge`);
- validation-only `validation.referenceExecutions`, `validation.acceptedAlternates`, and `validation.negativeCases`.

All tasks require frame roles `approach`, `contact`, `lift`, `destination`, and `retreat`. G1 tasks additionally require `dock` and `latch`. Frames contain world positions—not hidden target joint tuples. The engine runs deterministic multi-start IK and collision-checked planning against these frames.

Each evidence requirement must include a visible `label` or `prompt` and must be gated by `availableWhen` (an observable predicate) or `requiresEvent` (an event-match object). Optional `minLength`, `allowedValues`, and `valuePattern` constraints are enforced both when evidence is recorded and during grading. Starter programs leave evidence values blank for the learner; validation reference executions provide explicit observations only after their evidence gate is satisfied.

## Predicate contract

The frozen foundation predicates are `equal`, `not_equal`, `truthy`, `object_at`, `attached_to`, `process_state`, `frame_visited`, `event`, `evidence`, `all`, `any`, and `not`.

An authorized additive measured-workcell extension dated 2026-08-27 adds `event_before`, `object_axis_coordinate`, `object_axis_distance`, `object_planar_distance`, and `object_planar_offset`. These operators read only the authoritative event log and plant object poses. Visible `configured_measurement_ruler` fixtures are `presentationOnly`, have no collision authority, and do not alter IK, path planning, stable-rest validation, or public robot action fields. Grading remains outcome/evidence based; source/reference call order is not graded except where a mission explicitly declares an observable `event_before` safety or sequencing requirement.

## Execution-call contract

Validation executions are arrays of `{ method, args }`. Available methods are cataloged in `lab/v2/api-contract.js`:

- Guided: `lab.frames`, `lab.observe`, `lab.record_evidence`, `skills.transport`, `skills.fixture_operation`, pause/resume/stop/reset.
- Builder: joint observation, plan/execute, grasp/release, navigate/dock, and replan.
- Challenge: explicit IK and waypoint plan/execute calls. Native Python loops and branches are executed by Pyodide.

For fixed/mobile manipulators, the common semantic transport call is:

```json
{
  "method": "skills.transport",
  "args": {
    "objectId": "object_id",
    "approachFrame": "object_approach",
    "contactFrame": "object_contact",
    "liftFrame": "object_lift",
    "destinationFrame": "destination",
    "placeFrame": "destination_contact",
    "retreatFrame": "destination_retreat",
    "effector": "default",
    "seed": 17
  }
}
```

OpenArm uses `effector: "left"` or `"right"` and frames with `chainId: "left"` or `"right"`. G1 uses the same semantic call but the engine routes exclusively over the scenario waypoint graph and requires `securedCarrier: true` plus `attachmentInterface: "robobuddy-secured-carrier-v2"`.

## Robot/model identifiers and revisions

- `arduino_arm`: `ARM_RIG_CONFIG 2026-06-11`
- `so101_follower`: `SO101 official main snapshot baked 2026-07-02`
- `lekiwi_sim`: `LeKiwi official snapshot baked 2026-07-03`
- `openarm_v2_bimanual`: `6c7b720f1ba48e8bafa3a3dc752c45f397b42221`
- `unitree_g1_29dof`: `dd4fa6866e523ad61324f658d63736e4eda3a6e4`

Use the exact `modelClaim(robotId)` output represented in JSON; do not weaken the unsupported-physics list.
The model claim includes numeric joint limits plus explicit `limitProvenance`; SO-101 and LeKiwi distinguish official-model joints from configured educational bounds, Arduino identifies firmware-configured bounds without claiming calibration, OpenArm distinguishes the baked official chain from configured shared-base bounds, and G1 exposes no learner joint-limit control.

## Worker-owned paths

Each worker owns only its assigned family name under:

- `missions/lab-assistant/v2/definitions/<family>/*.json`
- `missions/lab-assistant/v2/fixtures/<family>/*.json` (only if shared within that family)
- `missions/lab-assistant/v2/model-claims/<family>.json`
- `missions/lab-assistant/v2/reference-solutions/<family>/*.json` (optional supplemental evidence)
- `tests/v2/<family>/*.test.mjs`

Family names are `arduino`, `so101`, `lekiwi`, `openarm`, and `g1`.

## Required worker checks

1. Exactly 10 definitions, ranks 1..10, each superseding the matching v1 id.
2. Schema validation succeeds for every definition.
3. Each reference execution passes outcome plus evidence.
4. At least one legitimate alternate algorithm, IK seed, or causally safe order passes for every task.
5. Each declared negative case fails for its stated `expectedFailureKind` (`goal`, `evidence`, `prohibited`, or `causal`).
6. All task frames used by a manipulator reference are reachable and paths are collision checked.
7. Class B fixtures are visible and explicit. Class C changes preserve rank and learning objective while removing unsupported robot actions.
8. G1 remains logistics-only; LeKiwi is stowed before base motion; OpenArm respects per-arm/shared-base constraints; SO-101 makes no force/payload claim; Arduino makes no dynamics/calibration claim.

Workers commit locally and return branch name, commit hash, classification table, exact checks, caveats, and any shared blocker.
