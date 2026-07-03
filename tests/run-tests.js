const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createContext() {
  const store = new Map();
  const listeners = {};
  const window = {
    RoboAdmin: {},
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
      removeItem(key) { store.delete(key); }
    },
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    dispatchEvent(event) {
      (listeners[event.type] || []).forEach((handler) => handler(event));
    }
  };
  class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const Blockly = {
    Blocks: {},
    Theme: { defineTheme: (_name, theme) => theme },
    FieldDropdown: function FieldDropdown() {},
    FieldNumber: function FieldNumber() {},
    FieldTextInput: function FieldTextInput() {}
  };
  return vm.createContext({ window, CustomEvent, console, Blockly });
}

function runScript(context, relPath) {
  const file = path.join(root, relPath);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

function loadRobotContext() {
  const context = createContext();
  [
    "robots/registry.js",
    "robots/packs/arduino_arm/manifest.js",
    "robots/packs/so101_follower/manifest.js",
    "robots/packs/lekiwi_sim/manifest.js",
    "robots/safety.js",
    "robots/commandSchema.js",
    "robots/adapters/simulation/simulation.js",
    "robots/adapters/hardware/hardware.js",
    "robots/runtime.js"
  ].forEach((file) => runScript(context, file));
  return context;
}

function testRegistryAndManifests() {
  const context = loadRobotContext();
  const NS = context.window.RoboAdmin;
  assert(NS.RobotRegistry.list().length === 3, "registers all three Tier 1 robots");
  assert(
    NS.RobotRegistry.list().map((manifest) => manifest.name).join("|") === "Arduino Arm|LeRobot SO-101 F|LeKiwi mobile robot",
    "robot chooser names stay in the requested display order"
  );
  assert(
    NS.RobotRegistry.list().map((manifest) => manifest.shortName).join("|") === "Arduino Arm|LeRobot SO-101 F|LeKiwi mobile robot",
    "robot short names stay aligned with the requested visible model names"
  );
  assert(NS.RobotRegistry.getDefaultRobotId() === "arduino_arm", "default robot is arduino_arm");
  NS.RobotRegistry.setActive("missing_robot");
  assert(NS.RobotRegistry.getActive().id === "arduino_arm", "invalid active robot falls back");
  assert(NS.RobotRegistry.migrateSavedRobotId("arduino_howto_arm") === "arduino_arm", "legacy Arduino id migrates");
  assert(!NS.RobotRegistry.get("lekiwi_sim").supportedModes.includes("hardware"), "lekiwi_sim has no hardware mode");
  assert(NS.RobotRegistry.get("so101_follower").hardware.requiresLocalBridge === true, "SO-101 requires local bridge");
}

function testCommandValidation() {
  const context = loadRobotContext();
  const schema = context.window.RoboAdmin.RobotCommandSchema;
  assert(schema.validateCommand({ type: "move_joint", robotId: "so101_follower", joint: "elbow_flex", value: 30, speed: 50 }).ok, "valid move_joint accepted");
  assert(!schema.validateCommand({ type: "move_joint", robotId: "so101_follower", joint: "bad", value: 30 }).ok, "invalid joint rejected");
  assert(!schema.validateCommand({ type: "move_joint", robotId: "so101_follower", joint: "elbow_flex", value: 300 }).ok, "out-of-range joint rejected");
  assert(!schema.validateCommand({ type: "drive", robotId: "arduino_arm", vx: 0.2, vy: 0, omega: 0, seconds: 1 }).ok, "drive rejected for arm robots");
  assert(schema.validateCommand({ type: "drive", robotId: "lekiwi_sim", vx: 0.2, vy: 0, omega: 0, seconds: 1 }).ok, "drive accepted for lekiwi_sim");
  assert(schema.validateCommand({ type: "stop", robotId: "arduino_arm" }).ok, "STOP accepted for Arduino");
  assert(schema.validateCommand({ type: "stop", robotId: "so101_follower" }).ok, "STOP accepted for SO-101");
  assert(schema.validateCommand({ type: "stop", robotId: "lekiwi_sim" }).ok, "STOP accepted for LeKiwi");
  const legacy = schema.validateCommand({ type: "servo", servo: 0, angle: 100, speed: 50 });
  assert(legacy.ok && legacy.command.robotId === "arduino_arm" && legacy.command.joint === "base", "legacy servo resolves to arduino_arm");
  assert(schema.validateCommand({ type: "move_joint", robotId: "arduino_arm", joint: "wrist_tilt", value: 90 }).ok, "existing Arduino joint names validate");
}

function testBlocklyAndPythonContracts() {
  const context = loadRobotContext();
  runScript(context, "js/blocks.js");
  runScript(context, "js/generators.js");
  const NS = context.window.RoboAdmin;
  NS.RobotRegistry.setActive("lekiwi_sim");
  assert(NS.Blocks.toolboxXml().includes("drive_forward"), "LeKiwi toolbox includes drive blocks");
  NS.RobotRegistry.setActive("arduino_arm");
  assert(!NS.Blocks.toolboxXml().includes("drive_forward"), "Arduino toolbox excludes drive blocks");
  const toolboxEl = { innerHTML: "" };
  const workspace = {
    updateToolbox(source) {
      this.source = source;
    }
  };
  NS.Blocks.refreshToolbox(workspace, toolboxEl);
  assert(workspace.source === toolboxEl, "Blockly refresh uses toolbox element, not raw category fragment");
  const emitterText = fs.readFileSync(path.join(root, "js/python-emitter.js"), "utf8");
  assert(emitterText.includes("robot.move_joint"), "Blockly Python emitter uses robot.*");
  const workerText = fs.readFileSync(path.join(root, "js/python-worker.js"), "utf8");
  assert(workerText.includes("robot = Robot()"), "Python worker exposes robot");
  assert(workerText.includes("arm = robot"), "Python worker keeps arm alias");
  assert(workerText.includes("def drive_forward"), "Python worker exposes LeKiwi drive commands");
  assert(workerText.includes("def open_gripper") && workerText.includes("def close_gripper") && workerText.includes("def set_gripper"), "Python worker keeps programmatic gripper helpers");
  const runnerText = fs.readFileSync(path.join(root, "js/runner.js"), "utf8");
  assert(
    runnerText.includes('case "drive"') && runnerText.includes("_executeDelay(Math.round(Number(cmd.seconds || 0) * 1000))"),
    "program runner waits for simulated drive duration"
  );
  const storageText = fs.readFileSync(path.join(root, "js/storage.js"), "utf8");
  assert(!/<field name="JOINT">[0-9]+<\/field>/.test(storageText), "built-in Blockly programs use manifest joint ids");
  const preview3dText = fs.readFileSync(path.join(root, "simulator/js/arm-preview-3d.js"), "utf8");
  assert(preview3dText.includes("shouldShowArduinoPreview"), "3D Arduino preview is guarded by active robot");
  assert(!preview3dText.includes("ArmPreview2D") && !preview3dText.includes("using 2D fallback"), "3D preview failure path does not revive the removed 2D fallback");
  assert(preview3dText.includes("groundOffsetMm") && preview3dText.includes("groundY"), "mobile mesh previews preserve baked ground offset while driving");
  const simulationText = fs.readFileSync(path.join(root, "robots/adapters/simulation/simulation.js"), "utf8");
  assert(!simulationText.includes("data-robot-sim-3d-status") && !simulationText.includes("data-robot-sim-3d-readout"), "SO-101 and LeKiwi 3D simulator windows do not render in-canvas labels");
  const appText = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
  assert(appText.includes('icon: "arrow-up"') && appText.includes('icon: "rotate-cw"') && appText.includes('icon: "square"'), "Drive controls map actions to Lucide icons");
  assert(appText.includes("robot-drive-controls__button--${slot}") && appText.includes('aria-label="${label}"') && appText.includes('data-hint="${label}"'), "Drive controls render slotted icon buttons with accessible popover labels");
  assert(!/data-drive="(?:forward|backward|left|right|turn-left|turn-right|stop)"[^>]*>[^<]*(?:Forward|Backward|Strafe|Turn|Stop)/.test(appText), "Drive controls do not render visible text labels inside buttons");
  assert(!appText.includes("data-gripper-action"), "Manual gripper endpoint buttons are not rendered or wired");
  assert(appText.includes("formatJointReadout") && appText.includes("formatJointAriaValue"), "Manual gripper sliders expose state-aware visual and aria readouts");
  const styleText = fs.readFileSync(path.join(root, "css/style.css"), "utf8");
  assert(!styleText.includes("#armSvg") && !styleText.includes("#pythonArmSvg") && !styleText.includes("#geminiArmSvg"), "removed 2D preview SVG ids are not styled as active UI");
  assert(styleText.includes('"turn-left forward turn-right"') && styleText.includes('"left stop right"') && styleText.includes('". backward ."'), "Drive controls use a game-controller pad layout");
  assert(styleText.includes("grid-template-columns: repeat(3, 30px)") && styleText.includes("grid-auto-rows: 26px"), "Drive control pad uses compact fixed cells");
  assert(styleText.includes(".robot-drive-controls .robot-drive-controls__button svg") && styleText.includes("width: 14px") && styleText.includes("height: 14px"), "Drive control icons use a scoped compact icon size");
  assert(styleText.includes(".sidebar__controls.has-drive-controls .teach-controls") && styleText.includes(".sidebar__controls.has-drive-controls .robot-drive-controls"), "Teach and Drive controls share the top manual-control row when drive controls are visible");
  assert(
    styleText.includes("grid-template-columns: minmax(124px, 1fr) auto") &&
      styleText.includes("grid-template-columns: repeat(4, minmax(var(--index-3d-teach-controls-size, 28px), 1fr))") &&
      styleText.includes("gap: var(--index-3d-teach-controls-gap, 8px)") &&
      styleText.includes("justify-self: center"),
    "Teach controls spread action buttons across anchored columns in the side-by-side layout"
  );
  const indexText = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert(indexText.includes("buttonColumnCount = Math.max(1, Math.min(4, buttonCount))"), "Teach button resize metrics are based on the four-column action grid");
  assert(styleText.includes(".robot-sim-3d__reset") && styleText.includes("width: 34px") && styleText.includes("height: 34px"), "robot 3D camera reset button matches Arduino 3D reset size");
  assert(styleText.includes(".robot-sim--three .robot-sim-3d__reset svg") && styleText.includes("width: 18px") && styleText.includes("height: 18px"), "robot 3D camera reset icon matches Arduino 3D reset icon size");
  assert(styleText.includes(".robot-sim--three .robot-sim-3d__status") && styleText.includes("display: none !important"), "robot 3D simulator label overlays stay hidden if legacy markup appears");
  const armPreviewStyleText = fs.readFileSync(path.join(root, "simulator/css/arm-preview-3d.css"), "utf8");
  assert(armPreviewStyleText.includes(".arm-preview-3d__status") && armPreviewStyleText.includes("display: none !important"), "Arduino 3D simulator status label stays hidden");
  assert(armPreviewStyleText.includes(".arm-preview-container.is-robot-sim-active .arm-preview-3d"), "robot simulator screens hide the Arduino 3D preview surface");
  assert(armPreviewStyleText.includes("justify-content: flex-end"), "Arduino 3D camera reset button remains aligned top-right without a status label");
  NS.RobotRegistry.setActive("so101_follower");
  const legacyBaseProgram = {
    getTopBlocks() {
      return [{
        id: "legacy-base",
        type: "move_joint",
        getFieldValue(name) {
          return ({ JOINT: "base", ANGLE: "30", SPEED: "50" })[name];
        },
        getNextBlock() {
          return null;
        }
      }];
    }
  };
  const commands = NS.Generator.generateCommands(legacyBaseProgram);
  assert(commands[0].robotId === "so101_follower" && commands[0].joint === "shoulder_pan", "legacy Arduino joint fields migrate to active SO-101 joints");
  assert(commands[0].value >= -90 && commands[0].value <= 90 && commands[0].value !== 30, "legacy Arduino servo values map into SO-101 joint limits");
}

function testSimulation() {
  const context = loadRobotContext();
  const NS = context.window.RoboAdmin;
  let sim = NS.RobotSimulation.createSimulationAdapter(NS.RobotRegistry.get("arduino_arm"));
  sim.applyCommand({ type: "home", robotId: "arduino_arm" });
  sim.applyCommand({ type: "move_joint", robotId: "arduino_arm", joint: "base", value: 100, speed: 50 });
  assert(sim.getState().joints.base === 100, "arduino_arm sim accepts home/move_joint");
  sim = NS.RobotSimulation.createSimulationAdapter(NS.RobotRegistry.get("so101_follower"));
  sim.applyCommand({ type: "home", robotId: "so101_follower" });
  sim.applyCommand({ type: "move_joint", robotId: "so101_follower", joint: "elbow_flex", value: 30, speed: 50 });
  assert(sim.getState().joints.elbow_flex === 30, "so101_follower sim accepts home/move_joint");
  sim = NS.RobotSimulation.createSimulationAdapter(NS.RobotRegistry.get("lekiwi_sim"));
  const before = sim.getState().mobileBase.x;
  sim.applyCommand({ type: "drive", robotId: "lekiwi_sim", vx: 0.2, vy: 0, omega: 0, seconds: 1, frame: "robot" });
  assert(sim.getState().mobileBase.x > before, "lekiwi_sim drive updates base pose");
  const start = { x: 0, y: 0, theta: 0 };
  const forward = NS.RobotSimulation.integrateDrivePose(start, { vx: 0.4, vy: 0, omega: 0, frame: "robot" }, 0.5);
  assert(forward.x > 0.19 && Math.abs(forward.y) < 0.001, "LeKiwi drive integrator advances forward smoothly");
  const turned = NS.RobotSimulation.integrateDrivePose(start, { vx: 0, vy: 0, omega: 45, frame: "robot" }, 1);
  assert(Math.abs(turned.theta - 45) < 0.001, "LeKiwi drive integrator updates heading");
  const arcCommand = { vx: 0.3, vy: 0.05, omega: 40, frame: "robot" };
  const full = NS.RobotSimulation.integrateDrivePose(start, arcCommand, 1);
  const partial = NS.RobotSimulation.integrateDrivePose(start, arcCommand, 0.35);
  const completed = NS.RobotSimulation.integrateDrivePose(partial, arcCommand, 0.65);
  assert(Math.abs(full.x - completed.x) < 0.0001, "split drive integration matches full x");
  assert(Math.abs(full.y - completed.y) < 0.0001, "split drive integration matches full y");
  assert(Math.abs(full.theta - completed.theta) < 0.0001, "split drive integration matches full heading");
  sim.stop();
  assert(sim.getState().stopped === true && sim.getState().queue.length === 0, "STOP clears simulated queue");
}

async function testRuntimeBridgeSafety() {
  const context = loadRobotContext();
  const NS = context.window.RoboAdmin;
  const bridgeCalls = [];
  NS.RobotHardware.BridgeAdapter = class FakeBridgeAdapter {
    constructor() {
      this.baseUrl = "mock://bridge";
    }

    async home(robotId) {
      bridgeCalls.push(["home", robotId]);
      return { ok: true, status: "CONNECTED" };
    }

    async stop(robotId) {
      bridgeCalls.push(["stop", robotId]);
      return { ok: true, status: "STOPPED" };
    }
  };
  NS.RobotRuntime.init();
  NS.RobotRuntime.setActive("so101_follower");
  NS.RobotRuntime.createBridgeAdapter({});
  NS.RobotRuntime.setMode("local_bridge");
  let homeBlocked = false;
  try {
    await NS.RobotRuntime.applyCommand({ type: "home", robotId: "so101_follower" });
  } catch (error) {
    homeBlocked = /safety confirmation/.test(error.message);
  }
  assert(homeBlocked, "SO-101 bridge home requires hardware safety confirmation");
  await NS.RobotRuntime.applyCommand({ type: "stop", robotId: "so101_follower" });
  assert(bridgeCalls.some((call) => call[0] === "stop"), "SO-101 bridge STOP remains available without confirmation");
  NS.RobotRuntime.setBridgeSafetyConfirmed(true);
  await NS.RobotRuntime.applyCommand({ type: "home", robotId: "so101_follower" });
  assert(bridgeCalls.some((call) => call[0] === "home"), "SO-101 bridge home works after confirmation");
}

function testBridge() {
  const code = `
from robobuddy_bridge.adapters.fake import FakeAdapter
from robobuddy_bridge.adapters.so101_lerobot import SO101LeRobotAdapter
from robobuddy_bridge.api import _adapter
fake = FakeAdapter("so101_follower")
assert fake.connect({"dryRun": True})["status"] == "CONNECTED"
assert fake.execute([{"type": "home", "robotId": "so101_follower"}])["lastCommands"]
so101 = SO101LeRobotAdapter("so101_follower")
state = so101.connect({"dryRun": True})
assert state["status"] in ("LEROBOT_NOT_INSTALLED", "NEEDS_CALIBRATION", "CONNECTED")
assert so101.stop()["status"] == "STOPPED"
assert _adapter("missing_robot") is None
print("bridge ok")
`;
  const result = spawnSync("python", ["-c", code], {
    cwd: path.join(root, "bridge"),
    encoding: "utf8"
  });
  assert(result.status === 0, `bridge tests failed: ${result.stderr || result.stdout}`);
}

function parseRobotMeshData(relPath) {
  const file = path.join(root, relPath);
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/Object\.freeze\((.*)\);\s*$/s);
  assert(match, `${relPath} must export Object.freeze(JSON)`);
  return JSON.parse(match[1]);
}

