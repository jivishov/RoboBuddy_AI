import * as THREE from "three";
import { createApparatusObject, disposeObject3D, objectSocket } from "../js/objects.js?v=20260823-physical-fidelity-4";
import { openArmWorkcellLayout } from "./support-layout.js?v=20260823-physical-fidelity-3";
import { SO101_COMMAND_MODEL } from "./so101-command-model.js";

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

function frameMarker(id, frame, options = {}) {
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
  if (options.showStem !== false) {
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 34, 0)]),
      new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.68 })
    );
    group.add(stem);
  }
  if (options.showLabel !== false && ["contact", "destination", "dock", "latch"].includes(frame.role)) {
    const label = labelSprite(id, `#${colour.toString(16).padStart(6, "0")}`);
    label.position.y = 48;
    group.add(label);
  }
  group.position.set(...frame.positionMm);
  group.userData.baseColour = colour;
  group.userData.ring = ring;
  return group;
}


function measurementRuler(fixture) {
  const configured = fixture.measurement || {};
  const axis = String(configured.axis || "x").toLowerCase();
  const axisIndex = { x: 0, y: 1, z: 2 }[axis];
  const origin = Array.isArray(configured.originMm) ? configured.originMm.map(Number) : [0, 0, 0];
  const length = Math.max(10, Number(configured.lengthMm) || 500);
  const direction = Number(configured.direction) < 0 ? -1 : 1;
  const minor = Math.max(2, Number(configured.minorTickMm) || 10);
  const major = Math.max(minor, Number(configured.majorTickMm) || 50);
  const labelEvery = Math.max(major, Number(configured.labelEveryMm) || 100);
  const width = Math.max(14, Number(configured.widthMm) || 28);
  const startValue = Number(configured.startValueMm) || 0;
  const group = new THREE.Group();
  group.name = `scenario-v2-measurement-ruler-${fixture.id}`;
  group.userData.absolutePosition = true;
  group.userData.fixedFixture = true;
  group.userData.presentationOnly = true;
  group.userData.measurement = { ...configured };
  group.position.set(...origin);

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xf2e8be, roughness: 0.82, metalness: 0.02 });
  const tickMaterial = new THREE.MeshBasicMaterial({ color: 0x263238 });
  const bodySize = axis === "x" ? [length, 2, width] : axis === "z" ? [width, 2, length] : [width, length, 2];
  const body = new THREE.Mesh(new THREE.BoxGeometry(...bodySize), bodyMaterial);
  const bodyOffset = direction * length / 2;
  if (axisIndex !== undefined) body.position.setComponent(axisIndex, bodyOffset);
  body.name = `${group.name}-body`;
  body.receiveShadow = true;
  group.add(body);

  const count = Math.min(250, Math.floor(length / minor));
  for (let index = 0; index <= count; index += 1) {
    const distance = Math.min(length, index * minor);
    const majorTick = Math.abs(distance / major - Math.round(distance / major)) < 1e-6;
    const labelTick = Math.abs(distance / labelEvery - Math.round(distance / labelEvery)) < 1e-6;
    const tickLength = majorTick ? width * 0.82 : width * 0.48;
    const tickSize = axis === "x" ? [1.2, 2.4, tickLength] : axis === "z" ? [tickLength, 2.4, 1.2] : [tickLength, 1.2, 2.4];
    const tick = new THREE.Mesh(new THREE.BoxGeometry(...tickSize), tickMaterial);
    const coordinate = direction * distance;
    tick.position.set(0, 0, 0);
    tick.position.setComponent(axisIndex, coordinate);
    if (axis !== "y") tick.position.y = 2.2;
    tick.name = `${group.name}-tick-${distance}`;
    group.add(tick);
    if (labelTick) {
      const value = startValue + direction * distance;
      const label = labelSprite(`${Math.round(value)} ${configured.units || "mm"}`, "#263238");
      label.scale.set(54, 12, 1);
      if (axis === "x") label.position.set(coordinate, 16, width * 0.72);
      else if (axis === "z") label.position.set(width * 0.72, 16, coordinate);
      else label.position.set(width * 0.95, coordinate, 4);
      label.name = `${group.name}-label-${distance}`;
      group.add(label);
    }
  }
  return group;
}

