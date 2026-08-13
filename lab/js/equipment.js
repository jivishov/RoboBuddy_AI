import * as THREE from "three";
import { createApparatusObject, disposeObject3D, objectSocket } from "./objects.js";

function makeLabelSprite(text, tone = "station") {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  const fill = tone === "hazard" ? "rgba(255, 244, 235, 0.97)" : "rgba(247, 250, 249, 0.97)";
  const stroke = tone === "hazard" ? "rgba(157, 66, 55, 0.82)" : "rgba(34, 91, 88, 0.76)";
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = fill;
  context.fillRect(2, 12, canvas.width - 4, 88);
  context.strokeStyle = stroke;
  context.lineWidth = 5;
  context.strokeRect(4.5, 14.5, canvas.width - 9, 83);
  context.fillStyle = "#213239";
  context.font = "700 36px DM Sans, Segoe UI, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, 56, canvas.width - 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false }));
  sprite.scale.set(126, 28, 1);
  sprite.renderOrder = 12;
  return sprite;
}

function makeStationPad(zone, footprint = [146, 108]) {
  const group = new THREE.Group();
  const hazard = zone.hazard === "hot zone" || zone.hazard.includes("waste");
  const color = zone.hazard === "hot zone" ? 0xb87828 : zone.hazard.includes("waste") ? 0x9d494e : 0x3c7772;
  const width = Math.max(112, Math.min(260, Number(footprint[0]) || 146));
  const depth = Math.max(92, Math.min(210, Number(footprint[1]) || 108));
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(width, 7, depth),
    new THREE.MeshStandardMaterial({ color: hazard ? 0x66584c : 0x627579, roughness: 0.78, metalness: 0.06 })
  );
  pad.name = `station-pad-${zone.id}`;
  pad.position.y = 3.5;
  pad.receiveShadow = true;
  group.add(pad);
  const border = new THREE.Mesh(
    new THREE.RingGeometry(0.46, 0.5, 4),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.86, side: THREE.DoubleSide })
  );
  border.scale.set(width, depth, 1);
  border.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
  border.position.y = 7.2;
  group.add(border);
  group.userData.pad = pad;
  group.userData.baseColor = pad.material.color.clone();
  return group;
}

function scaledFootprint(object, definition) {
  const source = object?.userData?.footprintMm || definition?.footprintMm || [76, 66];
  return [
    Math.max(24, Number(source[0] || 76) * Number(object?.scale?.x || 1)),
    Math.max(24, Number(source[1] || 66) * Number(object?.scale?.z || 1))
  ];
}

function footprintLayout(items, objectGroups, gap = 26) {
  if (!items.length) return new Map();
  if (items.length === 1) return new Map([[items[0].id, new THREE.Vector3()]]);
  const entries = items.map((item) => ({ item, size: scaledFootprint(objectGroups.get(item.id), item) }));
  const columns = items.length <= 3 ? items.length : Math.min(3, Math.ceil(Math.sqrt(items.length)));
  const rows = [];
  for (let index = 0; index < entries.length; index += columns) rows.push(entries.slice(index, index + columns));
  const rowDepths = rows.map((row) => Math.max(...row.map((entry) => entry.size[1])));
  const totalDepth = rowDepths.reduce((sum, depth) => sum + depth, 0) + gap * Math.max(0, rows.length - 1);
  const result = new Map();
  let cursorZ = -totalDepth / 2;
  rows.forEach((row, rowIndex) => {
    const totalWidth = row.reduce((sum, entry) => sum + entry.size[0], 0) + gap * Math.max(0, row.length - 1);
    let cursorX = -totalWidth / 2;
    row.forEach((entry) => {
      result.set(entry.item.id, new THREE.Vector3(cursorX + entry.size[0] / 2, 0, cursorZ + rowDepths[rowIndex] / 2));
      cursorX += entry.size[0] + gap;
    });
    cursorZ += rowDepths[rowIndex] + gap;
  });
  return result;
}

function aliasTargetId(item) {
  return item.visualParentId || "";
}

export class LabEquipmentScene {
  constructor(preview, definition) {
    this.preview = preview;
    this.definition = definition;
    this.scene = preview && preview.scene;
    this.originalBackground = this.scene?.background || null;
    this.originalFog = this.scene?.fog ? { color: this.scene.fog.color.clone(), near: this.scene.fog.near, far: this.scene.fog.far } : null;
    this.originalLightIntensities = [];
    this.hiddenPreviewGround = [];
    this.root = new THREE.Group();
    this.root.name = `lab-scenario-${definition.id}`;
    this.objectGroups = new Map();
    this.objectDefinitions = new Map(definition.apparatus.map((item) => [item.id, item]));
    this.zonePositions = new Map();
    this.zonePads = new Map();
    this.stationDocks = new Map();
    this.connectionGroup = new THREE.Group();
    this.connectionGroup.name = "lab-apparatus-connections";
    this.focusMarker = null;
    this.lastState = null;
    this.animationFrame = 0;
    this.transitionFrame = 0;
    this.transitionSequence = 0;
    this.transitionResolve = null;
    this.presentationRobot = null;
    this.presentationRobotBasePosition = null;
    this.contactDock = null;
    this.g1HideFrame = 0;
    this.g1HideAttempts = 0;
    if (!this.scene) throw new Error("The robot preview scene is not ready for lab equipment.");
    this.scene.background = new THREE.Color(0xa9b7bc);
    if (this.scene.fog) {
      this.scene.fog.color.set(0xa9b7bc);
      this.scene.fog.near = Math.max(this.scene.fog.near, 2050);
      this.scene.fog.far = Math.max(this.scene.fog.far, 4900);
    }
    this.scene.traverse((object) => {
      if (!object.isLight) return;
      this.originalLightIntensities.push([object, object.intensity]);
      object.intensity *= 0.52;
    });
    this.scene.children.forEach((object) => {
      const isPreviewGrid = object.type === "GridHelper";
      const isPreviewFloor = object.geometry?.type === "CircleGeometry" && object.rotation.x < -1.5;
      if (!isPreviewGrid && !isPreviewFloor) return;
      this.hiddenPreviewGround.push([object, object.visible]);
      object.visible = false;
    });
    this.hiddenG1TaskGroup = definition.robotId === "unitree_g1_29dof" ? preview.g1TaskObjects?.group || null : null;
    if (this.hiddenG1TaskGroup) this.hiddenG1TaskGroup.visible = false;
    else if (definition.robotId === "unitree_g1_29dof") this.g1HideFrame = window.requestAnimationFrame(() => this.ensureG1DemoObjectsHidden());
    this.build();
    this.scene.add(this.root);
    this.tick = this.tick.bind(this);
  }