function parseRobotRigPreviewConfigs() {
  const file = path.join(root, "simulator/js/robot-rig-configs.js");
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/export const ROBOT_RIG_PREVIEW_CONFIGS = Object\.freeze\(([\s\S]*)\);\s*$/);
  assert(match, "robot rig preview configs must export Object.freeze(configs)");
  return vm.runInNewContext(`(${match[1]})`);
}

function officialGripperDegrees(gripper, value) {
  const openValue = Number(gripper.openValue);
  const closeValue = Number(gripper.closeValue);
  const openDeg = Number(gripper.openDeg);
  const closedDeg = Number(gripper.closedDeg);
  const sign = Number(gripper.sign) || 1;
  assert(Number.isFinite(openValue) && Number.isFinite(closeValue), "mesh gripper exposes finite command endpoints");
  assert(Number.isFinite(openDeg) && Number.isFinite(closedDeg), "mesh gripper exposes finite visual endpoints");
  const denominator = Math.max(1, Math.abs(closeValue - openValue));
  const openRatio = Math.min(1, Math.max(0, (closeValue - Number(value)) / denominator));
  return sign * (closedDeg + (openDeg - closedDeg) * openRatio);
}

function assertOfficialGripperSliderSemantics(meshData, label) {
  const gripper = meshData.gripper;
  assert(gripper, `${label} mesh data defines a gripper`);
  ["openValue", "closeValue", "openDeg", "closedDeg", "sign"].forEach((field) => {
    assert(field in gripper, `${label} mesh gripper exposes ${field}`);
  });
  assert(Number(gripper.openValue) === 20, `${label} mesh gripper keeps open command at 20%`);
  assert(Number(gripper.closeValue) === 85, `${label} mesh gripper keeps close command at 85%`);
  assert(Number(gripper.openDeg) > Number(gripper.closedDeg), `${label} mesh gripper open pose is wider than closed pose`);

  const at0 = officialGripperDegrees(gripper, 0);
  const at20 = officialGripperDegrees(gripper, 20);
  const at50 = officialGripperDegrees(gripper, 50);
  const at85 = officialGripperDegrees(gripper, 85);
  const at100 = officialGripperDegrees(gripper, 100);

  assert(Math.abs(at0 - at20) < 0.0001, `${label} gripper clamps below the open endpoint`);
  assert(Math.abs(at85 - at100) < 0.0001, `${label} gripper clamps above the closed endpoint`);
  assert(Math.abs(at20) > Math.abs(at50), `${label} 20% is more open than 50%`);
  assert(Math.abs(at50) > Math.abs(at85), `${label} 50% is more open than 85%`);
}

