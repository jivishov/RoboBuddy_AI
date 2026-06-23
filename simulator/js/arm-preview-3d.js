import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ARM_PREVIEW_MESH_DATA } from "./arm-preview-mesh-data.js?v=20260611-meshdata";
import { ARM_RIG_CONFIG } from "./arm-rig-config.js?v=20260611-meshdata";

const NS = (window.RoboAdmin = window.RoboAdmin || {});
const PreviousArmPreview = NS.ArmPreview;
const DEG_TO_RAD = Math.PI / 180;
const DEFAULT_HOME = [90, 90, 90, 90, 90, 90];

const registry = (window.RoboBuddy3DPreview = window.RoboBuddy3DPreview || {});
registry.registered = true;
registry.ArmPreview2D = PreviousArmPreview;

class ArmPreview3D {
  constructor(svgElement, options = {}) {
    this.svg = svgElement;
    this.options = options;
    this.config = ARM_RIG_CONFIG;
    this.jointLimits = Array.isArray(options.jointLimits) ? options.jointLimits : this.config.firmware.limits;
    this.angles = this._sanitizeAngles(options.initialAngles || this.config.firmware.home || DEFAULT_HOME);
    this.groups = {};
    this.meshes = {};
    this.meshErrors = [];
    this.categoryGroups = new Map();
    this.jointDefs = new Map();
    this.fallback = null;
    this.ready = false;
    this.animationFrame = 0;
    this.resizeObserver = null;
    this.verticalPanState = null;
    this._boundResize = () => this.resize();
    this._boundResetCamera = () => this.resetCamera();
    this._boundVerticalPanPointerDown = (event) => this.handleVerticalPanPointerDown(event);
    this._boundVerticalPanPointerMove = (event) => this.handleVerticalPanPointerMove(event);
    this._boundVerticalPanPointerUp = (event) => this.handleVerticalPanPointerUp(event);

    try {
      this.container = svgElement.closest(".arm-preview-container") || svgElement.parentElement;
      this.host = this.container ? this.container.querySelector("[data-arm-preview-3d]") : null;
      this.viewport = this.host ? this.host.querySelector("[data-arm-preview-3d-viewport]") : null;
      this.statusEl = this.host ? this.host.querySelector("[data-arm-preview-3d-status]") : null;
      this.resetButton = this.host ? this.host.querySelector("[data-arm-preview-3d-reset]") : null;
      this.fallbackStatus = this.container ? this.container.querySelector("[data-arm-preview-3d-fallback-status]") : null;

      if (!this.container || !this.host || !this.viewport) {
        throw new Error("3D preview host markup is missing.");
      }

      this.initScene();
      this.buildRig();
      this.bindUi();
      this.reveal3D();
      this.resetCamera();
      this.resize();
      this.applyPose();
      this.ready = true;
      registry.ready = true;
      registry.instance = this;
      void this.startMeshLoading();
      this.animate();
    } catch (error) {
      this.useFallback(error);
    }
  }

  setAngles(nextAngles) {
    if (this.fallback) {
      this.fallback.setAngles(nextAngles);
      return;
    }
    if (!Array.isArray(nextAngles) || nextAngles.length < 6) {
      return;
    }
    this.angles = this._sanitizeAngles(nextAngles);
    if (this.ready) {
      this.applyPose();
    }
  }

  setAngle(index, value) {
    if (this.fallback) {
      this.fallback.setAngle(index, value);
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index > 5) {
      return;
    }
    const next = this.angles.slice();
    next[index] = value;
    this.setAngles(next);
  }

  getAngles() {
    if (this.fallback) {
      return this.fallback.getAngles();
    }
    return this.angles.slice();
  }

  setInteractive(enabled) {
    if (this.fallback) {
      this.fallback.setInteractive(enabled);
      return;
    }
    if (this.container) {
      this.container.classList.toggle("is-3d-disabled", !Boolean(enabled));
    }
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x11161a);
    this.scene.fog = new THREE.Fog(0x11161a, 900, 1600);