  build() {
    const bench = new THREE.Mesh(
      new THREE.BoxGeometry(1040, 24, 760),
      new THREE.MeshStandardMaterial({ color: 0x53666c, roughness: 0.72, metalness: 0.08 })
    );
    bench.position.y = -12;
    bench.receiveShadow = true;
    this.root.add(bench);

    const benchEdge = new THREE.Mesh(
      new THREE.BoxGeometry(1040, 10, 20),
      new THREE.MeshStandardMaterial({ color: 0x24363d, roughness: 0.56, metalness: 0.16 })
    );
    benchEdge.position.set(0, -3, 370);
    this.root.add(benchEdge);

    const grid = new THREE.GridHelper(1000, 20, 0x81969a, 0x657a7f);
    grid.position.y = 1;
    grid.material.transparent = true;
    grid.material.opacity = 0.18;
    this.root.add(grid);

    const rim = new THREE.DirectionalLight(0xb9e2e1, 0.42);
    rim.position.set(-620, 460, -420);
    this.root.add(rim);
    const fill = new THREE.HemisphereLight(0xe6f1f0, 0x39474d, 0.56);
    this.root.add(fill);

    this.definition.apparatus.filter((item) => !aliasTargetId(item)).forEach((apparatus) => {
      const object = createApparatusObject(apparatus);
      const scale = this.definition.robotId === "unitree_g1_29dof"
        ? (apparatus.type === "secured_carrier" || apparatus.type === "rack" ? 1.7 : 1.25)
        : this.definition.robotId === "lekiwi_sim" ? 1.2 : 1.14;
      object.scale.setScalar(scale);
      this.objectGroups.set(apparatus.id, object);
      this.root.add(object);
    });
    this.definition.apparatus.filter((item) => aliasTargetId(item)).forEach((apparatus) => {
      const target = this.objectGroups.get(aliasTargetId(apparatus));
      if (target) this.objectGroups.set(apparatus.id, target);
    });

    const definitionsByZone = new Map();
    this.definition.apparatus.filter((item) => !aliasTargetId(item)).forEach((item) => {
      if (!definitionsByZone.has(item.initialZone)) definitionsByZone.set(item.initialZone, []);
      definitionsByZone.get(item.initialZone).push(item);
    });

    this.definition.zones.forEach((zone) => {
      const position = new THREE.Vector3(...(zone.visualPositionMm || zone.positionMm));
      this.zonePositions.set(zone.id, position);
      if (["home", "dock", "safety"].includes(zone.id)) return;
      const zoneObjects = definitionsByZone.get(zone.id) || [];
      const footprint = zoneObjects.reduce((size, item) => {
        const next = scaledFootprint(this.objectGroups.get(item.id), item);
        return [Math.max(size[0], next[0] + 28), Math.max(size[1], next[1] + 24)];
      }, [146, 108]);
      const pad = makeStationPad(zone, footprint);
      pad.position.copy(position);
      this.root.add(pad);
      this.zonePads.set(zone.id, pad);
      const label = makeLabelSprite(zone.label, zone.hazard === "none" ? "station" : "hazard");
      label.position.copy(position);
      label.position.y = 16;
      label.position.z += Math.min(126, Math.max(62, footprint[1] / 2 + 18));
      this.root.add(label);
    });

    (this.definition.navigationHazards || []).forEach((hazard) => {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(hazard.radiusMm, 48),
        new THREE.MeshBasicMaterial({ color: 0xa33f45, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(...(hazard.visualCenterMm || hazard.centerMm));
      disc.position.y = 1;
      this.root.add(disc);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(20, hazard.radiusMm - 4), hazard.radiusMm, 48),
        new THREE.MeshBasicMaterial({ color: 0xa33f45, transparent: true, opacity: 0.88, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(...(hazard.visualCenterMm || hazard.centerMm));
      ring.position.y = 2;
      this.root.add(ring);
      const label = makeLabelSprite(hazard.label, "hazard");
      label.position.set(...(hazard.visualCenterMm || hazard.centerMm));
      label.position.y = 38;
      this.root.add(label);
    });

    this.root.add(this.connectionGroup);
    this.focusMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0x50dfc5, transparent: true, opacity: 0.76, side: THREE.DoubleSide, depthWrite: false })
    );
    this.focusMarker.name = "active-checkpoint-marker";
    this.focusMarker.rotation.x = -Math.PI / 2;
    this.focusMarker.position.y = 10;
    this.focusMarker.visible = false;
    this.root.add(this.focusMarker);
  }