function testSharedGripperSliderSemantics() {
  const context = loadRobotContext();
  const NS = context.window.RoboAdmin;
  const schema = NS.RobotCommandSchema;
  const lerobot = NS.RobotRegistry.get("so101_follower");
  const lekiwi = NS.RobotRegistry.get("lekiwi_sim");
  const lerobotGripper = lerobot.joints.find((joint) => joint.id === "gripper");
  const lekiwiGripper = lekiwi.joints.find((joint) => joint.id === "gripper");

  assert(lerobotGripper && lekiwiGripper, "LeRobot and LeKiwi both define gripper joints");
  ["min", "max", "home", "open", "close", "speedMin", "speedMax"].forEach((field) => {
    assert(lekiwiGripper[field] === lerobotGripper[field], `LeKiwi gripper manifest ${field} keeps the shared command contract`);
  });
  ["open", "close"].forEach((value) => {
    const lerobotCommand = schema.validateCommand({ type: "set_gripper", robotId: "so101_follower", value });
    const lekiwiCommand = schema.validateCommand({ type: "set_gripper", robotId: "lekiwi_sim", value });
    assert(lerobotCommand.ok && lekiwiCommand.ok, `${value} gripper command validates for both robot packs`);
    assert(lekiwiCommand.command.value === lerobotCommand.command.value, `LeKiwi ${value} gripper command resolves to the LeRobot position`);
  });

  const configs = parseRobotRigPreviewConfigs();
  assert(configs.so101_follower && configs.lekiwi_sim, "rig preview configs define LeRobot and LeKiwi");
  assert(configs.so101_follower.gripper && configs.lekiwi_sim.gripper, "rig preview configs define both grippers");
  const visualFields = ["jointId", "parent", "openValue", "closeValue", "openSpread", "closedSpread", "jawLength", "jawSize", "jawOffset"];
  visualFields.forEach((field) => {
    assert(field in configs.so101_follower.gripper && field in configs.lekiwi_sim.gripper, `fallback gripper ${field} exists for both robots`);
  });

  const lerobotMesh = parseRobotMeshData("simulator/js/robot-mesh-data-so101.js");
  const lekiwiMesh = parseRobotMeshData("simulator/js/robot-mesh-data-lekiwi.js");
  assertOfficialGripperSliderSemantics(lerobotMesh, "SO-101");
  assertOfficialGripperSliderSemantics(lekiwiMesh, "LeKiwi");
  assert(Number(lerobotMesh.gripper.sign) === 1, "SO-101 official mesh keeps positive gripper jaw rotation");
  assert(Number(lekiwiMesh.gripper.sign) === -1, "LeKiwi official mesh uses mirrored gripper jaw rotation to avoid crossing");
}