function fixtureProxy(fixture) {
  if (fixture.type === "configured_measurement_ruler") return measurementRuler(fixture);
  if (fixture.type === "configured_heater_platform") return configuredHeaterPlatform(fixture);
  if (fixture.type === "configured_ring_stand_support") return configuredRingStandSupport(fixture);
  if (fixture.presentationOnly === true) {
    const group = new THREE.Group();
    group.name = `scenario-v2-fixture-${fixture.id}`;
    group.userData.fixedFixture = true;
    group.userData.presentationOnly = true;
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(42, 54, 32),
      new THREE.MeshBasicMaterial({ color: 0x2b8078, transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthWrite: false })
    );
    marker.rotation.x = -Math.PI / 2;
    const frame = fixture.frameId && fixture._definitionFrames?.[fixture.frameId];
    marker.position.set(0, 1, 0);
    group.add(marker);
    if (frame) group.position.set(...frame.positionMm);
    return group;
  }
  if (fixture.type === "configured_cork_support_ring") {
    const annulus = (fixture.collisionProxies || []).find((proxy) => proxy.type === "annulus");
    if (!annulus) throw new Error(`${fixture.id}: visible cork support ring is missing its authoritative annular proxy.`);
    const inner = Number(annulus.innerRadiusMm);
    const outer = Number(annulus.outerRadiusMm);
    const height = Number(annulus.heightMm);
    const geometry = new THREE.TorusGeometry((inner + outer) / 2, (outer - inner) / 2, 18, 64);
    geometry.rotateX(Math.PI / 2);
    geometry.scale(1, height / (outer - inner), 1);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0x9b6a3f,
      roughness: 0.96,
      metalness: 0,
    }));
    mesh.name = `scenario-v2-fixture-${fixture.id}`;
    mesh.position.set(...annulus.centerMm);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.absolutePosition = true;
    mesh.userData.fixedFixture = true;
    mesh.userData.sourceBackedHolder = true;
    mesh.userData.supportSurfaceId = annulus.id;
    return mesh;
  }
  const proxies = Array.isArray(fixture.collisionProxies) && fixture.collisionProxies.length
    ? fixture.collisionProxies
    : [fixture.collisionProxy || {}];
  if (proxies.length > 1) {
    const group = new THREE.Group();
    group.name = `scenario-v2-fixture-${fixture.id}`;
    group.userData.fixedFixture = true;
    for (const [index, proxy] of proxies.entries()) {
      if (proxy.type !== "box" || !Array.isArray(proxy.halfExtentsMm) || !Array.isArray(proxy.centerMm)) continue;
      const colour = fixture.id.includes("destination") ? 0x2b8078 : fixture.id.includes("pickup") ? 0xb77b38 : 0x697b7f;
      const mesh = boxMesh(
        proxy.halfExtentsMm.map((value) => Math.max(4, Number(value) * 2)),
        proxy.centerMm,
        new THREE.MeshStandardMaterial({ color: colour, roughness: 0.72, metalness: 0.08 }),
        `${group.name}-${proxy.id || index + 1}`
      );
      mesh.userData.fixedFixture = true;
      group.add(mesh);
    }
    return group;
  }
  const proxy = proxies[0];
  let geometry;
  if (proxy.type === "box" && Array.isArray(proxy.halfExtentsMm)) {
    geometry = new THREE.BoxGeometry(...proxy.halfExtentsMm.map((value) => Math.max(4, Number(value) * 2)));
  } else if (proxy.type === "capsule") {
    geometry = new THREE.CapsuleGeometry(Math.max(4, Number(proxy.radiusMm) || 20), Math.max(8, Number(proxy.lengthMm) || 80), 6, 12);
  } else {
    const radius = Math.max(14, Number(proxy.radiusMm) || 42);
    geometry = new THREE.BoxGeometry(radius * 2, radius, radius * 2);
  }
  const fixtureColour = fixture.type === "so101_base_mount"
    ? 0x394b50
    : fixture.id.includes("destination") ? 0x2b8078 : fixture.id.includes("pickup") ? 0xb77b38 : 0x697b7f;
  const flushBaseMount = fixture.type === "so101_base_mount";
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: fixtureColour,
    roughness: 0.72,
    metalness: 0.08,
    transparent: !flushBaseMount,
    opacity: flushBaseMount ? 1 : 0.82,
    polygonOffset: flushBaseMount,
    polygonOffsetFactor: flushBaseMount ? -1 : 0,
    polygonOffsetUnits: flushBaseMount ? -1 : 0
  }));
  const frame = fixture.frameId || fixture.frame || fixture.atFrame;
  const center = proxy.centerMm || fixture.positionMm;
  if (Array.isArray(center)) mesh.position.set(...center);
  mesh.name = `scenario-v2-fixture-${fixture.id}`;
  mesh.userData.frameId = frame || "";
  mesh.userData.fixedFixture = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function scaledObjectSocket(object, name = "grip") {
  const socket = objectSocket(object, name);
  socket.multiply(object?.scale || new THREE.Vector3(1, 1, 1));
  return socket;
}

