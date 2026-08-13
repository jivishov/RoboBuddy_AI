import * as THREE from "three";
import { createApparatusObject, disposeObject3D } from "../js/objects.js";

const ROLE_COLORS = Object.freeze({
  approach: 0x4d7aa1,
  contact: 0xd28b2f,
  lift: 0x6c72b7,
  destination: 0x1d8078,
  retreat: 0x69777e,
  dock: 0x8e5f9f,
  latch: 0xa45652
});

function labelSprite(text, colour = "#225b58") {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 104;
  const context = canvas.getContext("2d");
  context.fillStyle = "rgba(247,250,249,.94)";
  context.fillRect(4, 10, 504, 84);
  context.strokeStyle = colour;
  context.lineWidth = 5;
  context.strokeRect(6.5, 12.5, 499, 79);
  context.fillStyle = "#203139";
  context.font = "700 31px DM Sans, Segoe UI, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(text || "frame"), 256, 52, 474);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(118, 24, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function frameMarker(id, frame) {
  const group = new THREE.Group();
  group.name = `scenario-v2-frame-${id}`;
  const colour = ROLE_COLORS[frame.role] || 0x71858c;
  const tolerance = Math.max(8, Math.min(45, Number(frame.tolerance?.positionMm) || 18));
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(7, tolerance * 0.62), tolerance, 32),
    new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 1;
  group.add(ring);
  const stem = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 34, 0)]),
    new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.68 })
  );
  group.add(stem);
  if (["contact", "destination", "dock", "latch"].includes(frame.role)) {
    const label = labelSprite(id, `#${colour.toString(16).padStart(6, "0")}`);
    label.position.y = 48;
    group.add(label);
  }
  group.position.set(...frame.positionMm);
  group.userData.baseColour = colour;
  group.userData.ring = ring;
  return group;
}

function fixtureProxy(fixture) {
  const proxy = fixture.collisionProxy || {};
  let geometry;
  if (proxy.type === "box" && Array.isArray(proxy.halfExtentsMm)) {
    geometry = new THREE.BoxGeometry(...proxy.halfExtentsMm.map((value) => Math.max(4, Number(value) * 2)));
  } else if (proxy.type === "capsule") {
    geometry = new THREE.CapsuleGeometry(Math.max(4, Number(proxy.radiusMm) || 20), Math.max(8, Number(proxy.lengthMm) || 80), 6, 12);
  } else {
    const radius = Math.max(14, Number(proxy.radiusMm) || 42);
    geometry = new THREE.BoxGeometry(radius * 2, radius, radius * 2);
  }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x697b7f,
    roughness: 0.72,
    metalness: 0.08,
    transparent: true,
    opacity: 0.48
  }));
  const frame = fixture.frameId || fixture.frame || fixture.atFrame;
  const center = proxy.centerMm || fixture.positionMm;
  if (Array.isArray(center)) mesh.position.set(...center);
  mesh.name = `scenario-v2-fixture-${fixture.id}`;
  mesh.userData.frameId = frame || "";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function objectVisualDefinition(item) {
  return {
    ...item,
    type: item.visual?.type || item.visualType || item.type || "configured_object",
    visualVariant: item.visual?.variant || item.visualVariant || "standard",
    visualReference: item.visual?.reference || item.visualReference
  };
}

function carrierOffset(robotId, effector) {
  if (robotId === "unitree_g1_29dof" || effector === "secured_carrier_mount") return new THREE.Vector3(300, 825, 0);
  return new THREE.Vector3(0, 0, 0);
}

export class ScenarioV2EquipmentScene {
  constructor(preview, definition) {
    if (!preview?.scene) throw new Error("The canonical robot preview scene is unavailable.");
    this.preview = preview;
    this.definition = definition;
    this.scene = preview.scene;
    this.root = new THREE.Group();
    this.root.name = `scenario-v2-${definition.id}`;
    this.frameGroups = new Map();
    this.objectGroups = new Map();
    this.fixtureGroups = new Map();
    this.build();
    this.scene.add(this.root);
  }