function quaternionToMatrix(q) {
  const [rawX, rawY, rawZ, rawW] = q.map(Number);
  const norm = Math.hypot(rawX, rawY, rawZ, rawW) || 1;
  const x = rawX / norm;
  const y = rawY / norm;
  const z = rawZ / norm;
  const w = rawW / norm;
  return [
    [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w, 0],
    [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w, 0],
    [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y, 0],
    [0, 0, 0, 1]
  ];
}

function composeMatrix(position, quaternion, scale = 1) {
  const matrix = quaternionToMatrix(quaternion || [0, 0, 0, 1]);
  const s = Number(scale) || 1;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      matrix[row][col] *= s;
    }
  }
  matrix[0][3] = Number(position && position[0]) || 0;
  matrix[1][3] = Number(position && position[1]) || 0;
  matrix[2][3] = Number(position && position[2]) || 0;
  return matrix;
}

function multiplyMatrices(a, b) {
  const out = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      for (let k = 0; k < 4; k += 1) {
        out[row][col] += a[row][k] * b[k][col];
      }
    }
  }
  return out;
}

function transformPoint(matrix, point) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  return [
    matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z + matrix[0][3],
    matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z + matrix[1][3],
    matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z + matrix[2][3]
  ];
}

function identityMatrix() {
  return [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
}

function decodeMeshPositions(meshData, meshPayload) {
  const bounds = meshPayload.bounds.map(Number);
  const quantization = Number(meshData.quantization) || 65535;
  const bytes = Buffer.from(meshPayload.positions, "base64");
  const vertexCount = Number(meshPayload.vertexCount);
  assert(bytes.length >= vertexCount * 3 * 2, "mesh payload byte length matches vertex count");
  const points = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const point = [];
    for (let axis = 0; axis < 3; axis += 1) {
      const raw = bytes.readUInt16LE((vertex * 3 + axis) * 2);
      point.push(bounds[axis] + (bounds[axis + 3] - bounds[axis]) * raw / quantization);
    }
    points.push(point);
  }
  return points;
}