  effectorFrame(effector) {
    const robotId = this.definition.robotId;
    if (robotId === "unitree_g1_29dof") return this.preview.g1ToolFrames?.get(effector) || null;
    if (robotId === "openarm_v2_bimanual") return this.preview.groups?.[`${effector}_j7`] || null;
    return this.preview.groups?.gripperRoot || this.preview.groups?.wristTilt || null;
  }

  ensureG1DemoObjectsHidden() {
    const group = this.preview.g1TaskObjects?.group || null;
    if (group) {
      this.hiddenG1TaskGroup = group;
      group.visible = false;
      this.g1HideFrame = 0;
      return;
    }
    this.g1HideAttempts += 1;
    if (this.g1HideAttempts < 300) this.g1HideFrame = window.requestAnimationFrame(() => this.ensureG1DemoObjectsHidden());
    else this.g1HideFrame = 0;
  }

  effectorOffset(effector, object) {
    const robotId = this.definition.robotId;
    const height = (Number(object?.userData?.heightMm) || 40) * Number(object?.scale?.y || 1);
    if (robotId === "unitree_g1_29dof") return new THREE.Vector3(0, -Math.min(58, height * 0.55), 18);
    if (robotId === "openarm_v2_bimanual") return new THREE.Vector3(64, -Math.min(34, height * 0.3), effector === "left" ? -3 : 3);
    if (robotId === "arduino_arm") return new THREE.Vector3(0, -Math.min(72, height * 0.72), 0);
    return new THREE.Vector3(-Math.min(76, Math.max(36, height * 0.65)), 0, 0);
  }

  robotPresentationRoot() {
    return this.preview?.groups?.root || this.preview?.root || null;
  }

  beginRobotPresentation() {
    const robot = this.robotPresentationRoot();
    if (!robot) return null;
    this.presentationRobot = robot;
    this.presentationRobotBasePosition = robot.position.clone();
    return robot;
  }

  restoreRobotPresentation() {
    if (this.presentationRobot && this.presentationRobotBasePosition) {
      this.presentationRobot.position.copy(this.presentationRobotBasePosition);
      this.presentationRobot.updateWorldMatrix(true, true);
    }
    this.presentationRobot = null;
    this.presentationRobotBasePosition = null;
  }