    this.camera = new THREE.PerspectiveCamera(46, 1, 1, 1800);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.viewport.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 180, 0);

    this.materials = this.createMaterials();
    this.installSceneLights();
  }

  createMaterials() {
    const materials = {};
    Object.entries(this.config.materials).forEach(([key, options]) => {
      materials[key] = new THREE.MeshStandardMaterial({
        color: options.color,
        roughness: options.roughness,
        metalness: options.metalness
      });
    });
    return materials;
  }

  installSceneLights() {
    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x1d252d, 1.35);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(260, 420, 250);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.left = -360;
    keyLight.shadow.camera.right = 360;
    keyLight.shadow.camera.top = 520;
    keyLight.shadow.camera.bottom = -180;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x75d6ff, 0.62);
    fillLight.position.set(-360, 220, -240);
    this.scene.add(fillLight);

    const grid = new THREE.GridHelper(520, 26, 0x4b5966, 0x27313a);
    grid.position.y = -0.5;
    this.scene.add(grid);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(290, 96),
      new THREE.MeshStandardMaterial({
        color: 0x151b20,
        roughness: 0.82,
        metalness: 0
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  buildRig() {
    const root = new THREE.Group();
    root.name = "arm-root";
    this.scene.add(root);
    this.groups.root = root;

    this.groups.staticBase = new THREE.Group();
    this.groups.staticBase.name = "static-base";
    root.add(this.groups.staticBase);

    this.config.kinematicChain.forEach((joint) => {
      const parent = this.groups[joint.parent];
      if (!parent) {
        throw new Error(`Missing parent group "${joint.parent}" for joint "${joint.id}".`);
      }
      const group = this.createJointGroup(joint.id, joint.pivot, parent);
      group.userData.joint = joint;
      this.groups[joint.id] = group;
      this.jointDefs.set(joint.id, joint);
    });

    this.buildGripperLinkage();
  }

  createJointGroup(name, position, parent) {
    const group = new THREE.Group();
    group.name = name;
    group.position.fromArray(position);
    parent.add(group);
    return group;
  }

  buildGripperLinkage() {
    const linkage = this.config.gripperLinkage;
    if (!linkage) {
      return;
    }
    const parent = this.groups[linkage.parent];
    if (!parent) {
      throw new Error(`Missing parent group "${linkage.parent}" for gripper linkage.`);
    }

    const root = new THREE.Group();
    root.name = linkage.rootGroup;
    root.position.fromArray(linkage.rootPosition);
    setEulerDegrees(root, linkage.rootRotation);
    parent.add(root);
    this.groups[linkage.rootGroup] = root;

    const anchor = linkage.baseAnchor;
    const toLocal = (axle) => [axle[0] - anchor[0], -anchor[1], axle[1] - anchor[2]];

    this.gripperState = {};
    Object.entries(linkage.sides).forEach(([key, side]) => {
      this.groups[side.crankGroup] = this.createJointGroup(side.crankGroup, toLocal(side.crankAxle), root);
      this.groups[side.linkGroup] = this.createJointGroup(side.linkGroup, toLocal(side.linkAxle), root);
      this.groups[side.couplerGroup] = this.createJointGroup(side.couplerGroup, toLocal(side.crankAxle), root);

      const theta0 = side.crankZeroDeg * DEG_TO_RAD;
      const h0 = this.crankPoint(side, theta0);
      const l0 = this.solveFourBar(side, h0);
      if (!l0) {
        throw new Error(`Gripper four-bar has no solution at rest pose (${key}).`);
      }
      this.gripperState[key] = {
        h0,
        l0,
        linkAngle0: Math.atan2(l0.z - side.linkAxle[1], l0.x - side.linkAxle[0]),
        couplerAngle0: Math.atan2(l0.z - h0.z, l0.x - h0.x),
        travelDeg: this.solvableCrankTravel(side)
      };
    });
  }

  bindUi() {
    if (this.resetButton) {
      this.resetButton.addEventListener("click", this._boundResetCamera);
    }
    if (this.renderer && this.renderer.domElement) {
      this.renderer.domElement.addEventListener("pointerdown", this._boundVerticalPanPointerDown, true);
    }
    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
    window.addEventListener("resize", this._boundResize);
  }

  handleVerticalPanPointerDown(event) {
    if (!this.camera || !this.controls || !this.renderer || !this.renderer.domElement) {
      return;
    }
    if (!this.controls.enabled || event.button !== 0 || !event.shiftKey) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    if (this.verticalPanState) {
      this.endVerticalPan(this.verticalPanState.pointerId);
    }

    const canvas = this.renderer.domElement;
    this.verticalPanState = {
      pointerId: event.pointerId,
      lastClientY: event.clientY,
      previousCursor: canvas.style.cursor || ""
    };

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture can fail if the pointer has already left the canvas.
    }

    canvas.addEventListener("pointermove", this._boundVerticalPanPointerMove, true);
    canvas.addEventListener("pointerup", this._boundVerticalPanPointerUp, true);
    canvas.addEventListener("pointercancel", this._boundVerticalPanPointerUp, true);
    canvas.style.cursor = "ns-resize";
    if (this.container) {
      this.container.classList.add("is-vertical-panning");
    }
  }

  handleVerticalPanPointerMove(event) {
    if (!this.verticalPanState || event.pointerId !== this.verticalPanState.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const deltaY = event.clientY - this.verticalPanState.lastClientY;
    this.verticalPanState.lastClientY = event.clientY;
    if (!Number.isFinite(deltaY) || deltaY === 0) {
      return;
    }

    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    const offset = screenUp.multiplyScalar(deltaY * this.verticalPanWorldUnitsPerPixel());
    this.camera.position.add(offset);
    this.controls.target.add(offset);
    this.controls.update();
  }

  handleVerticalPanPointerUp(event) {
    if (!this.verticalPanState || event.pointerId !== this.verticalPanState.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.endVerticalPan(event.pointerId);
  }

  endVerticalPan(pointerId = null) {
    if (!this.verticalPanState || !this.renderer || !this.renderer.domElement) {
      return;
    }

    const state = this.verticalPanState;
    const canvas = this.renderer.domElement;
    const captureId = pointerId ?? state.pointerId;
    try {
      canvas.releasePointerCapture(captureId);
    } catch (error) {
      // Pointer capture may already have been released by the browser.
    }

    canvas.removeEventListener("pointermove", this._boundVerticalPanPointerMove, true);
    canvas.removeEventListener("pointerup", this._boundVerticalPanPointerUp, true);
    canvas.removeEventListener("pointercancel", this._boundVerticalPanPointerUp, true);
    canvas.style.cursor = state.previousCursor;
    if (this.container) {
      this.container.classList.remove("is-vertical-panning");
    }
    this.verticalPanState = null;
  }

  verticalPanWorldUnitsPerPixel() {
    if (!this.camera || !this.controls || !this.viewport) {
      return 1;
    }
    const rect = this.viewport.getBoundingClientRect();
    const height = Math.max(1, rect.height || this.renderer.domElement.clientHeight || 1);
    const distance = this.camera.position.distanceTo(this.controls.target);
    const fovRadians = (this.camera.fov || 46) * DEG_TO_RAD;
    return (2 * distance * Math.tan(fovRadians / 2)) / height;
  }

  reveal3D() {
    this.host.hidden = false;
    this.container.classList.add("is-3d-active");
    if (this.fallbackStatus) {
      this.fallbackStatus.hidden = true;
      this.fallbackStatus.textContent = "";
    }
    this.updateStatus("Loading 3D arm...", "warning");
  }

  async startMeshLoading() {
    const results = await this.loadMeshes();
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => (result.reason && result.reason.message ? result.reason.message : String(result.reason)));
    const loaded = results.length - failures.length;
    this.meshErrors = failures;
    registry.meshErrors = failures;
    if (this.host) {
      this.host.dataset.meshErrorCount = String(failures.length);
      this.host.dataset.meshErrors = failures.join("\n");
    }
    this.applyPose();

    if (failures.length === 0) {
      this.updateStatus("3D arm ready", "ready");
      return;
    }

    if (loaded > 0) {
      this.updateStatus(`3D loaded with ${failures.length} mesh issue${failures.length === 1 ? "" : "s"}`, "warning");
      console.warn("RoboBuddy 3D preview mesh load issues:", failures);
      return;
    }

    this.updateStatus("3D meshes unavailable", "error");
    console.error("RoboBuddy 3D preview could not load meshes:", failures);
  }

  async loadMeshes() {
    const tasks = this.config.attachments.map((attachment) => {
      const parent = this.groups[attachment.parent];
      if (!parent) {
        return Promise.reject(new Error(`Missing parent group "${attachment.parent}" for part "${attachment.part}".`));
      }
      return this.loadPart(attachment.part, parent);
    });

    const linkageParts = (this.config.gripperLinkage && this.config.gripperLinkage.parts) || [];
    linkageParts.forEach((part) => {
      tasks.push(this.loadLinkagePart(part));
    });

    return Promise.allSettled(tasks);
  }

  async loadLinkagePart(part) {
    const group = this.groups[part.group];
    if (!group) {
      throw new Error(`Missing linkage group "${part.group}" for part "${part.key}".`);
    }
    const geometry = await this.createGeometry(part);
    const mesh = this.makeMesh(part.key, {
      ...part,
      position: [0, part.holePlaneY ?? 0, 0]
    }, geometry);
    this.meshes[part.key] = mesh;
    group.add(mesh);
    this.addToCategory(part.category, mesh);
  }

  async loadPart(partKey, parent) {
    const part = this.config.parts[partKey];
    const geometry = await this.createGeometry(part);
    const mesh = this.makeMesh(partKey, part, geometry);
    this.meshes[partKey] = mesh;
    parent.add(mesh);
    this.addToCategory(part.category, mesh);
  }

  async createGeometry(part) {
    const meshKey = part.meshKey;
    const meshData = meshKey && ARM_PREVIEW_MESH_DATA.meshes
      ? ARM_PREVIEW_MESH_DATA.meshes[meshKey]
      : null;
    if (!meshData) {
      throw new Error(`Missing generated mesh data for "${meshKey || "unknown"}".`);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.decodePositions(meshData), 3));
    return geometry;
  }

  makeMesh(partKey, part, geometry) {
    const anchorPoint = this.resolveAnchorPoint(geometry, part);
    this.normalizeGeometry(geometry, anchorPoint);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this.materials[part.material] || this.materials.fallback);
    mesh.name = partKey;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.fromArray(part.position);
    mesh.rotation.set(
      (part.rotation[0] ?? 0) * DEG_TO_RAD,
      (part.rotation[1] ?? 0) * DEG_TO_RAD,
      (part.rotation[2] ?? 0) * DEG_TO_RAD
    );
    return mesh;
  }

  resolveAnchorPoint(geometry, part) {
    geometry.computeBoundingBox();
    if (Array.isArray(part.anchorPoint)) {
      return new THREE.Vector3().fromArray(part.anchorPoint);
    }

    const box = geometry.boundingBox;
    const anchor = part.origin === "center" ? [0.5, 0.5, 0.5] : [0.5, 0, 0.5];
    return new THREE.Vector3(
      THREE.MathUtils.lerp(box.min.x, box.max.x, anchor[0]),
      THREE.MathUtils.lerp(box.min.y, box.max.y, anchor[1]),
      THREE.MathUtils.lerp(box.min.z, box.max.z, anchor[2])
    );
  }

  normalizeGeometry(geometry, anchorPoint) {
    geometry.translate(-anchorPoint.x, -anchorPoint.y, -anchorPoint.z);
  }

  addToCategory(category, object) {
    if (!this.categoryGroups.has(category)) {
      this.categoryGroups.set(category, []);
    }
    this.categoryGroups.get(category).push(object);
  }

  applyPose() {
    this.config.kinematicChain.forEach((joint) => {
      const group = this.groups[joint.id];
      if (!group) {
        return;
      }
      this.setRotationAroundAxis(group, joint.axis, this.jointVisualDegrees(joint));
    });

    this.applyGripperPose();
  }

  applyGripperPose() {
    const linkage = this.config.gripperLinkage;
    if (!linkage || !this.gripperState) {
      return;
    }
    const servo = linkage.servo;
    const value = this.clampServo(servo, this.angles[servo]);
    const [min, max] = this.jointLimits[servo];
    const openRatioRaw = linkage.lowerServoIsOpen
      ? (max - value) / (max - min)
      : (value - min) / (max - min);
    const openRatio = THREE.MathUtils.clamp(openRatioRaw, 0, 1);
    const anchor = linkage.baseAnchor;

    Object.entries(linkage.sides).forEach(([key, side]) => {
      const state = this.gripperState[key];
      const deltaDeg = side.crankDir * state.travelDeg * openRatio;
      const theta = (side.crankZeroDeg + deltaDeg) * DEG_TO_RAD;
      const h = this.crankPoint(side, theta);
      const l = this.solveFourBar(side, h) || state.l0;

      this.groups[side.crankGroup].rotation.set(0, -deltaDeg * DEG_TO_RAD, 0);

      const linkAngle = Math.atan2(l.z - side.linkAxle[1], l.x - side.linkAxle[0]);
      this.groups[side.linkGroup].rotation.set(0, -(linkAngle - state.linkAngle0), 0);

      const couplerAngle = Math.atan2(l.z - h.z, l.x - h.x);
      const coupler = this.groups[side.couplerGroup];
      coupler.position.set(h.x - anchor[0], -anchor[1], h.z - anchor[2]);
      coupler.rotation.set(0, -(couplerAngle - state.couplerAngle0), 0);
    });
  }

  crankPoint(side, theta) {
    return {
      x: side.crankAxle[0] + side.crankLen * Math.cos(theta),
      z: side.crankAxle[1] + side.crankLen * Math.sin(theta)
    };
  }

  solveFourBar(side, h) {
    const dx = h.x - side.linkAxle[0];
    const dz = h.z - side.linkAxle[1];
    const d = Math.hypot(dx, dz);
    const linkLen = side.linkLen;
    const couplerLen = side.couplerLen;
    if (d <= Math.abs(linkLen - couplerLen) + 0.05 || d >= linkLen + couplerLen - 0.05) {
      return null;
    }
    const a = (linkLen * linkLen - couplerLen * couplerLen + d * d) / (2 * d);
    const height = Math.sqrt(Math.max(0, linkLen * linkLen - a * a));
    const ux = dx / d;
    const uz = dz / d;
    return {
      x: side.linkAxle[0] + a * ux - side.branchSign * height * uz,
      z: side.linkAxle[1] + a * uz + side.branchSign * height * ux
    };
  }

  solvableCrankTravel(side) {
    const requested = this.config.gripperLinkage.crankTravelDeg ?? 90;
    let usable = 0;
    for (let t = 1; t <= requested; t += 1) {
      const theta = (side.crankZeroDeg + side.crankDir * t) * DEG_TO_RAD;
      if (!this.solveFourBar(side, this.crankPoint(side, theta))) {
        break;
      }
      usable = t;
    }
    return usable;
  }

  servoRawAngle(servo, logicalValue = this.angles[servo]) {
    const clamped = this.clampServo(servo, logicalValue);
    return this.config.firmware.reversed[servo] ? 180 - clamped : clamped;
  }

  servoRawHome(servo) {
    const home = this.config.firmware.home[servo] ?? 90;
    return this.config.firmware.reversed[servo] ? 180 - home : home;
  }

  jointVisualDegrees(joint) {
    const raw = this.servoRawAngle(joint.servo);
    const rawHome = this.servoRawHome(joint.servo);
    const visualSign = joint.visualSign ?? 1;
    const offsetDeg = joint.offsetDeg ?? 0;
    return visualSign * (raw - rawHome) + offsetDeg;
  }

  setRotationAroundAxis(group, axis, degrees) {
    if (!group || !Array.isArray(axis) || axis.length < 3) {
      return;
    }
    const vector = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
    group.quaternion.setFromAxisAngle(vector, degrees * DEG_TO_RAD);
  }

  clampServo(servo, value) {
    const limits = this.jointLimits[servo] || [0, 180];
    const fallback = this.config.firmware.home[servo] ?? 90;
    const safeAngle = Number.isFinite(value) ? value : fallback;
    return Math.min(limits[1], Math.max(limits[0], safeAngle));
  }

  resetCamera() {
    if (!this.camera || !this.controls) {
      return;
    }
    if (this.options.cameraPreset === "compact") {
      this.camera.position.set(360, 255, 660);
      this.controls.target.set(0, 215, 0);
    } else {
      this.camera.position.set(420, 330, 760);
      this.controls.target.set(0, 275, 0);
    }
    this.controls.update();
    this.resize();
  }

  resize() {
    if (!this.renderer || !this.viewport) {
      return;
    }
    const rect = this.viewport.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    this.animationFrame = window.requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  updateStatus(message, tone = "ready") {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.textContent = message;
    this.statusEl.dataset.tone = tone;
  }

  useFallback(error) {
    console.warn("RoboBuddy 3D preview unavailable; using 2D fallback.", error);
    registry.ready = false;
    registry.error = error && error.message ? error.message : String(error);

    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
    }
    if (this.host) {
      this.host.hidden = true;
    }
    if (this.container) {
      this.container.classList.remove("is-3d-active");
    }
    if (this.fallbackStatus) {
      this.fallbackStatus.hidden = false;
      this.fallbackStatus.textContent = "3D unavailable; using 2D fallback.";
    }
    if (typeof PreviousArmPreview === "function") {
      this.fallback = new PreviousArmPreview(this.svg, this.options);
    }
  }

  _sanitizeAngles(nextAngles) {
    const source = Array.isArray(nextAngles) ? nextAngles : DEFAULT_HOME;
    const sanitized = [];
    for (let index = 0; index < 6; index += 1) {
      sanitized.push(this.clampServo(index, Number(source[index])));
    }
    return sanitized;
  }

  decodePositions(meshData) {
    if (!meshData || typeof meshData.positions !== "string") {
      throw new Error("Generated mesh data is missing position data.");
    }
    const vertexCount = Number(meshData.vertexCount);
    const bounds = Array.isArray(meshData.bounds) ? meshData.bounds.map(Number) : [];
    if (!Number.isInteger(vertexCount) || vertexCount <= 0 || bounds.length !== 6) {
      throw new Error("Generated mesh data has invalid metadata.");
    }

    const binary = window.atob(meshData.positions);
    const valueCount = vertexCount * 3;
    if (binary.length !== valueCount * 2) {
      throw new Error("Generated mesh data has an invalid position buffer.");
    }

    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const view = new DataView(bytes.buffer);
    const positions = new Float32Array(valueCount);
    const quantization = Number(ARM_PREVIEW_MESH_DATA.quantization) || 65535;
    for (let index = 0; index < valueCount; index += 1) {
      const axis = index % 3;
      const min = bounds[axis];
      const max = bounds[axis + 3];
      const ratio = view.getUint16(index * 2, true) / quantization;
      positions[index] = min + (max - min) * ratio;
    }
    return positions;
  }
}

function setEulerDegrees(object, rotation) {
  object.rotation.set(
    (rotation[0] ?? 0) * DEG_TO_RAD,
    (rotation[1] ?? 0) * DEG_TO_RAD,
    (rotation[2] ?? 0) * DEG_TO_RAD
  );
}

NS.ArmPreview = ArmPreview3D;
registry.ArmPreview3D = ArmPreview3D;
registry.config = ARM_RIG_CONFIG;