function measureOfficialMeshBounds(meshData) {
  const groups = { root: identityMatrix() };
  for (const joint of meshData.chain) {
    assert(groups[joint.parent], `parent group exists for ${joint.id}`);
    groups[joint.id] = multiplyMatrices(
      groups[joint.parent],
      composeMatrix(joint.pivotMm || joint.pivot || [0, 0, 0], joint.baseQuat || [0, 0, 0, 1], 1)
    );
  }

  const meshPositionCache = new Map();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of meshData.parts) {
    assert(groups[part.group], `part ${part.key} references an existing group`);
    assert(meshData.meshes[part.meshKey], `part ${part.key} references an existing mesh`);
    if (!meshPositionCache.has(part.meshKey)) {
      meshPositionCache.set(part.meshKey, decodeMeshPositions(meshData, meshData.meshes[part.meshKey]));
    }
    const matrix = multiplyMatrices(
      groups[part.group],
      composeMatrix(part.posMm || [0, 0, 0], part.quat || [0, 0, 0, 1], part.scale || 1)
    );
    for (const point of meshPositionCache.get(part.meshKey)) {
      const world = transformPoint(matrix, point);
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], world[axis]);
        max[axis] = Math.max(max[axis], world[axis]);
      }
    }
  }
  return { groups, min, max, computed: [...min, ...max] };
}