function socketAlignedOrigin(frame, object) {
  return new THREE.Vector3(...frame.positionMm).sub(scaledObjectSocket(object, "grip"));
}

function boxMesh(size, position, material, name) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
}

function configuredHeaterPlatform(fixture) {
  const proxies = new Map((fixture.collisionProxies || []).map((proxy) => [proxy.id, proxy]));
  const bodyProxy = proxies.get("left-heater-body");
  const topProxy = proxies.get("left-heater-top");
  const controlProxy = proxies.get("left-heater-control-face");
  if (!bodyProxy || !topProxy || !controlProxy) return fixtureProxy({ ...fixture, type: "configured_fixture_fallback" });
  const group = new THREE.Group();
  group.name = `scenario-v2-fixture-${fixture.id}`;
  group.userData.fixedFixture = true;
  group.userData.absolutePosition = true;
  group.userData.fixtureIds = [fixture.id];
  group.userData.supportSurfaceId = topProxy.id;
  group.userData.unpowered = true;

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x343f42, roughness: 0.58, metalness: 0.3 });
  const topMaterial = new THREE.MeshStandardMaterial({ color: 0xe7e1d0, roughness: 0.4, metalness: 0.05 });
  const controlMaterial = new THREE.MeshStandardMaterial({ color: 0x20292c, roughness: 0.5, metalness: 0.18 });
  group.add(boxMesh(bodyProxy.halfExtentsMm.map((value) => Number(value) * 2), bodyProxy.centerMm, bodyMaterial, `${group.name}-body`));
  group.add(boxMesh(topProxy.halfExtentsMm.map((value) => Number(value) * 2), topProxy.centerMm, topMaterial, `${group.name}-ceramic-top`));
  group.add(boxMesh(controlProxy.halfExtentsMm.map((value) => Number(value) * 2), controlProxy.centerMm, controlMaterial, `${group.name}-control-face`));

  const knobMaterial = new THREE.MeshStandardMaterial({ color: 0xc6cfcd, roughness: 0.35, metalness: 0.55 });
  for (const offsetX of [-24, 24]) {
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 6, 24), knobMaterial);
    knob.rotation.x = Math.PI / 2;
    knob.position.set(Number(controlProxy.centerMm[0]) + offsetX, Number(controlProxy.centerMm[1]), Number(controlProxy.centerMm[2]) - Number(controlProxy.halfExtentsMm[2]) - 3);
    knob.name = `${group.name}-control-knob-${offsetX < 0 ? "left" : "right"}`;
    knob.castShadow = true;
    group.add(knob);
  }
  const statusLabel = labelSprite("UNPOWERED", "#344449");
  statusLabel.scale.set(72, 15, 1);
  statusLabel.position.set(Number(controlProxy.centerMm[0]), Number(controlProxy.centerMm[1]) + 23, Number(controlProxy.centerMm[2]) - 12);
  group.add(statusLabel);
  group.userData.activeMaterials = [bodyMaterial, topMaterial];
  return group;
}

