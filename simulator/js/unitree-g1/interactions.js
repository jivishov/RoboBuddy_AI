import { distance3 } from "./calculations.js?v=20260812-g1-registration-fix-2";

export function createToolFrames(THREE, groups, definitions = []) {
  const frames = new Map();
  definitions.forEach((definition) => {
    const parent = groups && groups[definition.group];
    if (!parent) return;
    const frame = new THREE.Group();
    frame.name = `tool-frame-${definition.id}`;
    frame.position.fromArray(definition.offsetMm || [0, 0, 0]);
    parent.add(frame);
    frames.set(definition.id, frame);
  });
  return frames;
}

export function pickNearestObject(THREE, handId, toolFrames, taskObjects, radiusMm = 340) {
  const frame = toolFrames && toolFrames.get(handId);
  if (!frame || !taskObjects || !taskObjects.objects) return { ok: false, objectId: "" };
  const handWorld = new THREE.Vector3();
  frame.getWorldPosition(handWorld);
  let nearest = null;
  let nearestDistance = Infinity;
  taskObjects.objects.forEach((mesh, objectId) => {
    if (mesh.userData.heldBy && mesh.userData.heldBy !== handId) return;
    const objectWorld = new THREE.Vector3();
    mesh.getWorldPosition(objectWorld);
    const distance = distance3(handWorld, objectWorld);
    if (distance < nearestDistance) {
      nearest = { mesh, objectId };
      nearestDistance = distance;
    }
  });
  if (!nearest || nearestDistance > radiusMm) return { ok: false, objectId: "", distanceMm: nearestDistance };
  frame.attach(nearest.mesh);
  nearest.mesh.position.set(52, 0, 0);
  nearest.mesh.rotation.set(0, 0, Math.PI / 2);
  nearest.mesh.userData.heldBy = handId;
  return { ok: true, objectId: nearest.objectId, distanceMm: nearestDistance };
}

export function releaseObject(handId, toolFrames, taskObjects) {
  const frame = toolFrames && toolFrames.get(handId);
  if (!frame || !taskObjects || !taskObjects.group) return { ok: false, objectId: "" };
  const held = Array.from(taskObjects.objects.entries()).find(([, mesh]) => mesh.userData.heldBy === handId);
  if (!held) return { ok: false, objectId: "" };
  const [objectId, mesh] = held;
  taskObjects.group.attach(mesh);
  mesh.userData.heldBy = "";
  return { ok: true, objectId };
}