function assertBakedBboxMatchesComputed(meshData, measurement, label) {
  const expected = meshData.bboxMm.map(Number);
  assert(expected.length === 6, `${label} mesh data exposes a six-value bboxMm`);
  measurement.computed.forEach((value, index) => {
    assert(Math.abs(value - expected[index]) < 0.75, `rendered ${label} bbox matches baked bbox at index ${index}`);
  });
}

function testSo101OfficialMeshTransformSpace() {
  const meshData = parseRobotMeshData("simulator/js/robot-mesh-data-so101.js");
  assert(meshData.robotId === "so101_follower", "SO-101 mesh data targets the SO-101 follower");
  assert(meshData.geometryFrame === "three-y-up-meters", "SO-101 STL vertices are baked into the Three.js Y-up geometry frame");
  assert(meshData.source && meshData.source.transformFrame === "three-y-up-millimeters", "SO-101 transforms are baked into the Three.js millimeter frame");
  assert(meshData.gripper && meshData.gripper.node, "SO-101 mesh data includes the moving jaw gripper node");

  const groups = { root: identityMatrix() };
  for (const joint of meshData.chain) {
    assert(groups[joint.parent], `parent group exists for ${joint.id}`);
    groups[joint.id] = multiplyMatrices(
      groups[joint.parent],
      composeMatrix(joint.pivotMm || joint.pivot || [0, 0, 0], joint.baseQuat || [0, 0, 0, 1], 1)
    );
  }
  assert(groups[meshData.gripper.node], "gripper node exists in the generated chain");

  const meshPositionCache = new Map();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of meshData.parts) {
    assert(groups[part.group], `part ${part.key} references an existing group`);
    assert(meshData.meshes[part.meshKey], `part ${part.key} references an existing mesh`);
    if (!meshPositionCache.has(part.meshKey)) {
      meshPositionCache.set(part.meshKey, decodeMeshPositions(meshData, meshData.meshes[part.meshKey]));
    }
    const matrix = multiplyMatrices(
      groups[part.group],
      composeMatrix(part.posMm || [0, 0, 0], part.quat || [0, 0, 0, 1], part.scale || 1)
    );
    for (const point of meshPositionCache.get(part.meshKey)) {
      const world = transformPoint(matrix, point);
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], world[axis]);
        max[axis] = Math.max(max[axis], world[axis]);
      }
    }
  }

  const computed = [...min, ...max];
  const expected = meshData.bboxMm.map(Number);
  assert(expected.length === 6, "SO-101 mesh data exposes a six-value bboxMm");
  computed.forEach((value, index) => {
    assert(Math.abs(value - expected[index]) < 0.75, `rendered SO-101 bbox matches baked bbox at index ${index}`);
  });

  const height = max[1] - min[1];
  const width = max[0] - min[0];
  assert(height > 200 && height < 290, "SO-101 assembled height is in the expected physical range");
  assert(width > 350 && width < 460, "SO-101 assembled reach is in the expected physical range");
  assert(Number(meshData.groundOffsetMm) > 0 && Number(meshData.groundOffsetMm) < 5, "SO-101 ground offset is small after assembly");
}

