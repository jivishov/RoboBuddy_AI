#!/usr/bin/env bash
set -euo pipefail

TRANSFORM=/tmp/upgrade-complex-lab-tasks.mjs

cat scripts/.complex-lab-upgrade.b64.part-* \
  | base64 --decode \
  | gzip --decompress \
  > "$TRANSFORM"
echo "85ef2cac6078ba2accf3f645880bea8233723cf05abec2321767f8186e8351b6  $TRANSFORM" | sha256sum --check
node --check "$TRANSFORM"

python3 - <<'PY'
from pathlib import Path

path = Path('/tmp/upgrade-complex-lab-tasks.mjs')
source = path.read_text()

required = [
    (
        'const station = fixture.type === \\"configured_visible_bimanual_workcell\\" ? openArmWorkcell(fixture) : null;',
        'const station = stationByFixtureId.get(fixture.id);',
        'current equipment-scene station dispatch',
    ),
    (
        'this.definition.objects.forEach((definition) => {',
        'this.definition.objects.forEach((item) => {',
        'current equipment-scene object loop',
    ),
    (
        'patchRefinerGuards();',
        '// Maintenance guards are installed at the current scripts actual file-loop boundaries by this runner.',
        'outdated maintenance-guard hook',
    ),
    # Configure a physically visible 100 mm right-front clearance gate. The
    # carried bottle bases remain 30 mm above its 140 mm top at both checkpoints.
    ('positionMm: [160, 255, -118]', 'positionMm: [150, 255, 50]', 'aliquot near-side checkpoint'),
    ('positionMm: [160, 255, -42]', 'positionMm: [150, 255, 150]', 'aliquot far-side checkpoint'),
    ('positionMm: [280, 255, -118]', 'positionMm: [190, 255, 50]', 'rinse near-side checkpoint'),
    ('positionMm: [280, 255, -42]', 'positionMm: [190, 255, 150]', 'rinse far-side checkpoint'),
    ('positionMm: [220, 70, -80]', 'positionMm: [170, 70, 100]', 'shield fixture position'),
    ('centerMm: [220, 70, -80], halfExtentsMm: [110, 70, 8]', 'centerMm: [170, 70, 100], halfExtentsMm: [50, 70, 8]', 'shield panel collision geometry'),
    ('centerMm: [220, 8, -80], halfExtentsMm: [115, 8, 25]', 'centerMm: [170, 8, 100], halfExtentsMm: [55, 8, 15]', 'shield rail collision geometry'),
    ('C: configured 220 x 140 x 16 mm transparent shield panel', 'C: configured 100 x 140 x 16 mm transparent shield panel', 'shield dimensions provenance'),
    ('{ id: "shield-height-ruler", axis: "y", originMm: [102, 0, -90], lengthMm: 220', '{ id: "shield-height-ruler", axis: "y", originMm: [108, 0, 90], lengthMm: 220', 'shield height ruler position'),
    ('{ id: "shield-span-ruler", axis: "x", originMm: [110, 148, -90], lengthMm: 220', '{ id: "shield-span-ruler", axis: "x", originMm: [120, 148, 90], lengthMm: 100', 'shield span ruler position'),
]

for old, new, label in required:
    if old not in source:
        raise SystemExit(f'Required compatibility anchor missing: {label}')
    source = source.replace(old, new, 1)

path.write_text(source)
PY
node --check "$TRANSFORM"
node "$TRANSFORM"

python3 - <<'PY'
from pathlib import Path

def patch_once(path_string, marker, needle, replacement):
    path = Path(path_string)
    source = path.read_text()
    if marker in source:
        return
    if needle not in source:
        raise SystemExit(f'{path_string}: maintenance-loop anchor missing')
    path.write_text(source.replace(needle, replacement, 1))

# The original transformation anchor occurs first in generic transport(). Move
# the declaration into so101Transport(), where waypoint planning and grading use it.
engine_path = Path('lab/v2/scenario-engine.js')
engine = engine_path.read_text()
waypoint_block = '''    const placeFrame = placeResolution.frameId;
    const waypointFrames = Array.isArray(args.waypointFrames)
      ? args.waypointFrames.filter((frameId) => typeof frameId === "string" && frameId.length > 0)
      : [];
    waypointFrames.forEach((frameId) => this.frame(frameId));
    if (args.processId) {'''
plain_block = '''    const placeFrame = placeResolution.frameId;
    if (args.processId) {'''
so101_start = engine.find('  async so101Transport(args) {')
if so101_start < 0:
    raise SystemExit('lab/v2/scenario-engine.js: so101Transport anchor missing')
first_waypoint = engine.find(waypoint_block)
if first_waypoint >= 0 and first_waypoint < so101_start:
    engine = engine[:first_waypoint] + plain_block + engine[first_waypoint + len(waypoint_block):]
    so101_start = engine.find('  async so101Transport(args) {')