  createContactDock(object) {
    this.removeContactDock();
    const footprint = scaledFootprint(object, object?.userData || {});
    const group = new THREE.Group();
    group.name = "lab-contact-lift";
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(116, footprint[0] + 28), 10, Math.max(96, footprint[1] + 24)),
      new THREE.MeshStandardMaterial({ color: 0x2d7773, roughness: 0.48, metalness: 0.34 })
    );
    plate.name = "lab-contact-lift-platform";
    plate.castShadow = true;
    plate.receiveShadow = true;
    group.add(plate);
    const column = new THREE.Mesh(
      new THREE.BoxGeometry(36, 1, 36),
      new THREE.MeshStandardMaterial({ color: 0x33494f, roughness: 0.56, metalness: 0.38 })
    );
    column.name = "lab-contact-lift-column";
    group.add(column);
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(92, footprint[0]), 8, Math.max(76, footprint[1])),
      new THREE.MeshStandardMaterial({ color: 0x263a40, roughness: 0.68, metalness: 0.24 })
    );
    base.position.y = 4;
    base.receiveShadow = true;
    group.add(base);
    group.userData.plate = plate;
    group.userData.column = column;
    group.userData.platformOffsetY = -7;
    this.root.add(group);
    this.contactDock = group;
    return group;
  }

  updateContactDock(dock, objectPosition) {
    if (!dock || !objectPosition) return;
    const platformY = Math.max(11, Number(objectPosition.y) + Number(dock.userData.platformOffsetY || -7));
    dock.position.set(objectPosition.x, 0, objectPosition.z);
    dock.userData.plate.position.y = platformY;
    dock.userData.column.position.y = Math.max(6, platformY / 2);
    dock.userData.column.scale.y = Math.max(8, platformY - 8);
    dock.visible = true;
  }

  removeContactDock() {
    if (!this.contactDock) return;
    if (this.contactDock.parent) this.contactDock.parent.remove(this.contactDock);
    disposeObject3D(this.contactDock);
    this.contactDock = null;
  }

  worldDeltaToParentLocal(object, worldDelta) {
    const parent = object?.parent;
    if (!parent) return worldDelta.clone();
    parent.updateWorldMatrix(true, false);
    const origin = parent.worldToLocal(new THREE.Vector3());
    const destination = parent.worldToLocal(worldDelta.clone());
    return destination.sub(origin);
  }

  objectAtFrame(object, frame, offset = new THREE.Vector3(), localRotation = null) {
    frame.updateWorldMatrix(true, false);
    this.root.updateWorldMatrix(true, false);
    const worldPosition = frame.localToWorld(offset.clone());
    object.position.copy(this.root.worldToLocal(worldPosition));
    const frameQuaternion = frame.getWorldQuaternion(new THREE.Quaternion());
    const rootQuaternion = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    object.quaternion.copy(rootQuaternion.multiply(frameQuaternion));
    if (localRotation) object.quaternion.multiply(new THREE.Quaternion().setFromEuler(localRotation));
  }

  worldGripDelta(itemId, effector) {
    const object = this.objectGroups.get(itemId);
    const frame = this.effectorFrame(effector);
    if (!object || !frame) return null;
    object.updateWorldMatrix(true, false);
    frame.updateWorldMatrix(true, false);
    const grip = object.userData?.sockets?.grip || [0, Number(object.userData?.heightMm) || 0, 0];
    const objectGrip = object.localToWorld(new THREE.Vector3(...grip));
    const frameGrip = frame.localToWorld(this.effectorOffset(effector, object));
    return objectGrip.sub(frameGrip);
  }

  worldGripDistance(itemId, effector) {
    return this.worldGripDelta(itemId, effector)?.length() ?? null;
  }

  worldPlacementDelta(object, targetPosition) {
    if (!object || !targetPosition) return null;
    object.updateWorldMatrix(true, false);
    this.root.updateWorldMatrix(true, false);
    const currentWorld = object.getWorldPosition(new THREE.Vector3());
    const targetWorld = this.root.localToWorld(targetPosition.clone());
    return targetWorld.sub(currentWorld);
  }

  alignSocketToFrame(object, sourceSocketName, frame, targetOffset = new THREE.Vector3(), localRotation = null) {
    this.objectAtFrame(object, frame, targetOffset, localRotation);
    const rawSource = object?.userData?.sockets?.[sourceSocketName];
    if (!Array.isArray(rawSource)) return;
    const source = new THREE.Vector3(...rawSource);
    if (source.lengthSq() <= 0.0001) return;
    const scaledSource = source.multiply(object.scale);
    scaledSource.applyQuaternion(object.quaternion);
    object.position.sub(scaledSource);
  }

  insertedRotation(item) {
    if (item.type === "pipette_pump") return new THREE.Euler(0, 0, -Math.PI / 2);
    if (item.type === "funnel" || item.type === "buchner_funnel" || item.type === "stopper" || item.type === "cuvette") return new THREE.Euler(0, 0, 0);
    return null;
  }

  placementHost(item, zoneItems, allItems = zoneItems) {
    if (item.type === "cuvette") {
      const rack = zoneItems.find((candidate) => candidate.type === "rack" && candidate.id !== item.id);
      if (rack) return rack;
    }
    if (item.type === "buchner_funnel") {
      const flask = zoneItems.find((candidate) => candidate.type === "filter_flask" && candidate.id !== item.id);
      if (flask) return flask;
    }
    const carrierLike = item.type === "secured_carrier" || item.visualVariant === "rack" || item.type === "rack";
    const mobileLogistics = ["lekiwi_sim", "unitree_g1_29dof"].includes(this.definition.robotId);
    if (carrierLike && mobileLogistics) return null;
    const compatibleByZone = {
      balance_zone: { balance: ["watch_glass", "weigh_boat", "secured_carrier"] },
      oven_zone: { oven: ["watch_glass", "secured_carrier"] },
      cooling_zone: { cooling_rack: ["watch_glass", "secured_carrier"] },
      instrument_zone: { instrument: ["cuvette"] },
      chromatography_zone: { chromatography_chamber: ["chromatography_paper"] },
      stand_zone: { stand: ["funnel"] },
      burette_receiver_zone: { burette: ["flask"] }
    };
    const contracts = compatibleByZone[item.currentZone] || {};
    const candidates = item.currentZone === "burette_receiver_zone" ? allItems : zoneItems;
    let host = candidates.find((candidate) => (contracts[candidate.type] || []).includes(item.type) && candidate.id !== item.id);
    return host || null;
  }

  hostSocket(item, host) {
    if (!host) return "place";
    if (host.type === "burette" && item.type === "flask") return "receiver";
    if (host.type === "oven") return "insert";
    if (host.type === "instrument" || host.type === "chromatography_chamber" || host.type === "stand" || host.type === "filter_flask") return "insert";
    return "place";
  }

  sourceSocket(item) {
    if (["filter_paper", "chromatography_paper", "funnel", "buchner_funnel", "stopper", "cuvette", "pipette_pump"].includes(item.type)) return "attach";
    return "base";
  }

  applyState(state) {
    this.lastState = state;
    this.syncState(state);
    if (!this.animationFrame && state.apparatus.some((item) => item.heldBy)) this.animationFrame = window.requestAnimationFrame(this.tick);
  }

  update(state) {
    this.cancelTransition();
    this.applyState(state);
  }

  apparatusTransition(previousState, nextState) {
    if (!previousState?.apparatus || !nextState?.apparatus) return null;
    const previousItems = new Map(previousState.apparatus.map((item) => [item.id, item]));
    for (const nextItem of nextState.apparatus) {
      const previousItem = previousItems.get(nextItem.id);
      if (!previousItem || aliasTargetId(nextItem)) continue;
      if (!previousItem.heldBy && nextItem.heldBy) {
        return { kind: "grasp", itemId: nextItem.id, effector: nextItem.heldBy };
      }
      if (previousItem.heldBy && !nextItem.heldBy) {
        return {
          kind: nextItem.insertedInto ? "insert" : "release",
          itemId: nextItem.id,
          effector: previousItem.heldBy,
          targetId: nextItem.insertedInto || nextItem.currentZone || ""
        };
      }
    }
    return null;
  }

  transitionKind(previousState, nextState) {
    return this.apparatusTransition(previousState, nextState)?.kind || "";
  }

  cancelTransition() {
    this.transitionSequence += 1;
    if (this.transitionFrame) window.cancelAnimationFrame(this.transitionFrame);
    this.transitionFrame = 0;
    this.restoreRobotPresentation();
    this.removeContactDock();
    const resolve = this.transitionResolve;
    this.transitionResolve = null;
    if (resolve) resolve(false);
  }

  presentSecuredCarrierTransition(transition, object, previousState, nextState, startPosition, startQuaternion, endPosition, endQuaternion, options = {}) {
    const frame = this.effectorFrame(transition.effector);
    if (!frame) {
      options.onContactProgress?.(1);
      this.applyState(nextState);
      return Promise.resolve(true);
    }
    const currentPosition = object.position.clone();
    const currentQuaternion = object.quaternion.clone();
    this.alignSocketToFrame(object, "grip", frame, this.effectorOffset(transition.effector, object));
    const contactPosition = object.position.clone();
    const contactQuaternion = object.quaternion.clone();
    object.position.copy(currentPosition);
    object.quaternion.copy(currentQuaternion);
    const dock = this.createContactDock(object);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const durationMs = reducedMotion ? 0 : Math.max(820, Math.min(1500, Number(options.durationMs) || 920));
    if (!durationMs) {
      this.removeContactDock();
      options.onContactProgress?.(1);
      this.applyState(nextState);
      return Promise.resolve(true);
    }
    const sequence = this.transitionSequence;
    const isActive = typeof options.isActive === "function" ? options.isActive : () => true;
    const isPaused = typeof options.isPaused === "function" ? options.isPaused : () => false;
    const reachEnd = 0.44;
    const contactEnd = 0.6;
    return new Promise((resolve) => {
      this.transitionResolve = resolve;
      let elapsedMs = 0;
      let previousTimestamp = 0;
      let contacted = false;
      const finish = (completed) => {
        if (this.transitionFrame) window.cancelAnimationFrame(this.transitionFrame);
        this.transitionFrame = 0;
        this.transitionResolve = null;
        this.removeContactDock();
        if (completed) this.applyState(nextState);
        resolve(completed);
      };
      const completeContact = () => {
        options.onContactProgress?.(1);
        if (transition.kind === "grasp") {
          this.alignSocketToFrame(object, "grip", frame, this.effectorOffset(transition.effector, object));
          this.removeContactDock();
        } else {
          object.position.copy(contactPosition);
          object.quaternion.copy(contactQuaternion);
        }
        object.visible = true;
        this.lastState = nextState;
        contacted = true;
      };
      const step = (timestamp) => {
        if (sequence !== this.transitionSequence || !isActive()) {
          finish(false);
          return;
        }
        if (!previousTimestamp) previousTimestamp = timestamp;
        const deltaMs = Math.min(48, Math.max(0, timestamp - previousTimestamp));
        previousTimestamp = timestamp;
        if (!isPaused()) elapsedMs += deltaMs;
        const progress = Math.min(1, elapsedMs / durationMs);
        if (!contacted) {
          if (transition.kind === "grasp") {
            const reachProgress = Math.min(1, progress / reachEnd);
            const easedReach = 1 - (1 - reachProgress) ** 3;
            object.position.lerpVectors(startPosition, contactPosition, easedReach);
            object.quaternion.slerpQuaternions(startQuaternion, contactQuaternion, easedReach);
            this.updateContactDock(dock, object.position);
          } else {
            this.syncHeldObjects(previousState);
            const dockProgress = Math.min(1, progress / reachEnd);
            const easedDock = 1 - (1 - dockProgress) ** 3;
            const dockPosition = new THREE.Vector3().lerpVectors(endPosition, contactPosition, easedDock);
            this.updateContactDock(dock, dockPosition);
          }
          if (progress >= reachEnd) options.onContactProgress?.(Math.min(1, (progress - reachEnd) / (contactEnd - reachEnd)));
          if (progress >= contactEnd) completeContact();
        }
        if (contacted) {
          if (transition.kind === "grasp") {
            this.syncHeldObjects(nextState);
          } else {
            const lowerProgress = Math.min(1, Math.max(0, (progress - contactEnd) / (1 - contactEnd)));
            const easedLower = lowerProgress < 0.5 ? 4 * lowerProgress ** 3 : 1 - (-2 * lowerProgress + 2) ** 3 / 2;
            object.position.lerpVectors(contactPosition, endPosition, easedLower);
            object.quaternion.slerpQuaternions(contactQuaternion, endQuaternion, easedLower);
            this.updateContactDock(dock, object.position);
          }
        }
        object.visible = true;
        if (progress >= 1) {
          finish(true);
          return;
        }
        this.transitionFrame = window.requestAnimationFrame(step);
      };
      this.transitionFrame = window.requestAnimationFrame(step);
    });
  }

  presentTransition(previousState, nextState, options = {}) {
    this.cancelTransition();
    const transition = this.apparatusTransition(previousState, nextState);
    if (!transition) {
      this.applyState(nextState);
      return Promise.resolve(true);
    }

    const object = this.objectGroups.get(transition.itemId);
    if (!object) {
      this.applyState(nextState);
      return Promise.resolve(true);
    }

    if (this.animationFrame) window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.lastState = previousState;
    this.syncState(previousState);
    const startPosition = object.position.clone();
    const startQuaternion = object.quaternion.clone();

    // Use the same reusable socket/host resolver as steady-state rendering to
    // obtain an exact destination, then restore the pre-command visual pose.
    this.syncState(nextState);
    const endPosition = object.position.clone();
    const endQuaternion = object.quaternion.clone();
    object.position.copy(startPosition);
    object.quaternion.copy(startQuaternion);
    object.visible = true;
    this.lastState = previousState;

    if (this.definition.robotId === "unitree_g1_29dof") {
      return this.presentSecuredCarrierTransition(
        transition,
        object,
        previousState,
        nextState,
        startPosition,
        startQuaternion,
        endPosition,
        endQuaternion,
        options
      );
    }

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const robot = this.beginRobotPresentation();
    const gripDistanceMm = this.worldGripDistance(transition.itemId, transition.effector) || 0;
    const placementDistanceMm = startPosition.distanceTo(endPosition);
    const contactTravelMm = transition.kind === "grasp" ? gripDistanceMm : placementDistanceMm;
    const requestedDurationMs = Number(options.durationMs) || 820;
    const durationMs = reducedMotion ? 0 : Math.max(720, Math.min(1500, Math.max(requestedDurationMs, 620 + contactTravelMm * 0.52)));
    if (!durationMs || !robot) {
      this.restoreRobotPresentation();
      options.onContactProgress?.(1);
      this.applyState(nextState);
      return Promise.resolve(true);
    }

    const sequence = this.transitionSequence;
    const isActive = typeof options.isActive === "function" ? options.isActive : () => true;
    const isPaused = typeof options.isPaused === "function" ? options.isPaused : () => false;
    const reachEnd = 0.58;
    const contactEnd = 0.72;
    const robotBasePosition = this.presentationRobotBasePosition.clone();
    const dock = this.createContactDock(object);
    return new Promise((resolve) => {
      this.transitionResolve = resolve;
      let elapsedMs = 0;
      let previousTimestamp = 0;
      let contactPosition = null;
      let contactObjectPosition = null;
      let contactObjectQuaternion = null;
      let contacted = false;
      const finish = (completed) => {
        if (this.transitionFrame) window.cancelAnimationFrame(this.transitionFrame);
        this.transitionFrame = 0;
        this.transitionResolve = null;
        this.restoreRobotPresentation();
        this.removeContactDock();
        if (completed) this.applyState(nextState);
        resolve(completed);
      };
      const exactContactPosition = () => {
        const worldDelta = transition.kind === "grasp"
          ? this.worldGripDelta(transition.itemId, transition.effector)
          : this.worldPlacementDelta(object, endPosition);
        if (!worldDelta) return robot.position.clone();
        worldDelta.y = 0;
        return robot.position.clone().add(this.worldDeltaToParentLocal(robot, worldDelta));
      };
      const graspContactTransform = () => {
        const frame = this.effectorFrame(transition.effector);
        if (!frame) return { position: object.position.clone(), quaternion: object.quaternion.clone() };
        const savedPosition = object.position.clone();
        const savedQuaternion = object.quaternion.clone();
        this.alignSocketToFrame(object, "grip", frame, this.effectorOffset(transition.effector, object));
        const result = { position: object.position.clone(), quaternion: object.quaternion.clone() };
        object.position.copy(savedPosition);
        object.quaternion.copy(savedQuaternion);
        return result;
      };
      const attachOrReleaseAtContact = () => {
        options.onContactProgress?.(1);
        if (transition.kind === "grasp") {
          const frame = this.effectorFrame(transition.effector);
          if (frame) this.alignSocketToFrame(object, "grip", frame, this.effectorOffset(transition.effector, object));
          this.removeContactDock();
        } else {
          contactObjectPosition = object.position.clone();
          contactObjectQuaternion = object.quaternion.clone();
        }
        object.visible = true;
        this.lastState = nextState;
        contactPosition = robot.position.clone();
        contacted = true;
      };
      const step = (timestamp) => {
        if (sequence !== this.transitionSequence || !isActive()) {
          finish(false);
          return;
        }
        if (!previousTimestamp) previousTimestamp = timestamp;
        const deltaMs = Math.min(48, Math.max(0, timestamp - previousTimestamp));
        previousTimestamp = timestamp;
        if (!isPaused()) elapsedMs += deltaMs;
        const progress = Math.min(1, elapsedMs / durationMs);
        if (!contacted) {
          if (transition.kind !== "grasp") this.syncHeldObjects(previousState);
          else this.syncHeldObjects(previousState, transition.itemId);
          const targetRobotPosition = exactContactPosition();
          if (progress < reachEnd) {
            const approachProgress = progress / reachEnd;
            const easedApproach = approachProgress < 0.5
              ? 4 * approachProgress ** 3
              : 1 - (-2 * approachProgress + 2) ** 3 / 2;
            robot.position.lerpVectors(robotBasePosition, targetRobotPosition, easedApproach);
            robot.updateWorldMatrix(true, true);
            if (transition.kind === "grasp") {
              const contact = graspContactTransform();
              object.position.lerpVectors(startPosition, contact.position, easedApproach);
              object.quaternion.slerpQuaternions(startQuaternion, contact.quaternion, easedApproach);
              this.updateContactDock(dock, object.position);
            } else {
              this.syncHeldObjects(previousState);
              const dockPosition = new THREE.Vector3().lerpVectors(endPosition, object.position, easedApproach);
              this.updateContactDock(dock, dockPosition);
            }
          } else {
            robot.position.copy(targetRobotPosition);
            robot.updateWorldMatrix(true, true);
            if (transition.kind === "grasp") {
              const contact = graspContactTransform();
              object.position.copy(contact.position);
              object.quaternion.copy(contact.quaternion);
              this.updateContactDock(dock, object.position);
            } else {
              this.syncHeldObjects(previousState);
              this.updateContactDock(dock, object.position);
            }
            const contactProgress = Math.min(1, (progress - reachEnd) / (contactEnd - reachEnd));
            options.onContactProgress?.(contactProgress);
            if (progress >= contactEnd) attachOrReleaseAtContact();
          }
        }
        if (contacted) {
          const retreatProgress = Math.min(1, Math.max(0, (progress - contactEnd) / (1 - contactEnd)));
          const easedRetreat = 1 - (1 - retreatProgress) ** 3;
          robot.position.lerpVectors(contactPosition, robotBasePosition, easedRetreat);
          robot.updateWorldMatrix(true, true);
          if (transition.kind === "grasp") this.syncHeldObjects(nextState);
          else {
            object.position.lerpVectors(contactObjectPosition, endPosition, easedRetreat);
            object.quaternion.slerpQuaternions(contactObjectQuaternion, endQuaternion, easedRetreat);
            this.updateContactDock(dock, object.position);
            this.syncHeldObjects(nextState, transition.itemId);
          }
        }
        object.visible = true;
        if (progress >= 1) {
          finish(true);
          return;
        }
        this.transitionFrame = window.requestAnimationFrame(step);
      };
      this.transitionFrame = window.requestAnimationFrame(step);
    });
  }

  syncHeldObjects(state, excludedItemId = "") {
    if (!state?.apparatus) return;
    state.apparatus.forEach((item) => {
      if (!item.heldBy || item.id === excludedItemId || aliasTargetId(item) || item.removed) return;
      const object = this.objectGroups.get(item.id);
      const frame = object && this.effectorFrame(item.heldBy);
      if (!object || !frame) return;
      this.alignSocketToFrame(object, "grip", frame, this.effectorOffset(item.heldBy, object));
      object.visible = true;
    });
    this.syncFocusMarker(state);
  }

  syncState(state) {
    const zoneItems = new Map();
    state.apparatus.filter((item) => !item.heldBy && !item.insertedInto && !aliasTargetId(item) && !item.removed).forEach((item) => {
      if (!zoneItems.has(item.currentZone)) zoneItems.set(item.currentZone, []);
      zoneItems.get(item.currentZone).push(item);
    });
    const offsets = new Map();
    zoneItems.forEach((items, zoneId) => {
      const ordered = [...items].sort((a, b) => Number(Boolean(b.sceneOnly || !b.affordances?.graspable)) - Number(Boolean(a.sceneOnly || !a.affordances?.graspable)) || a.id.localeCompare(b.id));
    const independentlyPositioned = ordered.filter((item) => !this.placementHost(item, ordered, state.apparatus));
      footprintLayout(independentlyPositioned, this.objectGroups).forEach((offset, id) => offsets.set(`${zoneId}:${id}`, offset));
    });

    const positionedObjects = new Set();
    const stateItems = new Map(state.apparatus.map((item) => [item.id, item]));
    const positioning = new Set();
    const positionItem = (item) => {
      const object = this.objectGroups.get(item.id);
      if (!object || aliasTargetId(item) || positionedObjects.has(object)) return;
      if (positioning.has(item.id)) return;
      positioning.add(item.id);
      if (item.heldBy) {
        const frame = this.effectorFrame(item.heldBy);
        if (frame) this.alignSocketToFrame(object, "grip", frame, this.effectorOffset(item.heldBy, object));
      } else if (item.insertedInto) {
        const targetItem = stateItems.get(item.insertedInto);
        if (targetItem) positionItem(targetItem);
        const targetObject = this.objectGroups.get(item.insertedInto);
        if (targetObject) {
          const targetSocket = targetItem?.type === "burette" && item.type === "funnel" ? "fill" : "insert";
          this.alignSocketToFrame(object, this.sourceSocket(item), targetObject, objectSocket(targetObject, targetSocket), this.insertedRotation(item));
        }
      } else {
        const items = zoneItems.get(item.currentZone) || [];
        const hostItem = this.placementHost(item, items, state.apparatus);
        if (hostItem) positionItem(hostItem);
        const hostObject = hostItem ? this.objectGroups.get(hostItem.id) : null;
        if (hostObject) {
          const sourceSocket = hostItem.type === "burette" && item.type === "flask" ? "attach" : this.sourceSocket(item);
          this.alignSocketToFrame(object, sourceSocket, hostObject, objectSocket(hostObject, this.hostSocket(item, hostItem)));
          if (hostItem.type === "burette" && item.type === "flask" && !object.userData.sockets?.attach) {
            const receiveHeight = Number(object.userData.sockets?.insert?.[1] ?? object.userData.sockets?.receive?.[1] ?? object.userData.heightMm) || 0;
            object.position.y -= receiveHeight * Number(object.scale.y || 1);
          }
        } else {
          let zone = (this.zonePositions.get(item.currentZone) || new THREE.Vector3()).clone();
          const destinationHost = ["burette_receiver_zone"].includes(item.currentZone)
            ? state.apparatus.find((candidate) => candidate.type === "burette")
            : null;
          const destinationHostObject = destinationHost ? this.objectGroups.get(destinationHost.id) : null;
          if (destinationHostObject) {
            destinationHostObject.updateWorldMatrix(true, false);
            zone = this.root.worldToLocal(destinationHostObject.localToWorld(objectSocket(destinationHostObject, "receiver")));
            if (!object.userData.sockets?.attach) {
              const receiveHeight = Number(object.userData.sockets?.insert?.[1] ?? object.userData.sockets?.receive?.[1] ?? object.userData.heightMm) || 0;
              zone.y -= receiveHeight * Number(object.scale.y || 1);
            }
          }
          const offset = offsets.get(`${item.currentZone}:${item.id}`) || new THREE.Vector3();
          object.position.copy(zone.add(offset));
          if (!destinationHostObject) object.position.y += 8;
          object.rotation.set(0, item.orientation === "reversed" ? Math.PI : 0, 0);
        }
      }
      object.visible = item.removed !== true;
      positionedObjects.add(object);
      positioning.delete(item.id);
    };
    state.apparatus.forEach(positionItem);
    this.objectGroups.forEach((object) => {
      if (!positionedObjects.has(object) && ![...this.definition.apparatus].some((item) => aliasTargetId(item) && this.objectGroups.get(item.id) === object)) object.visible = false;
    });
    this.syncVisualState(state);
  }

  syncFocusMarker(state) {
    const checkpoint = this.definition.checkpoints[state.checkpointIndex] || null;
    const expectedId = checkpoint?.expected?.objectId || checkpoint?.expected?.controlId || checkpoint?.expected?.instrumentId || checkpoint?.expected?.targetId || "";
    const expected = state.apparatus.find((item) => item.id === expectedId);
    const expectedObject = expected ? this.objectGroups.get(expected.id) : null;
    if (this.focusMarker && expectedObject && expectedObject.visible) {
      expectedObject.updateWorldMatrix(true, false);
      const world = expectedObject.localToWorld(new THREE.Vector3());
      this.focusMarker.position.copy(this.root.worldToLocal(world));
      this.focusMarker.position.y = Math.max(9, this.focusMarker.position.y + 3);
      const footprint = scaledFootprint(expectedObject, expected);
      this.focusMarker.scale.set(Math.max(30, footprint[0] * 0.62), Math.max(30, footprint[1] * 0.62), 1);
      this.focusMarker.visible = true;
    } else if (this.focusMarker) this.focusMarker.visible = false;
  }

  syncVisualState(state) {
    const checkpoint = this.definition.checkpoints[state.checkpointIndex] || null;
    this.syncFocusMarker(state);

    this.zonePads.forEach((pad, zoneId) => {
      const mesh = pad.userData.pad;
      if (!mesh) return;
      const activeZone = checkpoint?.expected?.at || checkpoint?.expected?.zoneId || checkpoint?.expected?.requiredPose;
      mesh.material.color.copy(pad.userData.baseColor);
      mesh.material.emissive?.set(activeZone === zoneId ? 0x183d3a : 0x000000);
      mesh.material.emissiveIntensity = activeZone === zoneId ? 0.42 : 0;
    });

    state.apparatus.forEach((item) => {
      const object = this.objectGroups.get(item.id);
      if (!object) return;
      const active = Object.keys(item.operationState || {}).length > 0;
      object.traverse((part) => {
        if (part.name === "status-light" && part.material?.emissive) {
          part.material.emissive.set(active ? 0x35d29c : 0x183631);
          part.material.emissiveIntensity = active ? 1.1 : 0.24;
        }
        if (part.name === "stopcock") part.rotation.y = item.operationState?.open || item.operationState?.deliver_titrant ? Math.PI / 2 : 0;
        if (part.name === "liquid" && item.transferState === "transferred") part.visible = false;
      });
    });
    this.syncVacuumConnection(state);
  }

  syncVacuumConnection(state) {
    while (this.connectionGroup.children.length) {
      const child = this.connectionGroup.children[0];
      this.connectionGroup.remove(child);
      disposeObject3D(child);
    }
    const control = state.apparatus.find((item) => item.id === "vacuum_connection" || item.type === "vacuum_source" && item.state?.connection === "connected");
    const connected = control?.state?.connection === "connected" || Boolean(control?.operationState?.connect);
    if (!connected) return;
    const sourceItem = state.apparatus.find((item) => item.type === "vacuum_source");
    const flaskItem = state.apparatus.find((item) => item.type === "filter_flask");
    const source = sourceItem && this.objectGroups.get(sourceItem.id);
    const flask = flaskItem && this.objectGroups.get(flaskItem.id);
    if (!source || !flask) return;
    source.updateWorldMatrix(true, false);
    flask.updateWorldMatrix(true, false);
    const start = this.root.worldToLocal(source.localToWorld(objectSocket(source, "vacuum")));
    const end = this.root.worldToLocal(flask.localToWorld(objectSocket(flask, "vacuum")));
    const controlPoint = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 34, 22));
    const curve = new THREE.QuadraticBezierCurve3(start, controlPoint, end);
    const hose = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 3.4, 10, false), new THREE.MeshStandardMaterial({ color: 0x26383b, roughness: 0.62 }));
    hose.name = "connected-vacuum-hose";
    this.connectionGroup.add(hose);
  }

  tick() {
    if (this.lastState && this.lastState.apparatus.some((item) => item.heldBy)) {
      this.syncHeldObjects(this.lastState);
      this.animationFrame = window.requestAnimationFrame(this.tick);
    } else {
      this.animationFrame = 0;
    }
  }

  dispose() {
    this.cancelTransition();
    if (this.animationFrame) window.cancelAnimationFrame(this.animationFrame);
    if (this.g1HideFrame) window.cancelAnimationFrame(this.g1HideFrame);
    if (this.root.parent) this.root.parent.remove(this.root);
    this.scene.background = this.originalBackground;
    if (this.scene.fog && this.originalFog) {
      this.scene.fog.color.copy(this.originalFog.color);
      this.scene.fog.near = this.originalFog.near;
      this.scene.fog.far = this.originalFog.far;
    }
    this.originalLightIntensities.forEach(([light, intensity]) => { light.intensity = intensity; });
    this.hiddenPreviewGround.forEach(([object, visible]) => { object.visible = visible; });
    if (this.hiddenG1TaskGroup) this.hiddenG1TaskGroup.visible = true;
    disposeObject3D(this.root);
    this.objectGroups.clear();
    this.objectDefinitions.clear();
    this.zonePositions.clear();
    this.zonePads.clear();
    this.stationDocks.clear();
    this.lastState = null;
  }
}