  build() {
    const points = Object.values(this.definition.frames).map((frame) => frame.positionMm);
    const xs = points.map((point) => Number(point[0]) || 0);
    const zs = points.map((point) => Number(point[2]) || 0);
    const width = Math.max(900, Math.max(...xs) - Math.min(...xs) + 360);
    const depth = Math.max(720, Math.max(...zs) - Math.min(...zs) + 360);
    const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const centerZ = (Math.max(...zs) + Math.min(...zs)) / 2;
    const bench = new THREE.Mesh(
      new THREE.BoxGeometry(width, 24, depth),
      new THREE.MeshStandardMaterial({ color: 0x53666c, roughness: 0.76, metalness: 0.06 })
    );
    bench.position.set(centerX, -13, centerZ);
    bench.receiveShadow = true;
    bench.name = "scenario-v2-work-surface";
    this.root.add(bench);

    Object.entries(this.definition.frames).forEach(([id, frame]) => {
      const marker = frameMarker(id, frame);
      this.frameGroups.set(id, marker);
      this.root.add(marker);
    });

    this.definition.fixtures.forEach((fixture) => {
      const mesh = fixtureProxy(fixture);
      if (!mesh.position.lengthSq() && mesh.userData.frameId && this.definition.frames[mesh.userData.frameId]) {
        mesh.position.set(...this.definition.frames[mesh.userData.frameId].positionMm);
      }
      const label = labelSprite(fixture.label || fixture.id, "#53666c");
      label.position.set(mesh.position.x, mesh.position.y + 70, mesh.position.z);
      this.fixtureGroups.set(fixture.id, mesh);
      this.root.add(mesh, label);
    });

    this.definition.objects.forEach((item) => {
      const object = createApparatusObject(objectVisualDefinition(item));
      object.scale.setScalar(Number(item.visual?.scale || item.visualScale || 1));
      object.userData.scenarioV2ObjectId = item.id;
      this.objectGroups.set(item.id, object);
      this.root.add(object);
    });
  }

  effectorFrame(effector) {
    if (this.definition.robotId === "arduino_arm") return this.preview.groups?.tool || this.preview.groups?.wristTilt || null;
    if (this.definition.robotId === "so101_follower" || this.definition.robotId === "lekiwi_sim") return this.preview.groups?.gripperRoot || null;
    if (this.definition.robotId === "openarm_v2_bimanual") {
      const side = effector === "right" ? "right" : "left";
      return this.preview.groups?.[`${side}_j7`] || null;
    }
    return this.preview.groups?.root || this.preview.root || null;
  }

  placeAtWorldPosition(object, positionMm) {
    this.root.updateWorldMatrix(true, false);
    object.position.copy(this.root.worldToLocal(new THREE.Vector3(...positionMm)));
    object.quaternion.identity();
  }

  attachAtEffector(object, effector) {
    const frame = this.effectorFrame(effector);
    if (!frame) return;
    frame.updateWorldMatrix(true, false);
    this.root.updateWorldMatrix(true, false);
    const world = frame.getWorldPosition(new THREE.Vector3()).add(carrierOffset(this.definition.robotId, effector));
    object.position.copy(this.root.worldToLocal(world));
    const frameQuaternion = frame.getWorldQuaternion(new THREE.Quaternion());
    const rootQuaternion = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    object.quaternion.copy(rootQuaternion.multiply(frameQuaternion));
  }

  update(state) {
    Object.values(state.objects || {}).forEach((item) => {
      const object = this.objectGroups.get(item.id);
      if (!object) return;
      object.visible = true;
      if (item.attachedTo) this.attachAtEffector(object, item.attachedTo);
      else {
        const frame = this.definition.frames[item.currentFrame] || this.definition.frames[item.initialFrame];
        if (frame) this.placeAtWorldPosition(object, frame.positionMm);
      }
    });
    this.frameGroups.forEach((group, id) => {
      const visited = (state.visitedFrames || []).includes(id);
      const current = state.lastReachedFrame === id;
      group.userData.ring.material.opacity = current ? 1 : visited ? 0.82 : 0.42;
      group.scale.setScalar(current ? 1.18 : 1);
    });
    this.fixtureGroups.forEach((mesh, id) => {
      const active = Object.values(state.processes || {}).some((process) => process.fixtureId === id && process.state !== "ready");
      mesh.material.emissive?.set(active ? 0x1d8078 : 0x000000);
      mesh.material.emissiveIntensity = active ? 0.28 : 0;
    });
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    disposeObject3D(this.root);
    this.frameGroups.clear();
    this.objectGroups.clear();
    this.fixtureGroups.clear();
  }
}