if 'complex-lab-so101-waypoint-scope-v1' not in engine:
    insertion = engine.find(plain_block, so101_start)
    if insertion < 0:
        raise SystemExit('lab/v2/scenario-engine.js: SO-101 place-frame scope anchor missing')
    scoped = '''    const placeFrame = placeResolution.frameId;
    // complex-lab-so101-waypoint-scope-v1: authored Cartesian checkpoints are
    // planning inputs compiled to ordinary public SOFollower position actions.
    const waypointFrames = Array.isArray(args.waypointFrames)
      ? args.waypointFrames.filter((frameId) => typeof frameId === "string" && frameId.length > 0)
      : [];
    waypointFrames.forEach((frameId) => this.frame(frameId));
    if (args.processId) {'''
    engine = engine[:insertion] + scoped + engine[insertion + len(plain_block):]
engine_path.write_text(engine)

so101_needle = '  const definition = JSON.parse(await readFile(sourcePath, "utf8"));\n  definition.canonicalModel.sourceRevision = model.source.revision;'
so101_replacement = '\n'.join([
    '  const definition = JSON.parse(await readFile(sourcePath, "utf8"));',
    '  // complex-task-preservation-v1: retain bespoke physical missions and refresh only their stripped client copies.',
    '  if (definition.complexTask?.version) {',
    '    assertScenarioV2(definition, { expectedRobotId: "so101_follower" });',
    '    await writeFile(resolve(OUTPUT, name), `${JSON.stringify(stripValidationForClient(definition), null, 2)}\\n`);',
    '    console.log(`${definition.id}: preserved bespoke complex physical mission`);',
    '    continue;',
    '  }',
    '  definition.canonicalModel.sourceRevision = model.source.revision;',
])
patch_once('scripts/refine-so101-v2-source.mjs', 'complex-task-preservation-v1', so101_needle, so101_replacement)

openarm_needle = '  const definition = refine(JSON.parse(fs.readFileSync(sourcePath, "utf8")));\n  assertScenarioV2(definition, { expectedRobotId: "openarm_v2_bimanual" });'
openarm_replacement = '\n'.join([
    '  const loadedDefinition = JSON.parse(fs.readFileSync(sourcePath, "utf8"));',
    '  // complex-task-preservation-v1: retain bespoke stacked workcells and refresh only their stripped client copies.',
    '  if (loadedDefinition.complexTask?.version) {',
    '    assertScenarioV2(loadedDefinition, { expectedRobotId: "openarm_v2_bimanual" });',
    '    fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(stripValidationForClient(loadedDefinition), null, 2)}\\n`);',
    '    console.log(`${loadedDefinition.id}: preserved bespoke complex physical mission`);',
    '    continue;',
    '  }',
    '  const definition = refine(loadedDefinition);',
    '  assertScenarioV2(definition, { expectedRobotId: "openarm_v2_bimanual" });',
])
patch_once('scripts/refine-openarm-table-clearance.mjs', 'complex-task-preservation-v1', openarm_needle, openarm_replacement)
PY

for file in \
  lab/v2/scenario-engine.js \
  scripts/extract-portable-reference-actions.mjs \
  lab/js/objects.js \
  scripts/portable-physical-rest-helpers.mjs \
  lab/v2/equipment-scene.js \
  lab/js/workbench-v2.js \
  scripts/refine-so101-v2-source.mjs \
  scripts/refine-openarm-table-clearance.mjs \
  tests/v2/complex-lab-tasks.test.mjs \
  tests/v2/so101/so101-family.test.mjs \
  tests/v2/openarm/openarm.test.mjs; do
  node --check "$file"
done

node scripts/extract-portable-reference-actions.mjs --scenario=so101-v2-06-quantitative-transfer
node scripts/extract-portable-reference-actions.mjs --scenario=so101-v2-08-burette-initial-reading
node scripts/extract-portable-reference-actions.mjs --scenario=openarm-10-gravimetric-workcell
node scripts/generate-lab-v2-catalog.mjs --refresh

npm run test:v2:complex-lab
npm run test:v2:foundation
npm run test:v2:python-compat
npm run test:v2:portable-workbench-ux
npm run test:v2:physical-rest
npm run test:v2:apparatus-visuals
npm run test:v2:portable-references
npm run test:v2:so101
node tests/v2/openarm/openarm.test.mjs
npm run test:v2:openarm-workbench-regression
npm run test:v2:openarm-surface-pinch
npm run test:v2:all
npm run validate:v2
git diff --check

rm -f scripts/.complex-lab-upgrade.b64.part-*
rm -f scripts/complex-lab-runner.sh
rm -f .github/workflows/complex-lab-apply.yml

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then
  echo "No implementation changes to commit."
  exit 1
fi
git commit -m "feat: add complex physical SO-101 and OpenArm lab tasks"
git push origin HEAD:feat/complex-physical-lab-tasks