function configuredRingStandSupport(fixture) {
  const proxies = new Map((fixture.collisionProxies || []).map((proxy) => [proxy.id, proxy]));
  const baseProxy = proxies.get("right-ring-stand-base");
  const rodProxy = proxies.get("right-ring-stand-rod");
  const xArmProxy = proxies.get("right-ring-clamp-x-arm");
  const zArmProxy = proxies.get("right-ring-clamp-z-arm");
  const gauzeProxy = proxies.get("right-gauze-top");
  if (!baseProxy || !rodProxy || !xArmProxy || !zArmProxy || !gauzeProxy) return fixtureProxy({ ...fixture, type: "configured_fixture_fallback" });
  const group = new THREE.Group();
  group.name = `scenario-v2-fixture-${fixture.id}`;
  group.userData.fixedFixture = true;
  group.userData.absolutePosition = true;
  group.userData.fixtureIds = [fixture.id];
  group.userData.supportSurfaceId = gauzeProxy.id;
  group.userData.sourceBackedHolder = true;

  const baseMaterial = new THREE.MeshStandardMaterial({ color: 0x2e393c, roughness: 0.52, metalness: 0.35 });
  const metalMaterial = new THREE.MeshStandardMaterial({ color: 0x89979a, roughness: 0.32, metalness: 0.68 });
  const gauzeMaterial = new THREE.MeshStandardMaterial({ color: 0xb7c0bd, roughness: 0.42, metalness: 0.48, transparent: true, opacity: 0.68 });
  group.add(boxMesh(baseProxy.halfExtentsMm.map((value) => Number(value) * 2), baseProxy.centerMm, baseMaterial, `${group.name}-base`));

  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(Math.max(3, Number(rodProxy.halfExtentsMm[0])), Math.max(3, Number(rodProxy.halfExtentsMm[0])), Number(rodProxy.halfExtentsMm[1]) * 2, 24),
    metalMaterial,
  );
  rod.position.set(...rodProxy.centerMm);
  rod.name = `${group.name}-rod`;
  rod.castShadow = true;
  group.add(rod);
  for (const proxy of [xArmProxy, zArmProxy]) {
    group.add(boxMesh(proxy.halfExtentsMm.map((value) => Number(value) * 2), proxy.centerMm, metalMaterial, `${group.name}-${proxy.id}`));
  }

  const gauze = boxMesh(gauzeProxy.halfExtentsMm.map((value) => Number(value) * 2), gauzeProxy.centerMm, gauzeMaterial, `${group.name}-gauze`);
  group.add(gauze);
  const supportTopY = Number(gauzeProxy.centerMm[1]) + Number(gauzeProxy.halfExtentsMm[1]) + 0.8;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(44, 2.2, 12, 64), metalMaterial);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(Number(gauzeProxy.centerMm[0]), supportTopY, Number(gauzeProxy.centerMm[2]));
  ring.name = `${group.name}-support-ring`;
  group.add(ring);
  const gridPoints = [];
  for (let offset = -40; offset <= 40; offset += 10) {
    gridPoints.push(
      new THREE.Vector3(Number(gauzeProxy.centerMm[0]) + offset, supportTopY, Number(gauzeProxy.centerMm[2]) - 40),
      new THREE.Vector3(Number(gauzeProxy.centerMm[0]) + offset, supportTopY, Number(gauzeProxy.centerMm[2]) + 40),
      new THREE.Vector3(Number(gauzeProxy.centerMm[0]) - 40, supportTopY, Number(gauzeProxy.centerMm[2]) + offset),
      new THREE.Vector3(Number(gauzeProxy.centerMm[0]) + 40, supportTopY, Number(gauzeProxy.centerMm[2]) + offset),
    );
  }
  const grid = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(gridPoints),
    new THREE.LineBasicMaterial({ color: 0x4f5c60, transparent: true, opacity: 0.82 }),
  );
  grid.name = `${group.name}-wire-grid`;
  group.add(grid);
  group.userData.activeMaterials = [baseMaterial, metalMaterial, gauzeMaterial];
  return group;
}

function openArmWorkcell(fixture) {
  const layout = openArmWorkcellLayout({ collisionProxies: fixture.collisionProxies });
  if (!layout.valid) return null;
  const group = new THREE.Group();
  group.name = "scenario-v2-openarm-workcell";
  group.userData.fixedFixture = true;
  group.userData.absolutePosition = true;
  group.userData.fixtureIds = [fixture.id];

  const counterMaterial = new THREE.MeshStandardMaterial({ color: 0xe2e6e3, roughness: 0.48, metalness: 0.12 });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: 0x53666a, roughness: 0.58, metalness: 0.22 });
  [...layout.worktops, ...layout.legs].forEach((proxy) => group.add(boxMesh(
    proxy.halfExtentsMm.map((value) => Number(value) * 2),
    proxy.centerMm,
    String(proxy.id).endsWith("worktop") ? counterMaterial : trimMaterial,
    `${group.name}-${proxy.id}`
  )));
  group.userData.activeMaterials = [counterMaterial];
  group.userData.worktopTopY = layout.worktopTopY;
  return group;
}