function testLeKiwiOfficialMeshTransformSpace() {
  const meshData = parseRobotMeshData("simulator/js/robot-mesh-data-lekiwi.js");
  assert(meshData.robotId === "lekiwi_sim", "LeKiwi mesh data targets the LeKiwi simulator");
  assert(meshData.geometryFrame === "three-y-up-meters", "LeKiwi STL vertices are baked into the Three.js Y-up geometry frame");
  assert(meshData.source && meshData.source.transformFrame === "three-y-up-millimeters", "LeKiwi transforms are baked into the Three.js millimeter frame");
  assert(meshData.gripper && meshData.gripper.node === "gripper_jaw", "LeKiwi mesh data includes the moving jaw gripper node");
  assert((meshData.parts || []).length >= 40, "LeKiwi official assembly includes the full mobile-base and arm part set");
  assert(Object.keys(meshData.meshes || {}).length >= 25, "LeKiwi official assembly includes the expected unique STL meshes");

  const meshKeys = Object.keys(meshData.meshes || {}).join(" ");
  assert(/omni_directional_wheel/.test(meshKeys), "LeKiwi mesh data includes official omni-wheel geometry");
  assert(/base_plate_layer/.test(meshKeys), "LeKiwi mesh data includes official base-plate geometry");
  assert(/camera_model/.test(meshKeys), "LeKiwi mesh data includes official camera geometry");
  assert(/moving_jaw/.test(meshKeys), "LeKiwi mesh data includes official gripper jaw geometry");

  const measurement = measureOfficialMeshBounds(meshData);
  assert(measurement.groups[meshData.gripper.node], "LeKiwi gripper node exists in the generated chain");
  assertBakedBboxMatchesComputed(meshData, measurement, "LeKiwi");

  const height = measurement.max[1] - measurement.min[1];
  const width = measurement.max[0] - measurement.min[0];
  const depth = measurement.max[2] - measurement.min[2];
  assert(height > 240 && height < 290, "LeKiwi assembled height is in the expected physical range");
  assert(width > 260 && width < 310, "LeKiwi assembled width is in the expected physical range");
  assert(depth > 380 && depth < 430, "LeKiwi assembled depth is in the expected physical range");
  assert(Number(meshData.groundOffsetMm) > 25 && Number(meshData.groundOffsetMm) < 40, "LeKiwi ground offset places the mobile base on the floor");
}

