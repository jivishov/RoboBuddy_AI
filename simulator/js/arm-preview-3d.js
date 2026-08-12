import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ARM_PREVIEW_MESH_DATA } from "./arm-preview-mesh-data.js?v=20260611-meshdata";
import { ARM_RIG_CONFIG } from "./arm-rig-config.js?v=20260611-meshdata";
import { ROBOT_RIG_PREVIEW_CONFIGS } from "./robot-rig-configs.js?v=20260812-openarm-g1-solu-1";
import { G1_SIMULATION } from "./unitree-g1/index.js?v=20260811-unitree-g1-solu-1";

const NS = (window.RoboAdmin = window.RoboAdmin || {});
const DEG_TO_RAD = Math.PI / 180;
const DEFAULT_HOME = [90, 90, 90, 90, 90, 90];
const MAX_MOBILE_DELTA_SECONDS = 0.05;
const LEADER_LAYERS = Object.freeze(["input", "target", "measured"]);
const LEADER_HANDLE_MIN_DIAMETER_PX = 24;
const LEADER_HANDLE_EDGE_ON_DOT = 0.18;
const LEADER_FRAME_SAMPLE_LIMIT = 180;

const registry = (window.RoboBuddy3DPreview = window.RoboBuddy3DPreview || {});
registry.registered = true;

class ArmPreview3D {
  constructor(hostElement, options = {}) {
    this.hostElement = hostElement;
    this.options = options;
    this.config = ARM_RIG_CONFIG;
    this.jointLimits = Array.isArray(options.jointLimits) ? options.jointLimits : this.config.firmware.limits;
    this.angles = this._sanitizeAngles(options.initialAngles || this.config.firmware.home || DEFAULT_HOME);
    this.groups = {};
    this.meshes = {};
    this.meshErrors = [];
    this.categoryGroups = new Map();
    this.jointDefs = new Map();
    this.ready = false;
    this.unavailable = false;
    this.animationFrame = 0;
    this.resizeObserver = null;
    this.verticalPanState = null;
    this._boundResize = () => this.resize();
    this._boundResetCamera = () => this.resetCamera();
    this._boundRobotChange = () => this.syncRobotVisibility();
    this._boundVerticalPanPointerDown = (event) => this.handleVerticalPanPointerDown(event);
    this._boundVerticalPanPointerMove = (event) => this.handleVerticalPanPointerMove(event);
    this._boundVerticalPanPointerUp = (event) => this.handleVerticalPanPointerUp(event);

    try {
      this.container = hostElement.closest(".arm-preview-container") || hostElement;
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
      this.markUnavailable(error);
    }
  }

  setAngles(nextAngles) {
    if (!Array.isArray(nextAngles) || nextAngles.length < 6) {
      return;
    }
    this.angles = this._sanitizeAngles(nextAngles);
    if (this.ready) {
      this.applyPose();
    }
  }

  setAngle(index, value) {
    if (!Number.isInteger(index) || index < 0 || index > 5) {
      return;
    }
    const next = this.angles.slice();
    next[index] = value;
    this.setAngles(next);
  }

  getAngles() {
    return this.angles.slice();
  }