function objectVisualDefinition(item) {
  return {
    ...item,
    type: item.visual?.type || item.visualType || item.type || "configured_object",
    visualVariant: item.visual?.variant || item.visualVariant || "standard",
    visualReference: item.visual?.reference || item.visualReference
  };
}

function addSo101ObjectEdges(object) {
  object.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(node.geometry, 32),
      new THREE.LineBasicMaterial({ color: 0x8b5e2d, transparent: true, opacity: 0.82 })
    );
    edges.name = `${node.name || "apparatus"}-so101-display-edges`;
    edges.userData.educationalDisplayEdge = true;
    node.add(edges);
  });
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
    this.objectPresentation = new Map();
    this.build();
    this.scene.add(this.root);
  }

  build() {
    const openArm = this.definition.robotId === "openarm_v2_bimanual";
    const so101 = this.definition.robotId === "so101_follower";
    const portable = openArm || so101 || this.definition.robotId === "lekiwi_sim";
    const points = Object.values(this.definition.frames).map((frame) => frame.positionMm);
    const xs = points.map((point) => Number(point[0]) || 0);
    const zs = points.map((point) => Number(point[2]) || 0);
    const width = Math.max(900, Math.max(...xs) - Math.min(...xs) + 360);
    const depth = Math.max(720, Math.max(...zs) - Math.min(...zs) + 360);
    const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const centerZ = (Math.max(...zs) + Math.min(...zs)) / 2;
    const bench = new THREE.Mesh(
      new THREE.BoxGeometry(width, 24, depth),
      new THREE.MeshStandardMaterial({ color: so101 ? 0xd8dfdd : 0x53666c, roughness: 0.76, metalness: 0.06 })
    );
    bench.position.set(centerX, -13, centerZ);
    bench.receiveShadow = true;
    bench.name = "scenario-v2-work-surface";
    this.root.add(bench);

    this.definition.objects.forEach((item) => {
      const object = createApparatusObject(objectVisualDefinition(item));
      object.scale.setScalar(Number(item.visual?.scale || item.visualScale || 1));
      if (so101) addSo101ObjectEdges(object);
      object.userData.scenarioV2ObjectId = item.id;
      this.objectGroups.set(item.id, object);
      this.root.add(object);
    });

    Object.entries(this.definition.frames).forEach(([id, frame]) => {
      const marker = frameMarker(id, frame, {
        showLabel: !openArm && !so101,
        // Portable task frames use flat tolerance rings only. Vertical stems
        // read as invented rods/pedestals beside apparatus in perspective and
        // have no physical or grading authority.
        showStem: !portable,
      });
      this.frameGroups.set(id, marker);
      this.root.add(marker);
    });

    const stationByFixtureId = new Map();
    if (openArm) {
      const fixture = this.definition.fixtures.find((item) => item.type === "configured_visible_bimanual_workcell");
      const station = fixture ? openArmWorkcell(fixture) : null;
      station?.userData.fixtureIds.forEach((id) => stationByFixtureId.set(id, station));
      if (station) this.root.add(station);
    }

    this.definition.fixtures.forEach((fixture) => {
      fixture._definitionFrames = this.definition.frames;
      const station = stationByFixtureId.get(fixture.id);
      const mesh = station || fixtureProxy(fixture);
      if (!mesh.userData.absolutePosition && !mesh.position.lengthSq() && mesh.userData.frameId && this.definition.frames[mesh.userData.frameId]) {
        mesh.position.set(...this.definition.frames[mesh.userData.frameId].positionMm);
      }
      this.fixtureGroups.set(fixture.id, mesh);
      if (!station) this.root.add(mesh);
      delete fixture._definitionFrames;
      if (!openArm && !so101) {
        const label = labelSprite(`Fixed: ${fixture.label || fixture.id}`, "#53666c");
        label.position.set(mesh.position.x, mesh.position.y + 70, mesh.position.z);
        this.root.add(label);
      }
    });
  }

  effectorFrame(effector) {
    if (this.definition.robotId === "arduino_arm") return this.preview.groups?.tool || this.preview.groups?.wristTilt || null;
    if (this.definition.robotId === "so101_follower") return this.preview.groups?.[SO101_COMMAND_MODEL.gripper.toolFrameNode] || this.preview.groups?.gripperRoot || null;
    if (this.definition.robotId === "lekiwi_sim") return this.preview.groups?.gripperRoot || null;
    if (this.definition.robotId === "openarm_v2_bimanual") {
      const side = effector === "right" ? "right" : "left";
      return this.preview.groups?.[`${side}_j7`] || null;
    }
    return this.preview.groups?.root || this.preview.root || null;
  }

  effectorSocketMatrix(effector) {
    const frame = this.effectorFrame(effector);
    if (!frame) return null;
    const side = effector === "right" ? "right" : "left";
    const chains = this.preview.canonicalRobotModel?.chains || {};
    const chainId = this.definition.robotId === "openarm_v2_bimanual" ? side : Object.keys(chains)[0];
    const offset = chains[chainId]?.endOffsetMm || [0, 0, 0];
    frame.updateWorldMatrix(true, false);
    const position = frame.localToWorld(new THREE.Vector3(...offset));
    const quaternion = frame.getWorldQuaternion(new THREE.Quaternion());
    return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
  }

  effectorFrameCorrespondence(frameId, effector = "default") {
    const expected = this.definition.frames[frameId]?.positionMm;
    const socketWorld = expected ? this.effectorSocketMatrix(effector) : null;
    if (!socketWorld) return null;
    const actual = new THREE.Vector3().setFromMatrixPosition(socketWorld).toArray();
    const errorMm = Math.hypot(...actual.map((value, axis) => value - expected[axis]));
    return { frameId, effector, expected: [...expected], actual, errorMm };
  }

  applyWorldMatrix(object, worldMatrix) {
    this.root.updateWorldMatrix(true, false);
    const local = this.root.matrixWorld.clone().invert().multiply(worldMatrix);
    local.decompose(object.position, object.quaternion, object.scale);
  }

  placeAtFrame(object, frame) {
    const origin = socketAlignedOrigin(frame, object);
    this.root.updateWorldMatrix(true, false);
    object.position.copy(this.root.worldToLocal(origin));
    object.quaternion.identity();
  }

  applyAuthoritativePose(object, item) {
    const position = item.worldPositionMm;
    const rotation = item.worldRotationMatrix;
    if (!Array.isArray(position) || position.length !== 3 || !Array.isArray(rotation) || rotation.length !== 9) return false;
    const matrix = new THREE.Matrix4().set(
      rotation[0], rotation[1], rotation[2], position[0],
      rotation[3], rotation[4], rotation[5], position[1],
      rotation[6], rotation[7], rotation[8], position[2],
      0, 0, 0, 1
    );
    this.applyWorldMatrix(object, matrix);
    return true;
  }

  update(state) {
    Object.values(state.objects || {}).forEach((item) => {
      const object = this.objectGroups.get(item.id);
      if (!object) return;
      object.visible = true;
      if (!this.applyAuthoritativePose(object, item)) {
        const frame = this.definition.frames[item.currentFrame] || this.definition.frames[item.initialFrame];
        if (frame) this.placeAtFrame(object, frame);
      }
      this.objectPresentation.set(item.id, { attachedTo: item.attachedTo || null, frameId: item.currentFrame });
    });
    this.frameGroups.forEach((group, id) => {
      const visited = (state.visitedFrames || []).includes(id);
      const current = state.lastReachedFrame === id;
      group.userData.ring.material.opacity = current ? 1 : visited ? 0.82 : 0.42;
      group.scale.setScalar(current ? 1.18 : 1);
    });
    this.fixtureGroups.forEach((mesh, id) => {
      const active = Object.values(state.processes || {}).some((process) => process.fixtureId === id && process.state !== "ready");
      const materials = mesh.userData.activeMaterials || (mesh.material ? [mesh.material] : []);
      materials.forEach((material) => {
        material.emissive?.set(active ? 0x1d8078 : 0x000000);
        material.emissiveIntensity = active ? 0.28 : 0;
      });
    });
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    disposeObject3D(this.root);
    this.frameGroups.clear();
    this.objectGroups.clear();
    this.fixtureGroups.clear();
    this.objectPresentation.clear();
  }
}