function testLeKiwiRollingMotionConfig() {
  const configText = fs.readFileSync(path.join(root, "simulator/js/robot-rig-configs.js"), "utf8");
  const previewText = fs.readFileSync(path.join(root, "simulator/js/arm-preview-3d.js"), "utf8");
  const meshData = parseRobotMeshData("simulator/js/robot-mesh-data-lekiwi.js");
  const measurement = measureOfficialMeshBounds(meshData);
  const wheelGroups = [
    "st3215_servo_motor_v1_2_revolute_60",
    "st3215_servo_motor_v1_1_revolute_62",
    "st3215_servo_motor_v1_revolute_64"
  ];
  wheelGroups.forEach((group) => {
    assert(configText.includes(`group: "${group}"`), `LeKiwi rolling config includes ${group}`);
    assert(measurement.groups[group], `LeKiwi official mesh chain includes ${group}`);
  });
  assert(configText.includes("wheelRadiusMm: 48"), "LeKiwi wheel radius is configured from official mesh scale");
  assert(/wheelRadiusMm:\s*48/.test(configText), "LeKiwi wheel radius remains in a realistic range");
  assert(previewText.includes("activeMobileMotion"), "3D preview stores active mobile motion state");
  assert(previewText.includes("wheelSpinById"), "3D preview tracks wheel spin by wheel id");
  assert(previewText.includes("groundOffsetMm") && previewText.includes("groundY"), "driving preserves baked ground offset");
}

[
  testRegistryAndManifests,
  testCommandValidation,
  testBlocklyAndPythonContracts,
  testSimulation,
  testRuntimeBridgeSafety,
  testBridge,
  testSharedGripperSliderSemantics,
  testSo101OfficialMeshTransformSpace,
  testLeKiwiOfficialMeshTransformSpace,
  testLeKiwiRollingMotionConfig
].reduce((chain, test) => (
  chain.then(async () => {
    await test();
    console.log(`ok ${test.name}`);
  })
), Promise.resolve()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