  setInteractive(enabled) {
    if (this.container) {
      this.container.classList.toggle("is-3d-disabled", !Boolean(enabled));
    }
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf7f8fa);
    this.scene.fog = new THREE.Fog(0xf7f8fa, 900, 1600);

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
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd7dce3, 1.55);
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

    const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.58);
    fillLight.position.set(-360, 220, -240);
    this.scene.add(fillLight);

    const grid = new THREE.GridHelper(520, 26, 0xc9d2de, 0xe4e8ee);
    grid.position.y = -0.5;
    this.scene.add(grid);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(290, 96),
      new THREE.MeshStandardMaterial({
        color: 0xf1f3f6,
        roughness: 0.9,
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
    window.addEventListener("robobuddy:active-robot-change", this._boundRobotChange);
    this.syncRobotVisibility();
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
    if (!this.shouldShowArduinoPreview()) {
      this.hide3D();
      return;
    }
    this.host.hidden = false;
    this.container.classList.add("is-3d-active");
    if (this.fallbackStatus) {
      this.fallbackStatus.hidden = true;
      this.fallbackStatus.textContent = "";
    }
    this.updateStatus("Loading 3D arm...", "warning");
  }

  hide3D() {
    if (this.host) {
      this.host.hidden = true;
    }
    if (this.container) {
      this.container.classList.remove("is-3d-active");
    }
    if (this.fallbackStatus) {
      this.fallbackStatus.hidden = true;
    }
  }

  syncRobotVisibility() {
    if (!this.host || !this.container) {
      return;
    }
    if (this.shouldShowArduinoPreview()) {
      this.reveal3D();
    } else {
      this.hide3D();
    }
  }

  shouldShowArduinoPreview() {
    const activeFromContainer = this.container && this.container.dataset
      ? this.container.dataset.activeRobotId
      : "";
    if (activeFromContainer) {
      return activeFromContainer === "arduino_arm";
    }
    const robotRegistry = NS.RobotRegistry;
    if (robotRegistry && typeof robotRegistry.getActive === "function") {
      const active = robotRegistry.getActive();
      return !active || active.id === "arduino_arm";
    }
    return true;
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
    if (this.options.cameraPreset === "inspection") {
      this.camera.position.set(140, 190, 320);
      this.controls.target.set(0, 215, 0);
    } else if (this.options.cameraPreset === "compact") {
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

  markUnavailable(error) {
    console.warn("RoboBuddy 3D preview unavailable.", error);
    this.unavailable = true;
    this.ready = false;
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
      this.container.classList.add("is-3d-unavailable");
    }
    if (this.fallbackStatus) {
      this.fallbackStatus.hidden = false;
      this.fallbackStatus.textContent = "3D preview unavailable.";
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

class RobotRigPreview3D {
  constructor(viewportElement, options = {}) {
    this.viewport = viewportElement;
    this.manifest = options.manifest || null;
    this.state = options.state || null;
    this.config = options.config || ROBOT_RIG_PREVIEW_CONFIGS[this.manifest ? this.manifest.id : ""];
    this.onStatus = typeof options.onStatus === "function" ? options.onStatus : null;
    this.onUnavailable = typeof options.onUnavailable === "function" ? options.onUnavailable : null;
    this.groups = {};
    this.jointDefs = [];
    this.meshes = [];
    this.gripperGroups = null;
    this.meshGripper = null;
    this.meshRigActive = false;
    this.rigGeometries = new Set();
    this.disposedGeometries = new Set();
    this.leaderLayerRoots = {};
    this.leaderLayerGroups = {};
    this.leaderLayerGrippers = {};
    this.leaderMaterials = {};
    this.leaderHandles = [];
    this.leaderHandleGeometry = null;
    this.leaderGripperHandleGeometry = null;
    this.leaderInteractionCallbacks = {};
    this.leaderCallbackRegistration = null;
    this.leaderInteraction = null;
    this.leaderHoverHandle = null;
    this.webglContextLost = false;
    this.leaderPoseState = {
      active: false,
      input: null,
      target: null,
      measured: null,
      visibility: { input: true, target: true, measured: true, handles: true }
    };
    this.leaderFrameSamplesMs = [];
    this.skipNextLeaderFrameTimingSample = false;
    this.debugResourceStats = {
      geometryDisposeCalls: 0,
      materialDisposeCalls: 0,
      listenerCount: 0,
      rejectedPoseSnapshots: 0
    };
    this.visualMobilePose = this.cloneMobilePose(this.state && this.state.mobileBase);
    this.activeMobileMotion = null;
    this.visualHumanoidState = {
      root: G1_SIMULATION.state.createHumanoidRoot(this.state && this.state.humanoidRoot),
      joints: { ...((this.state && this.state.joints) || {}) }
    };
    this.activeHumanoidMotion = null;
    this.humanoidMotionPaused = false;
    this.humanoidMotionEvents = new Set();
    this.g1ToolFrames = new Map();
    this.g1TaskObjects = null;
    if (this.manifest && this.manifest.id === "unitree_g1_29dof") {
      G1_SIMULATION.ensureG1Styles();
    }
    this.lastFrameSeconds = 0;
    this.wheelSpinById = {};
    this.wheelControllers = [];
    this.status = {
      text: this.config && this.config.meshData
        ? `${this.config.title || "Robot"} loading official assembly...`
        : `${this.config && this.config.title ? this.config.title : "Robot"} 3D ready`,
      tone: this.config && this.config.meshData ? "loading" : "ready"
    };
    this.animationFrame = 0;
    this.resizeObserver = null;
    this.disposed = false;
    this._boundResize = () => this.resize();
    this._boundLeaderPointerDown = (event) => this.handleLeaderPointerDown(event);
    this._boundLeaderPointerMove = (event) => this.handleLeaderPointerMove(event);
    this._boundLeaderPointerUp = (event) => this.handleLeaderPointerUp(event);
    this._boundLeaderPointerCancel = (event) => this.handleLeaderPointerCancel(event);
    this._boundLeaderLostPointerCapture = (event) => this.handleLeaderLostPointerCapture(event);
    this._boundLeaderWindowBlur = () => this.cancelLeaderInteraction("blur");
    this._boundWebglContextLost = (event) => this.handleWebglContextLost(event);
    this._boundWebglContextRestored = () => this.handleWebglContextRestored();

    if (!this.viewport || !this.config) {
      throw new Error("Robot 3D preview requires a viewport and a robot rig config.");
    }

    this.initScene();
    this.resetCamera();
    this.resize();
    this.updateState(this.state);
    this.emitStatus();
    this.bindLeaderInteraction();
    if (!registry.robotRigInstances) {
      registry.robotRigInstances = new Set();
    }
    registry.robotRigInstances.add(this);
    registry.lastRobotRigInstance = this;
    void this.loadOfficialMeshRig();
    this.animate();
  }

  emitStatus() {
    if (this.onStatus) {
      this.onStatus({ ...this.status });
    }
  }

  setStatus(text, tone = "ready") {
    this.status = { text, tone };
    this.emitStatus();
  }

  getStatus() {
    return { ...this.status };
  }

  setCameraMovementEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.controls) {
      this.controls.enableRotate = next;
      this.controls.enablePan = next;
    }
    return next;
  }
  setCameraZoomEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.controls) {
      this.controls.enableZoom = next;
    }
    return next;
  }

  getCameraControlState() {
    return {
      movement: Boolean(this.controls && this.controls.enableRotate && this.controls.enablePan),
      zoom: Boolean(this.controls && this.controls.enableZoom)
    };
  }

  initScene() {
    const sceneConfig = this.config.scene || {};
    const background = Number.isFinite(Number(sceneConfig.background)) ? Number(sceneConfig.background) : 0xf7f8fa;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.scene.fog = new THREE.Fog(
      background,
      Number(sceneConfig.fogNear) || 760,
      Number(sceneConfig.fogFar) || 1600
    );

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, Number(sceneConfig.cameraFar) || 2400);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.viewport.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.materials = this.createMaterials();
    this.installSceneLights();

    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.viewport);
    }
    window.addEventListener("resize", this._boundResize);
  }

  createMaterials() {
    const materials = {};
    Object.entries(this.config.materials || {}).forEach(([key, options]) => {
      materials[key] = new THREE.MeshStandardMaterial({
        color: options.color,
        roughness: options.roughness,
        metalness: options.metalness
      });
    });
    materials.fallback = new THREE.MeshStandardMaterial({
      color: 0xff6b6b,
      roughness: 0.55,
      metalness: 0.02
    });
    return materials;
  }

  createLeaderMaterials() {
    if (this.leaderMaterials.input && this.leaderMaterials.target && this.leaderMaterials.handle) {
      return this.leaderMaterials;
    }
    this.leaderMaterials.input = new THREE.MeshBasicMaterial({
      color: 0xe8edf5,
      transparent: true,
      opacity: 0.24,
      wireframe: true,
      depthWrite: false,
      toneMapped: false
    });
    this.leaderMaterials.input.userData.layerSemantics = "stippled-translucent-input";
    this.leaderMaterials.input.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <alphatest_fragment>",
        "#include <alphatest_fragment>\nif (mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 4.0) > 0.5) discard;"
      );
    };
    this.leaderMaterials.input.customProgramCacheKey = () => "robobuddy-leader-input-stipple-v1";
    this.leaderMaterials.target = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.52,
      wireframe: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false
    });
    this.leaderMaterials.target.userData.layerSemantics = "outlined-target";
    this.leaderMaterials.handle = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });
    this.leaderMaterials.handleHover = this.leaderMaterials.handle.clone();
    this.leaderMaterials.handleHover.opacity = 1;
    return this.leaderMaterials;
  }

  installSceneLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd7dce3, 1.55);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.35);
    keyLight.position.set(260, 420, 300);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1536, 1536);
    keyLight.shadow.camera.left = -420;
    keyLight.shadow.camera.right = 420;
    keyLight.shadow.camera.top = 520;
    keyLight.shadow.camera.bottom = -220;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.62);
    fillLight.position.set(-360, 230, -260);
    this.scene.add(fillLight);

    const grid = new THREE.GridHelper(620, 31, 0xc9d2de, 0xe4e8ee);
    grid.position.y = -0.5;
    this.scene.add(grid);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(330, 112),
      new THREE.MeshStandardMaterial({
        color: 0xf1f3f6,
        roughness: 0.9,
        metalness: 0
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  buildRig() {
    this.root = new THREE.Group();
    this.root.name = `${this.config.title || "robot"}-root`;
    this.scene.add(this.root);
    this.groups.root = this.root;

    (this.config.chain || []).forEach((joint) => {
      const parent = this.groups[joint.parent] || this.root;
      const group = new THREE.Group();
      group.name = joint.id;
      group.position.fromArray(joint.pivot || [0, 0, 0]);
      setEulerDegrees(group, joint.rotation || [0, 0, 0]);
      group.userData.baseQuaternion = group.quaternion.clone();
      group.userData.joint = joint;
      parent.add(group);
      this.groups[joint.id] = group;
      this.jointDefs.push(joint);
    });

    this.bindMobileWheels();
  }

  async loadOfficialMeshRig() {
    const meshConfig = this.config.meshData;
    if (!meshConfig || !meshConfig.module) {
      const error = new Error("Robot 3D preview requires official mesh data.");
      this.setStatus("3D preview unavailable.", "error");
      if (this.onUnavailable && !this.disposed) {
        this.onUnavailable(error);
      }
      return;
    }

    this.setStatus(`${this.manifestShortName()} loading official STL assembly...`, "loading");

    try {
      const version = meshConfig.version ? `?v=${encodeURIComponent(meshConfig.version)}` : "";
      const module = await import(`${meshConfig.module}${version}`);
      const meshData = module.ROBOT_RIG_MESH_DATA || module.default;
      if (this.disposed) {
        return;
      }
      this.validateMeshData(meshData);
      const rig = this.createOfficialMeshRig(meshData);
      this.replaceRig(rig);
      this.meshRigActive = true;
      this.updateState(this.state);
      this.setStatus(`${this.manifestShortName()} official STL assembly ready`, "ready");
    } catch (error) {
      console.warn("Official robot mesh assembly failed.", error);
      this.cancelLeaderInteraction("mesh-load-failed");
      this.hideLeaderRigArtifacts();
      if (this.root) {
        this.root.visible = true;
      }
      this.meshRigActive = false;
      this.setStatus("3D preview unavailable.", "error");
      if (this.onUnavailable && !this.disposed) {
        this.onUnavailable(error);
      }
    }
  }

  validateMeshData(meshData) {
    if (!meshData || typeof meshData !== "object") {
      throw new Error("Mesh data module did not export ROBOT_RIG_MESH_DATA.");
    }
    if (meshData.robotId && this.manifest && meshData.robotId !== this.manifest.id) {
      throw new Error(`Mesh data robotId ${meshData.robotId} does not match ${this.manifest.id}.`);
    }
    if (!Array.isArray(meshData.chain) || meshData.chain.length === 0) {
      throw new Error("Mesh data is missing a joint chain.");
    }
    if (!Array.isArray(meshData.parts) || meshData.parts.length === 0) {
      throw new Error("Mesh data is missing visual parts.");
    }
    if (!meshData.meshes || typeof meshData.meshes !== "object") {
      throw new Error("Mesh data is missing decoded mesh payloads.");
    }
  }

  createOfficialMeshRig(meshData) {
    const root = new THREE.Group();
    root.name = `${meshData.robotId || this.config.title || "robot"}-official-root`;
    const groundOffsetMm = Number(meshData.groundOffsetMm) || 0;
    root.position.y = groundOffsetMm;
    root.userData.groundOffsetMm = groundOffsetMm;

    const groups = { root };
    const jointDefs = [];
    const meshes = [];
    const geometryCache = new Map();

    (meshData.chain || []).forEach((joint) => {
      const parent = groups[joint.parent] || root;
      const group = new THREE.Group();
      group.name = joint.id;
      group.position.fromArray(this.vectorFrom(joint.pivotMm || joint.pivot, [0, 0, 0]));
      this.applyBaseRotation(group, joint);
      group.userData.baseQuaternion = group.quaternion.clone();
      group.userData.joint = joint;
      parent.add(group);
      groups[joint.id] = group;
      jointDefs.push(joint);
    });

    (meshData.parts || []).forEach((part) => {
      const meshPayload = meshData.meshes[part.meshKey];
      if (!meshPayload) {
        throw new Error(`Mesh payload not found for ${part.meshKey}.`);
      }
      const geometry = this.getOfficialGeometry(meshData, part.meshKey, meshPayload, geometryCache);
      const material = this.materialForOfficialPart(meshData, part);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = part.key || part.meshKey;
      mesh.position.fromArray(this.vectorFrom(part.posMm, [0, 0, 0]));
      if (Array.isArray(part.quat) && part.quat.length === 4) {
        mesh.quaternion.fromArray(part.quat.map(Number)).normalize();
      }
      if (Array.isArray(part.scale3) && part.scale3.length === 3) {
        mesh.scale.fromArray(part.scale3.map((value) => Number(value) || 1));
      } else {
        const scale = Number(part.scale);
        mesh.scale.setScalar(Number.isFinite(scale) && scale > 0 ? scale : 1);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const parent = groups[part.group] || root;
      parent.add(mesh);
      meshes.push(mesh);
    });

    const gripper = this.createOfficialGripper(meshData, groups);
    return { root, groups, jointDefs, meshes, gripper, geometries: new Set(geometryCache.values()) };
  }

  replaceRig(rig) {
    this.cancelLeaderInteraction("rig-replaced");
    this.clearLeaderRigArtifacts();
    if (this.root) {
      this.scene.remove(this.root);
      this.disposeGeometries(this.rigGeometries);
    }
    this.root = rig.root;
    this.groups = rig.groups;
    this.jointDefs = rig.jointDefs;
    this.meshes = rig.meshes;
    this.gripperGroups = null;
    this.meshGripper = rig.gripper;
    this.rigGeometries = rig.geometries || new Set();
    this.scene.add(this.root);
    this.bindMobileWheels();
    this.setupG1Scene();
    if (this.leaderPoseState.active) {
      this.ensureLeaderRigArtifacts();
      this.applyLeaderPoseLayers();
    }
  }

  createOfficialGripper(meshData, groups) {
    const gripper = meshData.gripper;
    if (!gripper || !gripper.node) {
      return null;
    }
    const group = groups[gripper.node];
    if (!group) {
      return null;
    }
    const joint = group.userData.joint || null;
    return { group, definition: gripper, joint };
  }

  applyBaseRotation(group, joint) {
    if (Array.isArray(joint.baseQuat) && joint.baseQuat.length === 4) {
      group.quaternion.fromArray(joint.baseQuat.map(Number)).normalize();
      return;
    }
    setEulerDegrees(group, joint.rotation || [0, 0, 0]);
  }

  materialForOfficialPart(meshData, part) {
    const key = part.material || "fallback";
    if (!this.materials[key]) {
      const options = meshData.materials && meshData.materials[key] ? meshData.materials[key] : {};
      this.materials[key] = this.createStandardMaterial(options);
    }
    return this.materials[key] || this.materials.fallback;
  }

  createStandardMaterial(options = {}) {
    const color = Number(options.color);
    const roughness = Number(options.roughness);
    const metalness = Number(options.metalness);
    return new THREE.MeshStandardMaterial({
      color: Number.isFinite(color) ? color : 0xff6b6b,
      roughness: Number.isFinite(roughness) ? roughness : 0.62,
      metalness: Number.isFinite(metalness) ? metalness : 0.04,
      side: options.doubleSided ? THREE.DoubleSide : THREE.FrontSide
    });
  }

  getOfficialGeometry(meshData, meshKey, meshPayload, geometryCache) {
    if (geometryCache.has(meshKey)) {
      return geometryCache.get(meshKey);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.decodeOfficialPositions(meshData, meshPayload), 3)
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometryCache.set(meshKey, geometry);
    return geometry;
  }

  decodeOfficialPositions(meshData, meshPayload) {
    if (!meshPayload || typeof meshPayload.positions !== "string") {
      throw new Error("Mesh payload is missing quantized positions.");
    }
    const vertexCount = Number(meshPayload.vertexCount);
    const bounds = Array.isArray(meshPayload.bounds) ? meshPayload.bounds.map(Number) : [];
    if (!Number.isFinite(vertexCount) || vertexCount <= 0 || bounds.length !== 6) {
      throw new Error("Mesh payload has invalid vertex metadata.");
    }

    const valueCount = vertexCount * 3;
    const binary = window.atob(meshPayload.positions);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (bytes.length < valueCount * 2) {
      throw new Error("Mesh payload is shorter than expected.");
    }

    const view = new DataView(bytes.buffer);
    const positions = new Float32Array(valueCount);
    const quantization = Number(meshData.quantization) || 65535;
    for (let index = 0; index < valueCount; index += 1) {
      const axis = index % 3;
      const min = bounds[axis];
      const max = bounds[axis + 3];
      const ratio = view.getUint16(index * 2, true) / quantization;
      positions[index] = min + (max - min) * ratio;
    }
    return positions;
  }

  vectorFrom(value, fallback) {
    if (!Array.isArray(value) || value.length < 3) {
      return fallback.slice();
    }
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }

  disposeGeometries(geometries) {
    (geometries || []).forEach((geometry) => {
      if (!geometry || this.disposedGeometries.has(geometry)) {
        return;
      }
      this.disposedGeometries.add(geometry);
      this.debugResourceStats.geometryDisposeCalls += 1;
      geometry.dispose();
    });
  }

  setLeaderPoseLayers(next = {}) {
    const wasActive = this.leaderPoseState.active;
    const active = Object.prototype.hasOwnProperty.call(next, "active") ? Boolean(next.active) : true;
    const visibility = next.visibility && typeof next.visibility === "object" ? next.visibility : {};
    this.leaderPoseState.active = active;
    LEADER_LAYERS.forEach((layer) => {
      if (Object.prototype.hasOwnProperty.call(next, layer)) {
        const snapshot = this.normalizeLeaderPose(next[layer]);
        if (snapshot) {
          this.leaderPoseState[layer] = snapshot;
        } else {
          this.debugResourceStats.rejectedPoseSnapshots += 1;
        }
      }
      if (Object.prototype.hasOwnProperty.call(visibility, layer)) {
        this.leaderPoseState.visibility[layer] = Boolean(visibility[layer]);
      }
    });
    if (Object.prototype.hasOwnProperty.call(next, "handlesVisible")) {
      this.leaderPoseState.visibility.handles = Boolean(next.handlesVisible);
    }
    if (Object.prototype.hasOwnProperty.call(visibility, "handles")) {
      this.leaderPoseState.visibility.handles = Boolean(visibility.handles);
    }

    if (!active) {
      this.cancelLeaderInteraction("leader-mode-exit");
      this.hideLeaderRigArtifacts();
      if (this.root) {
        this.root.visible = true;
      }
      this.applyJointPose();
      this.applyGripperPose();
      return this.getLeaderDebugSnapshot();
    }

    if (!wasActive) {
      this.leaderFrameSamplesMs.length = 0;
    }

    this.ensureLeaderRigArtifacts();
    this.applyLeaderPoseLayers();
    return this.getLeaderDebugSnapshot();
  }

  setLeaderLayerVisibility(layer, visible) {
    if (![...LEADER_LAYERS, "handles"].includes(layer)) {
      return false;
    }
    this.leaderPoseState.visibility[layer] = Boolean(visible);
    this.applyLeaderPoseLayers();
    return true;
  }

  setLeaderInteractionCallbacks(callbacks = {}) {
    callbacks = callbacks && typeof callbacks === "object" ? callbacks : {};
    const registration = {
      onJointDragStart: typeof callbacks.onJointDragStart === "function" ? callbacks.onJointDragStart : null,
      onJointDrag: typeof callbacks.onJointDrag === "function" ? callbacks.onJointDrag : null,
      onJointDragEnd: typeof callbacks.onJointDragEnd === "function" ? callbacks.onJointDragEnd : null,
      onJointDragCancel: typeof callbacks.onJointDragCancel === "function" ? callbacks.onJointDragCancel : null,
      onHandleUnavailable: typeof callbacks.onHandleUnavailable === "function" ? callbacks.onHandleUnavailable : null
    };
    this.leaderCallbackRegistration = registration;
    this.leaderInteractionCallbacks = registration;
    return () => {
      if (this.leaderCallbackRegistration !== registration) {
        return;
      }
      this.cancelLeaderInteraction("callbacks-cleared");
      this.leaderCallbackRegistration = null;
      this.leaderInteractionCallbacks = {};
    };
  }

  normalizeLeaderPose(pose) {
    const source = pose && typeof pose === "object" && pose.joints && typeof pose.joints === "object"
      ? pose.joints
      : (pose && typeof pose === "object" ? pose : {});
    const joints = {};
    const definitions = this.manifest && Array.isArray(this.manifest.joints) ? this.manifest.joints : [];
    if (definitions.length === 0) {
      return null;
    }
    for (const joint of definitions) {
      if (!Object.prototype.hasOwnProperty.call(source, joint.id)) {
        return null;
      }
      const value = Number(source[joint.id]);
      if (!Number.isFinite(value)) {
        return null;
      }
      joints[joint.id] = value;
    }
    return { joints };
  }

  ensureLeaderRigArtifacts() {
    if (!this.root || !this.meshRigActive || this.disposed) {
      return false;
    }
    this.createLeaderMaterials();
    ["input", "target"].forEach((layer) => {
      if (this.leaderLayerRoots[layer]) {
        return;
      }
      const clone = this.cloneLeaderLayerRoot(layer);
      this.leaderLayerRoots[layer] = clone.root;
      this.leaderLayerGroups[layer] = clone.groups;
      this.leaderLayerGrippers[layer] = clone.gripper;
      this.scene.add(clone.root);
    });
    if (!this.leaderHandleRoot) {
      this.createLeaderHandleRig();
    }
    return true;
  }

  cloneLeaderLayerRoot(layer) {
    const root = this.root.clone(true);
    root.name = `${this.root.name}-${layer}-layer`;
    const groups = {};
    root.traverse((object) => {
      if (object.isGroup && object.name) {
        groups[object.name] = object;
      }
      if (object.isMesh) {
        object.material = this.leaderMaterials[layer];
        object.castShadow = false;
        object.receiveShadow = false;
        object.renderOrder = layer === "input" ? 1 : 2;
      }
    });
    this.jointDefs.forEach((joint) => {
      const source = this.groups[joint.id];
      const group = groups[joint.id];
      if (source && group && source.userData.baseQuaternion) {
        group.userData.baseQuaternion = source.userData.baseQuaternion.clone();
        group.userData.joint = joint;
      }
    });
    const gripper = this.meshGripper && this.meshGripper.definition
      ? {
          group: groups[this.meshGripper.definition.node] || null,
          definition: this.meshGripper.definition,
          joint: this.meshGripper.joint
        }
      : null;
    return { root, groups, gripper };
  }

  createLeaderHandleRig() {
    const root = new THREE.Group();
    root.name = `${this.root.name}-leader-handles`;
    root.position.copy(this.root.position);
    root.quaternion.copy(this.root.quaternion);
    root.scale.copy(this.root.scale);
    root.userData.groundOffsetMm = this.root.userData.groundOffsetMm;
    const groups = { root };

    this.jointDefs.forEach((joint) => {
      const source = this.groups[joint.id];
      const parent = groups[joint.parent] || root;
      if (!source) {
        return;
      }
      const group = new THREE.Group();
      group.name = joint.id;
      group.position.copy(source.position);
      group.quaternion.copy(source.userData.baseQuaternion || source.quaternion);
      group.userData.baseQuaternion = group.quaternion.clone();
      group.userData.joint = joint;
      parent.add(group);
      groups[joint.id] = group;
    });

    this.leaderHandleRoot = root;
    this.leaderHandleGroups = groups;
    this.scene.add(root);
    this.buildLeaderHandles();
  }

  buildLeaderHandles() {
    if (!this.leaderHandleRoot) {
      return;
    }
    this.leaderHandles = [];
    this.leaderHandleGeometry = new THREE.TorusGeometry(20, 2.4, 8, 48);
    this.leaderGripperHandleGeometry = new THREE.TorusGeometry(15, 2.8, 8, 40);
    const zAxis = new THREE.Vector3(0, 0, 1);

    this.jointDefs.filter((joint) => joint.jointId && joint.sign !== 0).forEach((joint) => {
      const group = this.leaderHandleGroups[joint.id];
      if (!group) {
        return;
      }
      const axis = new THREE.Vector3().fromArray(joint.axis || [0, 1, 0]);
      if (axis.lengthSq() <= 0.000001) {
        return;
      }
      axis.normalize();
      const sign = Number(joint.sign) || 1;
      this.addLeaderHandle(group, this.leaderHandleGeometry, axis, {
        jointId: joint.jointId,
        label: joint.label || joint.jointId,
        radius: 20,
        semanticPerVisualDegree: 1 / sign
      }, zAxis);
    });

    if (this.meshGripper && this.meshGripper.definition) {
      const definition = this.meshGripper.definition;
      const group = this.leaderHandleGroups[definition.node];
      const joint = this.meshGripper.joint || (group && group.userData.joint);
      const axis = new THREE.Vector3().fromArray((joint && joint.axis) || [0, 1, 0]);
      const open = Number(definition.openValue);
      const close = Number(definition.closeValue);
      const openDeg = Number(definition.openDeg);
      const closedDeg = Number(definition.closedDeg);
      const angularPerSemantic = (Number(definition.sign) || 1) * (openDeg - closedDeg) * -1 / Math.max(1, Math.abs(close - open));
      if (group && axis.lengthSq() > 0.000001 && Number.isFinite(angularPerSemantic) && Math.abs(angularPerSemantic) > 0.000001) {
        axis.normalize();
        this.addLeaderHandle(group, this.leaderGripperHandleGeometry, axis, {
          jointId: definition.jointId,
          label: "Gripper",
          radius: 15,
          semanticPerVisualDegree: 1 / angularPerSemantic
        }, zAxis);
      }
    }
  }

  addLeaderHandle(group, geometry, axis, metadata, zAxis) {
    const handle = new THREE.Mesh(geometry, this.leaderMaterials.handle);
    handle.name = `leader-handle-${metadata.jointId}`;
    handle.quaternion.setFromUnitVectors(zAxis, axis);
    handle.renderOrder = 10;
    handle.userData.leaderHandle = true;
    handle.userData.jointId = metadata.jointId;
    handle.userData.label = metadata.label;
    handle.userData.axisLocal = axis.clone();
    handle.userData.radius = metadata.radius;
    handle.userData.semanticPerVisualDegree = metadata.semanticPerVisualDegree;
    group.add(handle);
    this.leaderHandles.push(handle);
  }

  clearLeaderRigArtifacts() {
    ["input", "target"].forEach((layer) => {
      const root = this.leaderLayerRoots[layer];
      if (root && root.parent) {
        root.parent.remove(root);
      }
    });
    if (this.leaderHandleRoot && this.leaderHandleRoot.parent) {
      this.leaderHandleRoot.parent.remove(this.leaderHandleRoot);
    }
    this.disposeGeometries([this.leaderHandleGeometry, this.leaderGripperHandleGeometry]);
    this.leaderLayerRoots = {};
    this.leaderLayerGroups = {};
    this.leaderLayerGrippers = {};
    this.leaderHandleRoot = null;
    this.leaderHandleGroups = {};
    this.leaderHandles = [];
    this.leaderHandleGeometry = null;
    this.leaderGripperHandleGeometry = null;
    this.refreshLeaderHandleClasses();
  }

  hideLeaderRigArtifacts() {
    ["input", "target"].forEach((layer) => {
      if (this.leaderLayerRoots[layer]) {
        this.leaderLayerRoots[layer].visible = false;
      }
    });
    if (this.leaderHandleRoot) {
      this.leaderHandleRoot.visible = false;
    }
    this.refreshLeaderHandleClasses();
  }

  applyLeaderPoseLayers() {
    if (!this.leaderPoseState.active) {
      return;
    }
    if (!this.ensureLeaderRigArtifacts()) {
      return;
    }
    const fallback = this.normalizeLeaderPose(this.state && this.state.joints ? this.state.joints : {});
    if (!fallback) {
      return;
    }
    const poses = {
      input: this.leaderPoseState.input || fallback,
      target: this.leaderPoseState.target || this.leaderPoseState.input || fallback,
      measured: this.leaderPoseState.measured || fallback
    };

    ["input", "target"].forEach((layer) => {
      const root = this.leaderLayerRoots[layer];
      if (!root) {
        return;
      }
      root.position.copy(this.root.position);
      root.quaternion.copy(this.root.quaternion);
      root.scale.copy(this.root.scale);
      root.visible = Boolean(this.leaderPoseState.visibility[layer]);
      this.applyJointPoseTo(this.leaderLayerGroups[layer], poses[layer]);
      this.applyOfficialGripperPoseTo(this.leaderLayerGrippers[layer], poses[layer]);
    });

    this.root.visible = Boolean(this.leaderPoseState.visibility.measured);
    this.applyJointPoseTo(this.groups, poses.measured);
    this.applyOfficialGripperPoseTo(this.meshGripper, poses.measured);
    if (this.leaderHandleRoot) {
      this.leaderHandleRoot.position.copy(this.root.position);
      this.leaderHandleRoot.quaternion.copy(this.root.quaternion);
      this.leaderHandleRoot.scale.copy(this.root.scale);
      this.leaderHandleRoot.visible = Boolean(this.leaderPoseState.visibility.handles);
      this.applyJointPoseTo(this.leaderHandleGroups, poses.target);
      const handleGripper = this.meshGripper && this.meshGripper.definition
        ? {
            group: this.leaderHandleGroups[this.meshGripper.definition.node],
            definition: this.meshGripper.definition,
            joint: this.meshGripper.joint
          }
        : null;
      this.applyOfficialGripperPoseTo(handleGripper, poses.target);
    }
    this.refreshLeaderHandleClasses();
  }

  bindLeaderInteraction() {
    const canvas = this.renderer && this.renderer.domElement;
    if (!canvas) {
      return;
    }
    canvas.addEventListener("pointerdown", this._boundLeaderPointerDown, true);
    canvas.addEventListener("pointermove", this._boundLeaderPointerMove, true);
    canvas.addEventListener("pointerup", this._boundLeaderPointerUp, true);
    canvas.addEventListener("pointercancel", this._boundLeaderPointerCancel, true);
    canvas.addEventListener("lostpointercapture", this._boundLeaderLostPointerCapture, true);
    canvas.addEventListener("webglcontextlost", this._boundWebglContextLost, false);
    canvas.addEventListener("webglcontextrestored", this._boundWebglContextRestored, false);
    window.addEventListener("blur", this._boundLeaderWindowBlur);
    this.debugResourceStats.listenerCount += 8;
  }

  unbindLeaderInteraction() {
    const canvas = this.renderer && this.renderer.domElement;
    if (canvas) {
      canvas.removeEventListener("pointerdown", this._boundLeaderPointerDown, true);
      canvas.removeEventListener("pointermove", this._boundLeaderPointerMove, true);
      canvas.removeEventListener("pointerup", this._boundLeaderPointerUp, true);
      canvas.removeEventListener("pointercancel", this._boundLeaderPointerCancel, true);
      canvas.removeEventListener("lostpointercapture", this._boundLeaderLostPointerCapture, true);
      canvas.removeEventListener("webglcontextlost", this._boundWebglContextLost, false);
      canvas.removeEventListener("webglcontextrestored", this._boundWebglContextRestored, false);
    }
    window.removeEventListener("blur", this._boundLeaderWindowBlur);
    this.debugResourceStats.listenerCount = 0;
  }

  handleLeaderPointerDown(event) {
    if (
      event.button !== 0 ||
      !this.leaderPoseState.active ||
      !this.leaderPoseState.visibility.handles ||
      this.leaderInteraction ||
      this.leaderHandles.length === 0 ||
      this.webglContextLost ||
      (
        typeof this.leaderInteractionCallbacks.onJointDragStart !== "function" &&
        typeof this.leaderInteractionCallbacks.onJointDrag !== "function"
      )
    ) {
      return;
    }
    const handle = this.pickLeaderHandle(event);
    if (!handle) {
      return;
    }
    const metrics = this.getLeaderHandleMetrics(handle);
    if (!metrics.available) {
      this.invokeLeaderCallback("onHandleUnavailable", {
        jointId: handle.userData.jointId,
        label: handle.userData.label,
        reason: metrics.reason,
        projectedDiameterPx: metrics.projectedDiameterPx,
        guidance: "Use the linked pad or precision control for this joint."
      });
      return;
    }

    const startPayload = {
      jointId: handle.userData.jointId,
      label: handle.userData.label,
      pointerId: event.pointerId,
      projectedDiameterPx: metrics.projectedDiameterPx
    };
    if (this.invokeLeaderCallback("onJointDragStart", startPayload, { failClosed: true }) !== true) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const canvas = this.renderer && this.renderer.domElement;
    try {
      if (!canvas || typeof canvas.setPointerCapture !== "function") {
        throw new Error("Pointer capture is unavailable.");
      }
      canvas.setPointerCapture(event.pointerId);
      if (typeof canvas.hasPointerCapture === "function" && !canvas.hasPointerCapture(event.pointerId)) {
        throw new Error("Pointer capture was not acquired.");
      }
    } catch (error) {
      this.invokeLeaderCallback("onJointDragCancel", {
        ...startPayload,
        totalDelta: 0,
        reason: "pointercapturefailed"
      });
      this.invokeLeaderCallback("onHandleUnavailable", {
        jointId: handle.userData.jointId,
        label: handle.userData.label,
        reason: "pointercapturefailed",
        projectedDiameterPx: metrics.projectedDiameterPx,
        guidance: "Use the linked pad or precision control for this joint."
      });
      return;
    }
    this.leaderInteraction = {
      handle,
      pointerId: event.pointerId,
      lastAngle: this.pointerScreenAngle(event, metrics.centerScreen),
      totalSemanticDelta: 0,
      controlsWereEnabled: Boolean(this.controls && this.controls.enabled),
      axisFacingSign: metrics.axisFacingSign
    };
    if (this.controls) {
      this.controls.enabled = false;
    }
    this.setLeaderHoverHandle(handle);
    this.refreshLeaderHandleClasses();
  }

  handleLeaderPointerMove(event) {
    const interaction = this.leaderInteraction;
    if (!interaction) {
      if (this.leaderPoseState.active && this.leaderPoseState.visibility.handles) {
        this.setLeaderHoverHandle(this.pickLeaderHandle(event));
      }
      return;
    }
    if (event.pointerId !== interaction.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const metrics = this.getLeaderHandleMetrics(interaction.handle);
    if (!metrics.available) {
      this.invokeLeaderCallback("onHandleUnavailable", {
        jointId: interaction.handle.userData.jointId,
        label: interaction.handle.userData.label,
        reason: metrics.reason,
        projectedDiameterPx: metrics.projectedDiameterPx,
        guidance: "Use the linked pad or precision control for this joint."
      });
      this.finishLeaderInteraction(true, "handleunavailable");
      return;
    }
    const nextAngle = this.pointerScreenAngle(event, metrics.centerScreen);
    const angleDelta = Math.atan2(
      Math.sin(nextAngle - interaction.lastAngle),
      Math.cos(nextAngle - interaction.lastAngle)
    );
    interaction.lastAngle = nextAngle;
    const visualDeltaDegrees = angleDelta / DEG_TO_RAD * interaction.axisFacingSign;
    const semanticDelta = visualDeltaDegrees * Number(interaction.handle.userData.semanticPerVisualDegree || 1);
    if (!Number.isFinite(semanticDelta) || Math.abs(semanticDelta) < 0.00001) {
      return;
    }
    interaction.totalSemanticDelta += semanticDelta;
    this.invokeLeaderCallback("onJointDrag", {
      jointId: interaction.handle.userData.jointId,
      label: interaction.handle.userData.label,
      pointerId: interaction.pointerId,
      delta: semanticDelta,
      totalDelta: interaction.totalSemanticDelta,
      projectedDiameterPx: metrics.projectedDiameterPx
    });
  }

  handleLeaderPointerUp(event) {
    if (!this.leaderInteraction || event.pointerId !== this.leaderInteraction.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finishLeaderInteraction(false, "pointerup");
  }

  handleLeaderPointerCancel(event) {
    if (!this.leaderInteraction || event.pointerId !== this.leaderInteraction.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finishLeaderInteraction(true, "pointercancel");
  }

  handleLeaderLostPointerCapture(event) {
    if (this.leaderInteraction && event.pointerId === this.leaderInteraction.pointerId) {
      this.finishLeaderInteraction(true, "lostpointercapture");
    }
  }

  handleWebglContextLost(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    this.webglContextLost = true;
    this.cancelLeaderInteraction("webglcontextlost");
    this.setStatus("3D context lost. Use the linked pad or precision controls.", "error");
    this.invokeLeaderCallback("onHandleUnavailable", {
      jointId: "",
      label: "3D controls",
      reason: "webglcontextlost",
      projectedDiameterPx: 0,
      guidance: "Use the linked pad or precision control while the preview recovers."
    });
  }

  handleWebglContextRestored() {
    this.webglContextLost = false;
    this.setStatus(`${this.config && this.config.title ? this.config.title : "Robot"} 3D restored`, "ready");
    if (this.leaderPoseState.active) {
      this.applyLeaderPoseLayers();
    }
  }

  cancelLeaderInteraction(reason = "cancelled") {
    if (!this.leaderInteraction) {
      this.setLeaderHoverHandle(null);
      return false;
    }
    this.finishLeaderInteraction(true, reason);
    return true;
  }

  finishLeaderInteraction(cancelled, reason) {
    const interaction = this.leaderInteraction;
    if (!interaction) {
      return;
    }
    this.leaderInteraction = null;
    if (this.controls) {
      this.controls.enabled = interaction.controlsWereEnabled;
    }
    const canvas = this.renderer && this.renderer.domElement;
    if (canvas) {
      try {
        if (canvas.hasPointerCapture(interaction.pointerId)) {
          canvas.releasePointerCapture(interaction.pointerId);
        }
      } catch (error) {
        // The browser may already have released capture.
      }
    }
    const payload = {
      jointId: interaction.handle.userData.jointId,
      label: interaction.handle.userData.label,
      pointerId: interaction.pointerId,
      totalDelta: interaction.totalSemanticDelta,
      reason
    };
    this.invokeLeaderCallback(cancelled ? "onJointDragCancel" : "onJointDragEnd", payload);
    this.setLeaderHoverHandle(null);
    this.refreshLeaderHandleClasses();
  }

  pickLeaderHandle(event) {
    if (!this.camera || !this.renderer || this.leaderHandles.length === 0) {
      return null;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    if (!this.leaderRaycaster) {
      this.leaderRaycaster = new THREE.Raycaster();
    }
    this.leaderRaycaster.setFromCamera(pointer, this.camera);
    const hits = this.leaderRaycaster.intersectObjects(this.leaderHandles.filter((handle) => handle.visible), false);
    return hits.length > 0 ? hits[0].object : null;
  }

  getLeaderHandleMetrics(handle) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const centerWorld = new THREE.Vector3();
    const worldQuaternion = new THREE.Quaternion();
    handle.getWorldPosition(centerWorld);
    handle.parent.getWorldQuaternion(worldQuaternion);
    const axisWorld = handle.userData.axisLocal.clone().applyQuaternion(worldQuaternion).normalize();
    const toCamera = this.camera.position.clone().sub(centerWorld).normalize();
    const facing = axisWorld.dot(toCamera);
    const axisFacingSign = facing >= 0 ? 1 : -1;
    const centerNdc = centerWorld.clone().project(this.camera);
    const tangent = new THREE.Vector3().crossVectors(axisWorld, toCamera);
    if (tangent.lengthSq() <= 0.000001) {
      tangent.set(1, 0, 0).applyQuaternion(worldQuaternion);
    }
    tangent.normalize().multiplyScalar(Number(handle.userData.radius) || 20);
    const edgeNdc = centerWorld.clone().add(tangent).project(this.camera);
    const centerScreen = {
      x: rect.left + (centerNdc.x + 1) * 0.5 * rect.width,
      y: rect.top + (1 - centerNdc.y) * 0.5 * rect.height
    };
    const edgeScreen = {
      x: rect.left + (edgeNdc.x + 1) * 0.5 * rect.width,
      y: rect.top + (1 - edgeNdc.y) * 0.5 * rect.height
    };
    const projectedDiameterPx = 2 * Math.hypot(edgeScreen.x - centerScreen.x, edgeScreen.y - centerScreen.y);
    const edgeOn = Math.abs(facing) < LEADER_HANDLE_EDGE_ON_DOT;
    const tooSmall = projectedDiameterPx < LEADER_HANDLE_MIN_DIAMETER_PX;
    return {
      available: !edgeOn && !tooSmall,
      reason: edgeOn ? "edge_on" : (tooSmall ? "projected_too_small" : "available"),
      axisFacingSign,
      centerScreen,
      projectedDiameterPx
    };
  }

  pointerScreenAngle(event, centerScreen) {
    return Math.atan2(-(event.clientY - centerScreen.y), event.clientX - centerScreen.x);
  }

  setLeaderHoverHandle(handle) {
    if (this.leaderHoverHandle === handle) {
      return;
    }
    if (this.leaderHoverHandle) {
      this.leaderHoverHandle.material = this.leaderMaterials.handle;
    }
    this.leaderHoverHandle = handle || null;
    if (this.leaderHoverHandle) {
      this.leaderHoverHandle.material = this.leaderMaterials.handleHover;
    }
    this.refreshLeaderHandleClasses();
  }

  refreshLeaderHandleClasses() {
    if (!this.viewport) {
      return;
    }
    const visible = Boolean(
      this.leaderPoseState.active &&
      this.leaderPoseState.visibility.handles &&
      this.leaderHandleRoot &&
      this.leaderHandleRoot.visible
    );
    this.viewport.classList.toggle("is-leader-handles-visible", visible);
    this.viewport.classList.toggle("is-leader-handle-hover", visible && Boolean(this.leaderHoverHandle));
    this.viewport.classList.toggle("is-leader-handle-dragging", visible && Boolean(this.leaderInteraction));
  }

  invokeLeaderCallback(name, payload, options = {}) {
    const callback = this.leaderInteractionCallbacks && this.leaderInteractionCallbacks[name];
    if (typeof callback !== "function") {
      return options.failClosed ? false : undefined;
    }
    try {
      const result = callback(payload);
      if (options.failClosed && result && typeof result.then === "function") {
        console.error(`Robot Leader interaction callback ${name} must complete synchronously.`);
        return false;
      }
      return result;
    } catch (error) {
      console.error(`Robot Leader interaction callback ${name} failed.`, error);
      return options.failClosed ? false : undefined;
    }
  }

  getLeaderDebugSnapshot() {
    const geometries = new Set();
    const materials = new Set();
    let objectCount = 0;
    const layerMeshCounts = { input: 0, target: 0, measured: 0 };
    let sharedGeometryViolations = 0;
    if (this.scene) {
      this.scene.traverse((object) => {
        objectCount += 1;
        if (object.geometry) {
          geometries.add(object.geometry);
        }
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.filter(Boolean).forEach((material) => materials.add(material));
      });
    }
    const sortedFrames = this.leaderFrameSamplesMs.slice().sort((a, b) => a - b);
    const p95Index = sortedFrames.length > 0 ? Math.min(sortedFrames.length - 1, Math.floor(sortedFrames.length * 0.95)) : -1;
    ["input", "target"].forEach((layer) => {
      const root = this.leaderLayerRoots[layer];
      if (!root) {
        return;
      }
      root.traverse((object) => {
        if (!object.isMesh) {
          return;
        }
        layerMeshCounts[layer] += 1;
        if (object.geometry && !this.rigGeometries.has(object.geometry)) {
          sharedGeometryViolations += 1;
        }
      });
    });
    if (this.root) {
      this.root.traverse((object) => {
        if (object.isMesh) {
          layerMeshCounts.measured += 1;
        }
      });
    }
    return {
      active: this.leaderPoseState.active,
      layers: {
        input: Boolean(this.leaderLayerRoots.input),
        target: Boolean(this.leaderLayerRoots.target),
        measured: Boolean(this.root)
      },
      visibility: { ...this.leaderPoseState.visibility },
      handles: this.leaderHandles.length,
      layerMeshCounts,
      sharedGeometryViolations,
      activeInteraction: this.leaderInteraction ? this.leaderInteraction.handle.userData.jointId : null,
      objectCount,
      uniqueGeometryCount: geometries.size,
      sharedRigGeometryCount: this.rigGeometries.size,
      uniqueMaterialCount: materials.size,
      listenerCount: this.debugResourceStats.listenerCount,
      geometryDisposeCalls: this.debugResourceStats.geometryDisposeCalls,
      materialDisposeCalls: this.debugResourceStats.materialDisposeCalls,
      frameSampleCount: sortedFrames.length,
      frameP95Ms: p95Index >= 0 ? sortedFrames[p95Index] : 0,
      disposed: this.disposed
    };
  }

  resetLeaderFrameTimingSamples() {
    this.leaderFrameSamplesMs.length = 0;
    this.skipNextLeaderFrameTimingSample = true;
    return this.getLeaderDebugSnapshot();
  }

  manifestShortName() {
    return (this.manifest && (this.manifest.shortName || this.manifest.name)) || this.config.title || "Robot";
  }

  updateState(nextState) {
    this.state = nextState || this.state || {};
    if (this.config.mobileBase && !this.activeMobileMotion) {
      this.visualMobilePose = this.cloneMobilePose(this.state.mobileBase);
    }
    this.applyMobilePose(this.visualMobilePose);
    if (this.config.humanoidRoot && !this.activeHumanoidMotion) {
      this.visualHumanoidState = {
        root: G1_SIMULATION.state.createHumanoidRoot(this.state.humanoidRoot),
        joints: { ...(this.state.joints || {}) }
      };
    }
    this.applyHumanoidPose(this.visualHumanoidState.root);
    if (this.leaderPoseState.active) {
      this.applyLeaderPoseLayers();
      return;
    }
    this.applyJointPose();
    this.applyGripperPose();
  }

  setupG1Scene() {
    if (!this.config.humanoidRoot || !this.root) {
      return;
    }
    if (this.g1TaskObjects && this.g1TaskObjects.group) {
      this.scene.remove(this.g1TaskObjects.group);
    }
    this.g1ToolFrames = G1_SIMULATION.createToolFrames(THREE, this.groups, this.config.toolFrames || []);
    this.g1TaskObjects = G1_SIMULATION.createTaskObjects(THREE, this.config.taskObjects || []);
    this.scene.add(this.g1TaskObjects.group);
    this.applyHumanoidPose(this.visualHumanoidState.root);
  }

  applyHumanoidPose(pose = this.visualHumanoidState.root) {
    if (!this.root || !this.config.humanoidRoot) {
      return;
    }
    const rootPose = G1_SIMULATION.state.createHumanoidRoot(pose);
    const positionScale = Number(this.config.humanoidRoot.positionScale) || 1000;
    const yawSign = Number(this.config.humanoidRoot.yawSign) || 1;
    const groundY = Number(this.root.userData && this.root.userData.groundOffsetMm) || 0;
    this.root.position.set(rootPose.x * positionScale, groundY, -rootPose.z * positionScale);
    this.root.rotation.y = yawSign * rootPose.theta * DEG_TO_RAD;
  }

  startHumanoidMotion(action) {
    if (!this.config.humanoidRoot || !action) {
      return false;
    }
    this.humanoidMotionEvents.clear();
    this.humanoidMotionPaused = false;
    this.activeHumanoidMotion = {
      ...action,
      elapsedSeconds: 0
    };
    const sample = G1_SIMULATION.sampleG1Action(action, 0);
    if (sample) {
      this.visualHumanoidState = { root: sample.root, joints: sample.joints };
      this.applyHumanoidPose(sample.root);
      this.applyJointPoseTo(this.groups, { joints: sample.joints });
    }
    return true;
  }

  updateHumanoidAnimation(deltaSeconds) {
    const motion = this.activeHumanoidMotion;
    if (!motion || !this.config.humanoidRoot) {
      return;
    }
    if (this.humanoidMotionPaused) {
      return;
    }
    motion.elapsedSeconds = Math.min(motion.durationSeconds, motion.elapsedSeconds + Math.max(0, deltaSeconds));
    const progress = motion.durationSeconds > 0 ? motion.elapsedSeconds / motion.durationSeconds : 1;
    const sample = G1_SIMULATION.sampleG1Action(motion, progress);
    if (!sample) {
      this.activeHumanoidMotion = null;
      return;
    }
    this.visualHumanoidState = { root: sample.root, joints: sample.joints };
    this.applyHumanoidPose(sample.root);
    this.applyJointPoseTo(this.groups, { joints: sample.joints });
    if (sample.crossedEvent && !this.humanoidMotionEvents.has(sample.crossedEvent)) {
      this.humanoidMotionEvents.add(sample.crossedEvent);
      if (sample.crossedEvent === "pick_right") {
        this.pickNearestG1Object("right_hand", { forceNearest: true });
      }
    }
    this.setStatus(G1_SIMULATION.g1StatusText(motion.id, progress), "ready");
    if (progress >= 1) {
      this.activeHumanoidMotion = null;
      this.setStatus(`${this.manifestShortName()} kinematic action complete`, "ready");
    }
  }

  cancelHumanoidMotion(options = {}) {
    this.activeHumanoidMotion = null;
    this.humanoidMotionPaused = false;
    if (options.lockToVisual === false) {
      this.visualHumanoidState = {
        root: G1_SIMULATION.state.createHumanoidRoot(this.state && this.state.humanoidRoot),
        joints: { ...((this.state && this.state.joints) || {}) }
      };
      this.applyHumanoidPose(this.visualHumanoidState.root);
      this.applyJointPoseTo(this.groups, { joints: this.visualHumanoidState.joints });
    }
    return {
      humanoidRoot: G1_SIMULATION.state.createHumanoidRoot(this.visualHumanoidState.root),
      joints: { ...this.visualHumanoidState.joints },
      endEffectors: this.getG1EndEffectorState()
    };
  }

  getVisualHumanoidState() {
    return {
      humanoidRoot: G1_SIMULATION.state.createHumanoidRoot(this.visualHumanoidState.root),
      joints: { ...this.visualHumanoidState.joints },
      endEffectors: this.getG1EndEffectorState()
    };
  }

  setHumanoidMotionPaused(paused) {
    this.humanoidMotionPaused = Boolean(paused && this.activeHumanoidMotion);
    if (this.activeHumanoidMotion) {
      this.setStatus(
        this.humanoidMotionPaused
          ? `${this.manifestShortName()} kinematic action paused`
          : G1_SIMULATION.g1StatusText(
              this.activeHumanoidMotion.id,
              this.activeHumanoidMotion.durationSeconds > 0
                ? this.activeHumanoidMotion.elapsedSeconds / this.activeHumanoidMotion.durationSeconds
                : 0
            ),
        this.humanoidMotionPaused ? "loading" : "ready"
      );
    }
    return this.humanoidMotionPaused;
  }

  getG1EndEffectorState() {
    const result = {
      left_hand: { heldObjectId: "" },
      right_hand: { heldObjectId: "" }
    };
    if (!this.g1TaskObjects || !this.g1TaskObjects.objects) {
      return result;
    }
    this.g1TaskObjects.objects.forEach((object) => {
      const handId = object && object.userData && object.userData.heldBy;
      if (result[handId]) {
        result[handId] = { heldObjectId: object.userData.taskObjectId || object.name || "" };
      }
    });
    return result;
  }

  pickNearestG1Object(handId, options = {}) {
    if (!this.g1TaskObjects) {
      return { ok: false, objectId: "" };
    }
    if (options.forceNearest) {
      const frame = this.g1ToolFrames.get(handId);
      const first = this.g1TaskObjects.objects.values().next().value;
      if (frame && first) {
        frame.attach(first);
        first.position.set(52, 0, 0);
        first.rotation.set(0, 0, Math.PI / 2);
        first.userData.heldBy = handId;
        return { ok: true, objectId: first.userData.taskObjectId || first.name, distanceMm: 0 };
      }
    }
    return G1_SIMULATION.pickNearestObject(
      THREE,
      handId,
      this.g1ToolFrames,
      this.g1TaskObjects,
      Number(this.manifest && this.manifest.humanoid && this.manifest.humanoid.pickupRadiusM) * 1000 || 340
    );
  }

  releaseG1Object(handId) {
    return G1_SIMULATION.releaseObject(handId, this.g1ToolFrames, this.g1TaskObjects);
  }

  resetG1Objects() {
    G1_SIMULATION.resetTaskObjects(this.g1TaskObjects);
  }


  applyMobilePose(pose = this.visualMobilePose) {
    if (!this.root || !this.config.mobileBase) {
      return;
    }
    const base = pose || (this.state && this.state.mobileBase) || {};
    const positionScale = Number(this.config.mobileBase.positionScale) || 160;
    const thetaSign = Number(this.config.mobileBase.thetaSign) || 1;
    const x = Number(base.x) || 0;
    const y = Number(base.y) || 0;
    const theta = Number(base.theta) || 0;
    const groundY = Number(this.root.userData && this.root.userData.groundOffsetMm) || 0;
    this.root.position.set(x * positionScale, groundY, -y * positionScale);
    this.root.rotation.y = thetaSign * theta * DEG_TO_RAD;
  }

  getVisualMobileBasePose() {
    return this.cloneMobilePose(this.visualMobilePose || (this.state && this.state.mobileBase));
  }

  startMobileMotion(motion) {
    if (!this.config.mobileBase || !motion) {
      return;
    }
    const command = motion.command || {};
    const durationSeconds = Math.max(0, Number(motion.durationSeconds ?? command.seconds) || 0);
    const startPose = this.cloneMobilePose(motion.startPose || this.visualMobilePose || (this.state && this.state.mobileBase));
    const targetPose = this.cloneMobilePose(motion.targetPose || startPose);
    this.visualMobilePose = startPose;
    this.activeMobileMotion = durationSeconds > 0 ? {
      id: motion.id || `mobile-motion-${Date.now()}`,
      command: { ...command },
      startPose,
      targetPose,
      durationSeconds,
      elapsedSeconds: 0
    } : null;
    if (!this.activeMobileMotion) {
      this.visualMobilePose = targetPose;
    }
    this.applyMobilePose(this.visualMobilePose);
  }

  cancelMobileMotion(options = {}) {
    const pose = this.getVisualMobileBasePose();
    this.activeMobileMotion = null;
    if (options.lockToVisual !== false) {
      this.visualMobilePose = pose;
      this.applyMobilePose(pose);
    } else if (this.state && this.state.mobileBase) {
      this.visualMobilePose = this.cloneMobilePose(this.state.mobileBase);
      this.applyMobilePose(this.visualMobilePose);
    }
    return this.getVisualMobileBasePose();
  }

  cloneMobilePose(pose) {
    const source = pose && typeof pose === "object" ? pose : {};
    return {
      x: Number.isFinite(Number(source.x)) ? Number(source.x) : 0,
      y: Number.isFinite(Number(source.y)) ? Number(source.y) : 0,
      theta: this.normalizeDegrees(Number.isFinite(Number(source.theta)) ? Number(source.theta) : 0)
    };
  }

  normalizeDegrees(value) {
    let next = Number(value) || 0;
    while (next > 180) next -= 360;
    while (next < -180) next += 360;
    return next;
  }

  updateMobileAnimation(deltaSeconds) {
    if (!this.activeMobileMotion || !this.config.mobileBase) {
      return;
    }
    const motion = this.activeMobileMotion;
    const previousPose = this.getVisualMobileBasePose();
    motion.elapsedSeconds = Math.min(motion.durationSeconds, motion.elapsedSeconds + Math.max(0, deltaSeconds));
    const integrator = NS.RobotSimulation && typeof NS.RobotSimulation.integrateDrivePose === "function"
      ? NS.RobotSimulation.integrateDrivePose
      : null;
    const nextPose = motion.elapsedSeconds >= motion.durationSeconds
      ? this.cloneMobilePose(motion.targetPose)
      : this.cloneMobilePose(integrator ? integrator(motion.startPose, motion.command, motion.elapsedSeconds) : motion.targetPose);
    this.visualMobilePose = nextPose;
    this.applyMobilePose(nextPose);
    this.applyMobileCameraFollow(previousPose, nextPose);
    this.applyWheelMotion(previousPose, nextPose);
    if (motion.elapsedSeconds >= motion.durationSeconds) {
      this.activeMobileMotion = null;
      this.visualMobilePose = this.cloneMobilePose(motion.targetPose);
      this.applyMobilePose(this.visualMobilePose);
    }
  }

  applyMobileCameraFollow(previousPose, nextPose) {
    if (!this.config.mobileBase || !this.config.mobileBase.followBase || !this.camera || !this.controls) {
      return;
    }
    const previous = this.mobilePoseToRootPosition(previousPose);
    const next = this.mobilePoseToRootPosition(nextPose);
    const delta = next.sub(previous);
    if (delta.lengthSq() <= 0.000001) {
      return;
    }
    this.camera.position.add(delta);
    this.controls.target.add(delta);
  }

  mobilePoseToRootPosition(pose) {
    const positionScale = Number(this.config.mobileBase && this.config.mobileBase.positionScale) || 160;
    const base = this.cloneMobilePose(pose);
    const groundY = Number(this.root && this.root.userData && this.root.userData.groundOffsetMm) || 0;
    return new THREE.Vector3(base.x * positionScale, groundY, -base.y * positionScale);
  }

  bindMobileWheels() {
    this.wheelControllers = [];
    const mobileBase = this.config.mobileBase || {};
    const wheelDefs = Array.isArray(mobileBase.wheels) ? mobileBase.wheels : [];
    if (!this.root || wheelDefs.length === 0) {
      return;
    }
    this.root.updateMatrixWorld(true);
    const rootQuaternion = new THREE.Quaternion();
    const inverseRootQuaternion = new THREE.Quaternion();
    this.root.getWorldQuaternion(rootQuaternion);
    inverseRootQuaternion.copy(rootQuaternion).invert();
    const up = new THREE.Vector3(0, 1, 0);

    wheelDefs.forEach((wheel) => {
      const object = this.groups[wheel.group];
      if (!object) {
        return;
      }
      const joint = object.userData && object.userData.joint ? object.userData.joint : {};
      const axisSource = Array.isArray(wheel.axis) ? wheel.axis : joint.axis;
      const localAxis = new THREE.Vector3().fromArray(Array.isArray(axisSource) ? axisSource : [0, 1, 0]);
      if (localAxis.lengthSq() <= 0.000001) {
        return;
      }
      localAxis.normalize();

      const objectWorldQuaternion = new THREE.Quaternion();
      object.getWorldQuaternion(objectWorldQuaternion);
      const rootAxis = localAxis.clone().applyQuaternion(objectWorldQuaternion).applyQuaternion(inverseRootQuaternion);
      if (rootAxis.lengthSq() <= 0.000001) {
        return;
      }
      rootAxis.normalize();
      let tangent = new THREE.Vector3().crossVectors(up, rootAxis);
      if (tangent.lengthSq() <= 0.000001) {
        tangent = new THREE.Vector3(1, 0, 0);
      } else {
        tangent.normalize();
      }

      const worldCenter = new THREE.Vector3();
      object.getWorldPosition(worldCenter);
      const centerRoot = this.root.worldToLocal(worldCenter.clone());
      const id = wheel.id || object.name;
      this.wheelSpinById[id] = Number(this.wheelSpinById[id]) || 0;
      this.wheelControllers.push({
        id,
        object,
        localAxis,
        tangent,
        centerRoot,
        baseQuaternion: (object.userData && object.userData.baseQuaternion
          ? object.userData.baseQuaternion
          : object.quaternion
        ).clone(),
        spinSign: Number(wheel.spinSign) || 1
      });
      this.applyWheelSpin(this.wheelControllers[this.wheelControllers.length - 1]);
    });
  }

  applyWheelMotion(previousPose, nextPose) {
    if (!this.config.mobileBase || this.wheelControllers.length === 0) {
      return;
    }
    const radiusMm = Math.max(1, Number(this.config.mobileBase.wheelRadiusMm) || 48);
    const positionScale = Number(this.config.mobileBase.positionScale) || 1000;
    const thetaSign = Number(this.config.mobileBase.thetaSign) || 1;
    const previousTheta = (Number(previousPose.theta) || 0) * DEG_TO_RAD;
    const deltaWorldX = (Number(nextPose.x) - Number(previousPose.x)) || 0;
    const deltaWorldY = (Number(nextPose.y) - Number(previousPose.y)) || 0;
    const localForward = deltaWorldX * Math.cos(previousTheta) + deltaWorldY * Math.sin(previousTheta);
    const localLeft = -deltaWorldX * Math.sin(previousTheta) + deltaWorldY * Math.cos(previousTheta);
    const linearDelta = new THREE.Vector3(localForward * positionScale, 0, -localLeft * positionScale);
    const rootYawDelta = this.shortestAngleDegrees(previousPose.theta, nextPose.theta) * DEG_TO_RAD * thetaSign;

    this.wheelControllers.forEach((controller) => {
      const yawDelta = new THREE.Vector3(
        controller.centerRoot.z * rootYawDelta,
        0,
        -controller.centerRoot.x * rootYawDelta
      );
      const travelMm = linearDelta.clone().add(yawDelta).dot(controller.tangent);
      this.wheelSpinById[controller.id] += controller.spinSign * travelMm / radiusMm;
      this.applyWheelSpin(controller);
    });
  }

  applyWheelSpin(controller) {
    const angle = Number(this.wheelSpinById[controller.id]) || 0;
    const motion = new THREE.Quaternion().setFromAxisAngle(controller.localAxis, angle);
    controller.object.quaternion.copy(controller.baseQuaternion).multiply(motion).normalize();
  }

  shortestAngleDegrees(from, to) {
    return this.normalizeDegrees((Number(to) || 0) - (Number(from) || 0));
  }

  applyJointPose() {
    this.applyJointPoseTo(this.groups, this.state);
  }

  applyJointPoseTo(groups, pose) {
    this.jointDefs.forEach((joint) => {
      if (!joint.jointId || joint.sign === 0) {
        return;
      }
      const group = groups && groups[joint.id];
      if (!group) {
        return;
      }
      const value = this.getJointValueFromPose(pose, joint.jointId);
      const visualZero = this.getJointVisualZero(joint.jointId);
      const degrees = (joint.sign ?? 1) * (value - visualZero) + (joint.offsetDeg || 0);
      const axis = new THREE.Vector3().fromArray(joint.axis || [0, 1, 0]);
      if (axis.lengthSq() <= 0.000001) {
        return;
      }
      axis.normalize();
      const motion = new THREE.Quaternion().setFromAxisAngle(axis, degrees * DEG_TO_RAD);
      group.quaternion.copy(group.userData.baseQuaternion).multiply(motion);
    });
  }

  applyGripperPose() {
    if (this.meshGripper) {
      this.applyOfficialGripperPose();
      return;
    }
    if (!this.gripperGroups || !this.config.gripper) {
      return;
    }
    const gripper = this.config.gripper;
    const value = this.getJointValue(gripper.jointId);
    const open = Number(gripper.openValue);
    const close = Number(gripper.closeValue);
    const denominator = Math.max(1, Math.abs(close - open));
    const openRatio = THREE.MathUtils.clamp((close - value) / denominator, 0, 1);
    const spread = THREE.MathUtils.lerp(gripper.closedSpread || 10, gripper.openSpread || 34, openRatio);
    const jawOffset = gripper.jawOffset || [-48, 0, 0];
    const jawYaw = THREE.MathUtils.lerp(0.14, 0.36, openRatio);

    this.gripperGroups.left.position.set(jawOffset[0], jawOffset[1], jawOffset[2] + spread / 2);
    this.gripperGroups.right.position.set(jawOffset[0], jawOffset[1], jawOffset[2] - spread / 2);
    this.gripperGroups.left.rotation.set(0, jawYaw, 0);
    this.gripperGroups.right.rotation.set(0, -jawYaw, 0);
  }

  applyOfficialGripperPose() {
    this.applyOfficialGripperPoseTo(this.meshGripper, this.state);
  }

  applyOfficialGripperPoseTo(meshGripper, pose) {
    if (!meshGripper) {
      return;
    }
    const { group, definition, joint } = meshGripper;
    if (!group || !definition) {
      return;
    }
    const value = this.getJointValueFromPose(pose, definition.jointId);
    const open = Number(definition.openValue);
    const close = Number(definition.closeValue);
    const denominator = Math.max(1, Math.abs(close - open));
    const openRatio = THREE.MathUtils.clamp((close - value) / denominator, 0, 1);
    const closedDeg = Number(definition.closedDeg);
    const openDeg = Number(definition.openDeg);
    const sign = Number(definition.sign) || 1;
    const degrees = sign * THREE.MathUtils.lerp(
      Number.isFinite(closedDeg) ? closedDeg : 0,
      Number.isFinite(openDeg) ? openDeg : 0,
      openRatio
    );
    const axis = new THREE.Vector3().fromArray((joint && joint.axis) || [0, 1, 0]);
    if (axis.lengthSq() <= 0.000001) {
      return;
    }
    axis.normalize();
    const motion = new THREE.Quaternion().setFromAxisAngle(axis, degrees * DEG_TO_RAD);
    group.quaternion.copy(group.userData.baseQuaternion).multiply(motion);
  }

  getJointValue(jointId) {
    return this.getJointValueFromPose(this.state, jointId);
  }

  getJointValueFromPose(pose, jointId) {
    const joint = this.getManifestJoint(jointId);
    const fallback = joint ? this.getJointHome(jointId) : 0;
    const source = pose && pose.joints && typeof pose.joints === "object" ? pose.joints : pose;
    const raw = source && typeof source === "object" ? source[jointId] : fallback;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  getJointHome(jointId) {
    const joint = this.getManifestJoint(jointId);
    const home = joint ? Number(joint.home) : 0;
    return Number.isFinite(home) ? home : 0;
  }

  getJointVisualZero(jointId) {
    const visualZeroJoints = this.config && this.config.visualZeroJoints && typeof this.config.visualZeroJoints === "object"
      ? this.config.visualZeroJoints
      : {};
    const visualZero = Number(visualZeroJoints[jointId]);
    return Number.isFinite(visualZero) ? visualZero : this.getJointHome(jointId);
  }

  getManifestJoint(jointId) {
    const joints = this.manifest && Array.isArray(this.manifest.joints) ? this.manifest.joints : [];
    return joints.find((joint) => joint.id === jointId) || null;
  }

  resetCamera() {
    if (!this.camera || !this.controls) {
      return;
    }
    const camera = this.config.camera || {};
    this.camera.position.fromArray(camera.position || [360, 260, 500]);
    this.controls.target.fromArray(camera.target || [0, 90, 0]);
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
    const nowSeconds = window.performance && typeof window.performance.now === "function"
      ? window.performance.now() / 1000
      : Date.now() / 1000;
    const rawDeltaSeconds = this.lastFrameSeconds ? nowSeconds - this.lastFrameSeconds : 0;
    this.lastFrameSeconds = nowSeconds;
    if (this.skipNextLeaderFrameTimingSample) {
      this.skipNextLeaderFrameTimingSample = false;
    } else if (rawDeltaSeconds > 0) {
      this.leaderFrameSamplesMs.push(rawDeltaSeconds * 1000);
      if (this.leaderFrameSamplesMs.length > LEADER_FRAME_SAMPLE_LIMIT) {
        this.leaderFrameSamplesMs.shift();
      }
    }
    this.updateMobileAnimation(Math.min(MAX_MOBILE_DELTA_SECONDS, Math.max(0, rawDeltaSeconds)));
    this.updateHumanoidAnimation(Math.min(MAX_MOBILE_DELTA_SECONDS, Math.max(0, rawDeltaSeconds)));
    this.controls.update();
    if (!this.webglContextLost) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.cancelLeaderInteraction("disposed");
    this.unbindLeaderInteraction();
    this.disposed = true;
    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    window.removeEventListener("resize", this._boundResize);
    this.clearLeaderRigArtifacts();
    const geometries = new Set();
    const materials = new Set();
    if (this.scene) {
      this.scene.traverse((object) => {
        if (object.geometry) {
          geometries.add(object.geometry);
        }
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.filter(Boolean).forEach((material) => materials.add(material));
      });
    }
    this.disposeGeometries(geometries);
    Object.values(this.materials || {}).filter(Boolean).forEach((material) => materials.add(material));
    Object.values(this.leaderMaterials || {}).filter(Boolean).forEach((material) => materials.add(material));
    materials.forEach((material) => {
      if (typeof material.dispose === "function") {
        this.debugResourceStats.materialDisposeCalls += 1;
        material.dispose();
      }
    });
    if (this.controls && typeof this.controls.dispose === "function") {
      this.controls.dispose();
    }
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentElement) {
        this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
      }
    }
    this.leaderInteractionCallbacks = {};
    this.leaderCallbackRegistration = null;
    if (registry.robotRigInstances) {
      registry.robotRigInstances.delete(this);
    }
    if (registry.lastRobotRigInstance === this) {
      registry.lastRobotRigInstance = null;
    }
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
registry.RobotRigPreview3D = RobotRigPreview3D;
registry.config = ARM_RIG_CONFIG;
registry.robotRigPreviewConfigs = ROBOT_RIG_PREVIEW_CONFIGS;
registry.g1Simulation = G1_SIMULATION;
registry.getLeaderDebugSnapshots = () => Array.from(registry.robotRigInstances || [])
  .map((instance) => instance.getLeaderDebugSnapshot());
registry.resetLeaderFrameTimingSamples = () => Array.from(registry.robotRigInstances || [])
  .map((instance) => instance.resetLeaderFrameTimingSamples());

window.dispatchEvent(new CustomEvent("robobuddy:robot-preview-3d-ready"));
