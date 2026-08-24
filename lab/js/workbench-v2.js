import { escapeHtml } from "./calculations.js";
import { LAB_BOUNDARY_COPY } from "./instructions.js";
import { ROBOT_LABELS } from "./labels.js";
import { createV2Toolbox, compileV2BlocklyProgram, registerV2Blocks } from "../v2/blockly-api.js";
import { ScenarioV2EquipmentScene } from "../v2/equipment-scene.js?v=20260823-physical-fidelity-4";
import { PythonRpcClient } from "../v2/python-rpc.js?v=20260823-physical-fidelity-5";
import { ScenarioV2Engine } from "../v2/scenario-engine.js?v=20260823-physical-fidelity-5";
import { exportLegacyV1Archive, loadPortableV3Draft, loadV2Draft, readPriorV2Draft, resetV2Progress, savePortableV3Draft, saveV2Draft, saveV2Progress } from "../v2/storage.js";

const PORTABLE_ROBOTS = new Set(["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"]);
const PORTABLE_CLAIM = "API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.";

const elements = Object.fromEntries([
  "loading", "error", "title", "subtitle", "robotName", "rank", "assistance", "source", "limitations", "safety",
  "checkpoints", "progress", "feedback", "feedbackCode", "feedbackMessage", "blocklyPanel", "pythonPanel", "blocklyEditor",
  "pythonEditor", "editorStatus", "preview", "previewStage", "previewStatus", "apparatus", "evidence", "commandLog", "taskSelect",
  "backLink", "run", "pause", "stop", "emergencyStop", "reset", "starter", "save", "generatePython", "exportPython", "editorNote",
  "cameraMovement", "cameraZoom", "cameraReset", "cameraInspection", "sceneFullscreen", "live", "exportLegacy"
].map((key) => [key, document.getElementById({
  title: "labWorkbenchTitle", subtitle: "labWorkbenchSubtitle", robotName: "labRobotName", rank: "labRank", assistance: "labAssistance",
  source: "labSourceRefs", limitations: "labLimitations", safety: "labSafetyBoundary", checkpoints: "labCheckpointList", progress: "labProgress",
  feedback: "labFeedback", feedbackCode: "labFeedbackCode", feedbackMessage: "labFeedbackMessage", blocklyPanel: "labBlocklyPanel",
  pythonPanel: "labPythonPanel", blocklyEditor: "labBlocklyEditor", pythonEditor: "labPythonEditor", editorStatus: "labEditorStatus",
  preview: "labRobotPreview", previewStage: "labPreviewStage", previewStatus: "labPreviewStatus", apparatus: "labApparatusBody",
  evidence: "labEvidenceLog", commandLog: "labCommandLog", taskSelect: "labTaskSelect", backLink: "labBackLink", run: "labRun",
  pause: "labPause", stop: "labStop", emergencyStop: "labEmergencyStop", reset: "labReset",
  starter: "labLoadStarter", save: "labSaveDraft", generatePython: "labGeneratePython", cameraMovement: "labCameraMovement",
  cameraZoom: "labCameraZoom", cameraReset: "labCameraReset", cameraInspection: "labCameraInspection", sceneFullscreen: "labSceneFullscreen", live: "labWorkbenchLive",
  exportPython: "labExportPython", editorNote: "labEditorNote", exportLegacy: "labExportLegacy", loading: "labWorkbenchLoading", error: "labWorkbenchError"
}[key] || key)]));

elements.shell = document.getElementById("main-content");
elements.languageTabs = [...document.querySelectorAll("[data-lab-language]")];

const params = new URLSearchParams(window.location.search);
const STAGE_MOUSE_DRAG_THRESHOLD_PX = 6;
const STAGE_ROTATE_SPEED = 0.25;
const STAGE_PAN_SPEED = 0.45;
const app = {
  catalog: null,
  definition: null,
  robotId: params.get("robot") || "arduino_arm",
  taskId: params.get("task") || "",
  language: params.get("language") === "python" ? "python" : "blockly",
  manifest: null,
  simulation: null,
  arduinoPreview: null,
  equipment: null,
  engine: null,
  python: null,
  blockly: null,
  workspace: null,
  running: false,
  paused: false,
  disposed: false,
  lastAnnouncedState: "",
  camera: {
    movement: localStorage.getItem("robobuddy:lab-camera-movement") !== "false",
    zoom: localStorage.getItem("robobuddy:lab-camera-zoom") !== "false",
    inspectionIndex: -1
  }
};

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}.`);
  return response.json();
}

function announce(message) {
  if (!elements.live) return;
  elements.live.textContent = "";
  requestAnimationFrame(() => { elements.live.textContent = message; });
}

function tone(element, value) {
  if (element) element.dataset.tone = value || "ready";
}

function selectedSummary() {
  return app.catalog.tasks.find((task) => task.id === app.taskId && task.robotId === app.robotId) || null;
}

function initializeRegistry() {
  const registry = window.RoboAdmin?.RobotRegistry;
  if (!registry) throw new Error("Robot registry did not load.");
  registry.initialize();
  registry.setActive(app.robotId, { forceEvent: true });
  const manifest = registry.get(app.robotId);
  if (!manifest) throw new Error(`Unknown robot pack: ${app.robotId}.`);
  app.manifest = manifest;
  return manifest;
}

function arduinoPreviewMarkup() {
  return `
    <div class="arm-preview-container arm-preview-container--3d lab-arm-preview">
      <svg viewBox="0 0 310 460" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Arduino arm 3D fallback"></svg>
      <div class="arm-preview-3d" data-arm-preview-3d hidden>
        <div class="arm-preview-3d__viewport" data-arm-preview-3d-viewport role="img" aria-label="Arduino Arm canonical 3D simulator"></div>
        <div class="arm-preview-3d__toolbar"><span class="arm-preview-3d__status" data-arm-preview-3d-status role="status">Loading canonical model...</span></div>
      </div>
      <p class="arm-preview-3d__fallback-status" data-arm-preview-3d-fallback-status role="status" hidden></p>
    </div>`;
}

function activePreview() {
  return app.arduinoPreview || app.simulation?.preview3d || null;
}

function configureStageCameraControls(preview) {
  const controls = preview?.controls;
  const canvas = preview?.renderer?.domElement;
  if (!controls || !canvas) return;

  controls.rotateSpeed = STAGE_ROTATE_SPEED;
  controls.panSpeed = STAGE_PAN_SPEED;
  if (canvas.dataset.labStagePointerGuard === "true") return;
  canvas.dataset.labStagePointerGuard = "true";

  let pendingMouseDrag = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    pendingMouseDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }, true);
  canvas.addEventListener("pointermove", (event) => {
    if (!pendingMouseDrag || event.pointerId !== pendingMouseDrag.pointerId) return;
    const distance = Math.hypot(event.clientX - pendingMouseDrag.x, event.clientY - pendingMouseDrag.y);
    if (distance < STAGE_MOUSE_DRAG_THRESHOLD_PX) event.stopImmediatePropagation();
    else pendingMouseDrag = null;
  }, true);
  const releasePendingDrag = (event) => {
    if (pendingMouseDrag && event.pointerId === pendingMouseDrag.pointerId) pendingMouseDrag = null;
  };
  canvas.addEventListener("pointerup", releasePendingDrag, true);
  canvas.addEventListener("pointercancel", releasePendingDrag, true);
  canvas.addEventListener("lostpointercapture", releasePendingDrag, true);
}

function initializeSimulation(manifest) {
  const factory = window.RoboAdmin?.RobotSimulation?.createSimulationAdapter;
  if (typeof factory !== "function") throw new Error("Simulation adapter did not load.");
  app.simulation = factory(manifest);
  if (manifest.id === "arduino_arm") {
    elements.preview.innerHTML = arduinoPreviewMarkup();
    const Preview = window.RoboBuddy3DPreview?.ArmPreview3D || window.RoboAdmin?.ArmPreview;
    if (typeof Preview !== "function") throw new Error("Arduino canonical 3D preview did not load.");
    app.arduinoPreview = new Preview(elements.preview.querySelector("svg"), {
      jointLimits: manifest.joints.map((joint) => [joint.min, joint.max]),
      initialAngles: manifest.joints.map((joint) => joint.home),
      cameraPreset: "compact"
    });
  } else {
    elements.preview.dataset.robotCameraPreset = "inspection";
    app.simulation.render(elements.preview, app.simulation.getState());
  }
  const preview = activePreview();
  if (!preview?.scene) throw new Error("Canonical robot preview scene is unavailable.");
  configureStageCameraControls(preview);
  if (preview.canonicalModelRevision !== app.definition.canonicalModel.sourceRevision) {
    throw new Error(`Renderer model revision ${preview.canonicalModelRevision || "missing"} does not match ScenarioV2 revision ${app.definition.canonicalModel.sourceRevision}.`);
  }
  app.equipment = new ScenarioV2EquipmentScene(preview, app.definition);
  elements.preview.setAttribute("aria-label", `${manifest.shortName || manifest.name} canonical model and ScenarioV2 task geometry`);
  applyCameraPreferences();
}

function frameForRole(role, fallback = "") {
  return Object.entries(app.definition.frames).find(([, frame]) => frame.role === role)?.[0] || fallback;
}

function semanticTransportArgs() {
  const object = app.definition.objects[0];
  const contactFrame = frameForRole("contact", object?.initialFrame);
  const destinationFrame = frameForRole("destination", contactFrame);
  const placeFrame = Object.entries(app.definition.frames).find(([, frame]) => frame.role === "contact" && frame.coincidentWith === destinationFrame)?.[0] || "";
  return {
    objectId: object?.id || "object_id",
    approachFrame: frameForRole("approach", contactFrame),
    contactFrame,
    liftFrame: frameForRole("lift", contactFrame),
    destinationFrame,
    placeFrame,
    retreatFrame: frameForRole("retreat", contactFrame),
    effector: app.definition.robotId === "openarm_v2_bimanual" ? "left" : "default"
  };
}

function completeStarterCalls() {
  return app.definition.robotId === "openarm_v2_bimanual" && Array.isArray(app.definition.api?.starterCalls)
    ? app.definition.api.starterCalls
    : [];
}

function pythonForStarterCall(call) {
  const args = call.args || {};
  if (call.method === "skills.transport") {
    const fields = [
      ["approach_frame", args.approachFrame],
      ["contact_frame", args.contactFrame],
      ["lift_frame", args.liftFrame],
      ["destination_frame", args.destinationFrame],
      ["place_frame", args.placeFrame],
      ["retreat_frame", args.retreatFrame],
      ["effector", args.effector]
    ].filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
    return `    await robot.transport(${JSON.stringify(args.objectId)}, ${fields.join(", ")})`;
  }
  if (call.method === "skills.fixture_operation") {
    const fields = [
      ["object_id", args.objectId],
      ["fixture_id", args.fixtureId],
      ["value", args.value]
    ].filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
    return `    await lab.fixture_operation(${JSON.stringify(args.processId)}, ${fields.join(", ")})`;
  }
  if (call.method === "lab.record_evidence") {
    const blank = !String(args.value ?? "").trim();
    return `    await lab.record_evidence(${JSON.stringify(args.requirementId)}, ${JSON.stringify(args.value ?? "")})${blank ? "  # enter your observation" : ""}`;
  }
  return "";
}

function starterPython() {
  if (PORTABLE_ROBOTS.has(app.definition.robotId)) {
    const common = [
      "import json",
      "import time",
      "",
      "with open(\"transport.json\", encoding=\"utf-8\") as stream:",
      "    transport = json.load(stream)",
      "with open(\"workcell.json\", encoding=\"utf-8\") as stream:",
      "    workcell = json.load(stream)",
      ""
    ];
    let setup;
    if (app.definition.robotId === "so101_follower") setup = [
      "from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig",
      "robot = SO101Follower(SO101FollowerConfig(port=transport[\"port\"], cameras={}))"
    ];
    else if (app.definition.robotId === "lekiwi_sim") setup = [
      "from lerobot.robots.lekiwi import LeKiwiClient, LeKiwiClientConfig",
      "robot = LeKiwiClient(LeKiwiClientConfig(remote_ip=transport[\"remote_ip\"], cameras={}))"
    ];
    else setup = [
      "from lerobot.robots.openarm_follower import OpenArmFollowerConfigBase",
      "from lerobot.robots.bi_openarm_follower import BiOpenArmFollower, BiOpenArmFollowerConfig",
      "config = BiOpenArmFollowerConfig(",
      "    left_arm_config=OpenArmFollowerConfigBase(port=transport[\"left_port\"], side=\"left\", cameras={}),",
      "    right_arm_config=OpenArmFollowerConfigBase(port=transport[\"right_port\"], side=\"right\", cameras={}),",
      "    cameras={},",
      ")",
      "robot = BiOpenArmFollower(config)"
    ];
    return [...common, ...setup, "", "robot.connect()", "try:",
      "    for step in workcell[\"reference_actions\"]:",
      "        sent = robot.send_action(step[\"action\"])",
      "        time.sleep(step[\"hold_seconds\"])",
      "        observation = robot.get_observation()",
      "        print(step[\"label\"], observation)",
      "finally:", "    robot.disconnect()"
    ].join("\n");
  }
  const completeCalls = completeStarterCalls();
  if (completeCalls.length) {
    return [
      "async def main(robot, lab):",
      "    frames = await lab.frames()",
      ...completeCalls.map(pythonForStarterCall).filter(Boolean)
    ].join("\n");
  }
  const args = semanticTransportArgs();
  const lines = [
    "async def main(robot, lab):",
    "    frames = await lab.frames()"
  ];
  if (app.definition.robotId === "so101_follower") {
    lines.push(
      "    command_model = await robot.command_model()",
      "    before = await robot.get_observation()",
      "    # Simulation convenience: transport resolves named Cartesian frames with browser IK,",
      "    # then the command trace shows each awaited LeRobot-shaped robot.send_action target.",
      "    # It is not SOFollower's native API or LeRobot's optional kinematic processor."
    );
  }
  lines.push(`    await robot.transport(${JSON.stringify(args.objectId)}, approach_frame=${JSON.stringify(args.approachFrame)}, contact_frame=${JSON.stringify(args.contactFrame)}, lift_frame=${JSON.stringify(args.liftFrame)}, destination_frame=${JSON.stringify(args.destinationFrame)}, place_frame=${JSON.stringify(args.placeFrame)}, retreat_frame=${JSON.stringify(args.retreatFrame)}, effector=${JSON.stringify(args.effector)})`);
  if (app.definition.robotId === "so101_follower") lines.push("    after = await robot.get_observation()");
  const process = app.definition.processModels[0];
  if (process) {
    const fixtureId = process.fixtureId || app.definition.fixtures[0]?.id || "configured_fixture";
    lines.push(`    await lab.fixture_operation(${JSON.stringify(process.id)}, object_id=${JSON.stringify(args.objectId)}, fixture_id=${JSON.stringify(fixtureId)})`);
  }
  app.definition.evidenceRequirements.forEach((requirement) => {
    lines.push(`    await lab.record_evidence(${JSON.stringify(requirement.id)}, "")  # enter your observation`);
  });
  return lines.join("\n");
}

function initializeBlockly() {
  const Blockly = window.Blockly;
  if (!Blockly) throw new Error("Blockly did not load.");
  app.blockly = Blockly;
  registerV2Blocks(Blockly);
  const theme = Blockly.Theme.defineTheme("robobuddyLabV2", {
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: "#f7f9fa", toolboxBackgroundColour: "#eef2f3", toolboxForegroundColour: "#26333c",
      flyoutBackgroundColour: "#ffffff", flyoutForegroundColour: "#26333c", scrollbarColour: "#8b9ba5",
      insertionMarkerColour: "#197d74", insertionMarkerOpacity: 0.35
    }
  });
  app.workspace = Blockly.inject(elements.blocklyEditor, {
    toolbox: createV2Toolbox(app.definition.api.level, app.definition.robotId), theme, renderer: "zelos",
    grid: { spacing: 20, length: 2, colour: "#cad4d9", snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.84, maxScale: 1.35, minScale: 0.45, scaleSpeed: 1.12 },
    trashcan: true, move: { scrollbars: true, drag: true, wheel: true }
  });
  const saved = PORTABLE_ROBOTS.has(app.definition.robotId)
    ? loadPortableV3Draft(app.definition.id, "blockly", "")
    : loadV2Draft(app.definition.id, "blockly", "");
  if (saved) {
    try { Blockly.serialization.workspaces.load(JSON.parse(saved), app.workspace); }
    catch { setEditorStatus("The saved v2 Blockly draft could not be restored.", "warning"); }
  }
}

function serializeBlockly() {
  return JSON.stringify(app.blockly.serialization.workspaces.save(app.workspace));
}

function loadStarterBlocks() {
  app.workspace.clear();
  if (PORTABLE_ROBOTS.has(app.definition.robotId)) {
    const actions = app.definition.portablePython?.referenceActions || [];
    const specs = [];
    for (const step of actions) {
      const action = step.action || {};
      if (app.definition.robotId === "so101_follower") specs.push({ type: "portable_so101_action", fields: {
        PAN: action["shoulder_pan.pos"], LIFT: action["shoulder_lift.pos"], ELBOW: action["elbow_flex.pos"], WRIST_FLEX: action["wrist_flex.pos"], WRIST_ROLL: action["wrist_roll.pos"], GRIPPER: action["gripper.pos"], WAIT: step.hold_seconds
      }});
      else if (app.definition.robotId === "lekiwi_sim") specs.push({ type: "portable_lekiwi_action", fields: {
        PAN: action["arm_shoulder_pan.pos"], LIFT: action["arm_shoulder_lift.pos"], ELBOW: action["arm_elbow_flex.pos"], WRIST_FLEX: action["arm_wrist_flex.pos"], WRIST_ROLL: action["arm_wrist_roll.pos"], GRIPPER: action["arm_gripper.pos"], X: action["x.vel"], Y: action["y.vel"], THETA: action["theta.vel"], WAIT: step.hold_seconds
      }});
      else {
        for (const side of ["left", "right"]) specs.push({ type: "portable_openarm_action", fields: {
          SIDE: side, J1: action[`${side}_joint_1.pos`], J2: action[`${side}_joint_2.pos`], J3: action[`${side}_joint_3.pos`], J4: action[`${side}_joint_4.pos`], J5: action[`${side}_joint_5.pos`], J6: action[`${side}_joint_6.pos`], J7: action[`${side}_joint_7.pos`], GRIPPER: action[`${side}_gripper.pos`], WAIT: side === "right" ? step.hold_seconds : 0
        }});
      }
    }
    specs.push({ type: "portable_observation", fields: {} });
    let previous = null;
    specs.forEach((spec) => {
      const block = app.workspace.newBlock(spec.type);
      Object.entries(spec.fields).forEach(([name, value]) => { if (value !== undefined) block.getField(name)?.setValue(String(value)); });
      block.initSvg(); block.render();
      if (previous?.nextConnection && block.previousConnection) previous.nextConnection.connect(block.previousConnection);
      previous = block;
    });
    app.workspace.getTopBlocks(true)[0]?.moveBy(28, 28);
    app.blockly.svgResize(app.workspace);
    return;
  }
  const completeCalls = completeStarterCalls();
  let specs;
  if (completeCalls.length) {
    specs = completeCalls.flatMap((call) => {
      const args = call.args || {};
      if (call.method === "skills.transport") return [{ type: "v2_transport", fields: {
        OBJECT: args.objectId, APPROACH: args.approachFrame, CONTACT: args.contactFrame, LIFT: args.liftFrame,
        DESTINATION: args.destinationFrame, PLACE: args.placeFrame || "", RETREAT: args.retreatFrame, EFFECTOR: args.effector || ""
      }}];
      if (call.method === "skills.fixture_operation") return [{ type: "v2_fixture_operation", fields: {
        PROCESS: args.processId, OBJECT: args.objectId, FIXTURE: args.fixtureId
      }}];
      if (call.method === "lab.record_evidence") return [{ type: "v2_record_evidence", fields: {
        REQUIREMENT: args.requirementId, VALUE: args.value
      }}];
      return [];
    });
  } else {
    const args = semanticTransportArgs();
    specs = app.definition.robotId === "so101_follower"
      ? [{ type: "v2_so101_command_model", fields: {} }, { type: "v2_so101_observation", fields: {} }]
      : [];
    specs.push({ type: "v2_transport", fields: {
      OBJECT: args.objectId, APPROACH: args.approachFrame, CONTACT: args.contactFrame, LIFT: args.liftFrame,
      DESTINATION: args.destinationFrame, PLACE: args.placeFrame || "", RETREAT: args.retreatFrame, EFFECTOR: args.effector || ""
    }});
    if (app.definition.robotId === "so101_follower") specs.push({ type: "v2_so101_observation", fields: {} });
    const process = app.definition.processModels[0];
    if (process) specs.push({ type: "v2_fixture_operation", fields: { PROCESS: process.id, OBJECT: args.objectId, FIXTURE: process.fixtureId || app.definition.fixtures[0]?.id || "configured_fixture" } });
    app.definition.evidenceRequirements.forEach((requirement) => specs.push({ type: "v2_record_evidence", fields: { REQUIREMENT: requirement.id, VALUE: "" } }));
  }
  let previous = null;
  specs.forEach((spec) => {
    const block = app.workspace.newBlock(spec.type);
    Object.entries(spec.fields).forEach(([name, value]) => block.getField(name)?.setValue(String(value)));
    block.initSvg();
    block.render();
    if (previous?.nextConnection && block.previousConnection) previous.nextConnection.connect(block.previousConnection);
    previous = block;
  });
  app.workspace.getTopBlocks(true)[0]?.moveBy(28, 28);
  app.blockly.svgResize(app.workspace);
}

function populateTaskSelector() {
  const robotLabel = ROBOT_LABELS[app.robotId] || app.robotId;
  const tasks = app.catalog.tasks.filter((task) => task.robotId === app.robotId).sort((a, b) => a.rank - b.rank);
  elements.taskSelect.innerHTML = tasks.map((task) => `<option value="${escapeHtml(task.id)}" data-robot-id="${escapeHtml(app.robotId)}"${task.id === app.taskId ? " selected" : ""}>${task.rank}. ${escapeHtml(task.title)}</option>`).join("");
  elements.taskSelect.setAttribute("aria-label", `Change ${robotLabel} task`);
  elements.taskSelect.title = `${robotLabel} tasks`;
}

function populateDefinition() {
  elements.title.textContent = app.definition.title;
  elements.subtitle.textContent = app.definition.brief;
  elements.robotName.textContent = ROBOT_LABELS[app.definition.robotId] || app.definition.robotId;
  elements.rank.textContent = `Rank ${app.definition.rank} · Class ${app.definition.migration.class}`;
  elements.assistance.textContent = `${app.definition.assistanceLevel} · ${app.definition.api.level}`;
  elements.source.innerHTML = app.definition.provenance.map((entry) => `<code title="${escapeHtml(entry.claim)}">${escapeHtml(entry.label)}</code>`).join(" ");
  const commandBoundary = app.definition.modelClaim.commandInterface
    ? ` Physical correspondence: recognized subsets of ${app.definition.modelClaim.commandInterface.actionKeys.join(", ")} execute in awaited order; Blockly emits all six explicitly. The configured rest pose is not physical home/calibration; browser IK/planning, collision rejection, and interpolation are labeled simulation conveniences, not SOFollower's native API or LeRobot processor validation.`
    : "";
  elements.limitations.textContent = PORTABLE_ROBOTS.has(app.definition.robotId)
    ? `${PORTABLE_CLAIM} Python source compatibility and digital-model fidelity are independently tested. Fidelity tier: reference-calibrated kinematic digital model where source-pinned; response rates and workcell targets are configured. Unsupported: motor/controller/dynamics equivalence; gravity, friction, compliance, backlash, thermal/current/voltage behavior; transport, calibration, cameras and sensing; ROS/DDS/TF/MoveIt; datasets, policies and training; force/torque control, payload and safety certification; undocumented hardware behavior.`
    : `${app.definition.modelClaim.supportedFidelity}.${commandBoundary} Unsupported: ${app.definition.modelClaim.unsupportedPhysics.join("; ")}.`;
  elements.safety.textContent = PORTABLE_ROBOTS.has(app.definition.robotId)
    ? "Browser compatibility modules execute ordinary synchronous Python; they are not upstream hardware packages. Pause is cooperative at bridge, sleep, and supported future boundaries. STOP and the hard timeout terminate CPU-only infinite loops. Objects attach only after modeled FK contact plus a valid gripper condition; stow-before-drive remains a visible learner safety policy. Physical validation pending."
    : `${LAB_BOUNDARY_COPY.full} State changes commit only at modeled contact/process events; configured values are not physical measurements.`;
  elements.backLink.href = `lab-scenarios.html?robot=${encodeURIComponent(app.robotId)}&task=${encodeURIComponent(app.taskId)}`;
  elements.pythonEditor.value = PORTABLE_ROBOTS.has(app.definition.robotId)
    ? loadPortableV3Draft(app.definition.id, "python", "")
    : loadV2Draft(app.definition.id, "python", "");
  elements.pythonEditor.placeholder = starterPython();
  elements.editorNote.innerHTML = PORTABLE_ROBOTS.has(app.definition.robotId)
    ? `Runs a complete synchronous physical-style Python script in Pyodide using browser-provided compatibility modules. <strong>Simulation only; hardware validation pending.</strong>`
    : `Runs a real <code>async main(robot, lab)</code> in Pyodide. The exposed API is bounded by this task's Guided, Builder, or Challenge level.`;
  if (PORTABLE_ROBOTS.has(app.definition.robotId) && (readPriorV2Draft(app.definition.id, "python") || readPriorV2Draft(app.definition.id, "blockly"))) {
    setEditorStatus("A prior async v2 draft remains preserved under its old runtime key. This portable v3 editor will not rewrite it; use the legacy export to retain a copy.", "warning");
  }
  syncInspectionCameraButton();
  populateTaskSelector();
}

function portableProfileFiles() {
  const robotId = app.definition.robotId;
  const transport = robotId === "so101_follower"
    ? { schema: "robobuddy.external-transport-profile.v1", port: "SIMULATED_SO101_PORT", note: "Replace only this external profile for the physical setup." }
    : robotId === "lekiwi_sim"
      ? { schema: "robobuddy.external-transport-profile.v1", remote_ip: "127.0.0.1", note: "Browser transport is simulated; replace this external profile for a physical LeKiwi host." }
      : { schema: "robobuddy.external-transport-profile.v1", left_port: "can0", right_port: "can1", note: "Browser CAN is simulated; replace only this external profile for the physical setup." };
  const defaultAction = robotId === "so101_follower"
    ? { "shoulder_pan.pos": 0, "shoulder_lift.pos": -90, "elbow_flex.pos": 85, "wrist_flex.pos": 72, "wrist_roll.pos": 0, "gripper.pos": 20 }
    : robotId === "lekiwi_sim"
      ? { "arm_shoulder_pan.pos": 0, "arm_shoulder_lift.pos": -90, "arm_elbow_flex.pos": 85, "arm_wrist_flex.pos": 72, "arm_wrist_roll.pos": 0, "arm_gripper.pos": 20, "x.vel": 0, "y.vel": 0, "theta.vel": 0 }
      : { "left_joint_1.pos": 0, "left_joint_2.pos": -20, "left_joint_3.pos": 0, "left_joint_4.pos": 30, "left_joint_5.pos": 0, "left_joint_6.pos": 0, "left_joint_7.pos": 0, "left_gripper.pos": -20, "right_joint_1.pos": 0, "right_joint_2.pos": 20, "right_joint_3.pos": 0, "right_joint_4.pos": 30, "right_joint_5.pos": 0, "right_joint_6.pos": 0, "right_joint_7.pos": 0, "right_gripper.pos": -20 };
  const referenceActions = app.definition.portablePython?.referenceActions || [{ label: "configured safe reference", action: defaultAction, hold_seconds: 1 }];
  return {
    "transport.json": transport,
    "workcell.json": {
      schema: "robobuddy.external-workcell-profile.v1",
      source: "configured browser workcell values; measure and replace for a physical workcell",
      frames: Object.fromEntries(Object.entries(app.definition.frames || {}).map(([id, frame]) => [id, { position_mm: frame.positionMm, role: frame.role, tolerance: frame.tolerance }])),
      reference_actions: referenceActions
    }
  };
}

function readableId(value = "") {
  return String(value).replace(/^hidden:/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function objectLabel(id) {
  return app.definition.objects?.find((item) => item.id === id)?.label || readableId(id);
}

function frameLabel(id) {
  return app.definition.frames?.[id]?.label || readableId(id);
}

function predicateLabel(predicate = {}) {
  if (predicate.label || predicate.description) return predicate.label || predicate.description;
  if (predicate.op === "object_at") return `Place ${objectLabel(predicate.objectId)} at ${frameLabel(predicate.frameId)}`;
  if (predicate.op === "frame_visited") return `Reach ${frameLabel(predicate.frameId)}`;
  if (predicate.op === "object_attached") return `Secure ${objectLabel(predicate.objectId)} with ${readableId(predicate.effector || "the gripper")}`;
  if (predicate.op === "object_detached") return `Release ${objectLabel(predicate.objectId)} at the intended contact pose`;
  if (predicate.op === "process_state") return `${readableId(predicate.processId)}: ${readableId(predicate.value || predicate.state)}`;
  if (predicate.op === "event_exists") return `Confirm ${readableId(predicate.eventType || predicate.type)} from live simulation state`;
  if (predicate.op === "not") return `Avoid: ${predicateLabel(predicate.predicate)}`;
  return `Confirm ${readableId(predicate.op || "task outcome")}`;
}

function renderGoals(state) {
  const rows = [
    ...state.grade.goals.map((goal) => ({ id: goal.id, complete: goal.passed, label: predicateLabel(goal.predicate) })),
    ...state.grade.evidence.map((evidence) => ({ id: evidence.id, complete: evidence.passed, label: evidence.requirement.label || evidence.requirement.prompt || `Required evidence: ${evidence.id}` })),
    ...(state.grade.hidden || []).map((requirement) => ({ id: `hidden:${requirement.id}`, complete: requirement.passed, label: requirement.requirement.label || requirement.requirement.prompt || `Simulator check: ${readableId(requirement.id)}` }))
  ];
  const activeIndex = rows.findIndex((row) => !row.complete);
  elements.checkpoints.innerHTML = rows.map((row, index) => `
    <li class="lab-checkpoint" data-status="${row.complete ? "complete" : index === activeIndex ? "active" : "pending"}"${index === activeIndex ? ' aria-current="step"' : ""}>
      <span class="lab-checkpoint__index" data-readout>${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHtml(row.label)}</strong><small>${row.complete ? "Verified by authoritative state" : index === activeIndex ? "Current checkpoint" : "Follows the current checkpoint"}</small></span>
      <span class="lab-checkpoint__state">${row.complete ? "complete" : index === activeIndex ? "current" : "pending"}</span>
    </li>`).join("");
  const complete = rows.filter((row) => row.complete).length;
  elements.progress.textContent = `${complete} / ${rows.length}`;
}

function renderEvidence(state) {
  const items = state.evidence.slice().reverse();
  elements.evidence.innerHTML = items.length ? items.map((entry) => `
    <li class="lab-evidence" data-provenance="R"><span class="lab-provenance">R</span><strong>${escapeHtml(entry.requirementId)}</strong><span>${escapeHtml(entry.value)}</span></li>`).join("")
    : `<li class="lab-empty">No learner evidence recorded.</li>`;
}

function renderObjects(state) {
  elements.apparatus.innerHTML = Object.values(state.objects).map((item) => {
    const location = item.attachedTo ? `Attached to ${item.attachedTo}` : item.currentFrame || "unplaced";
    const process = Object.values(state.processes).filter((entry) => entry.objectId === item.id).map((entry) => entry.state).join(" · ");
    return `<tr><th scope="row">${escapeHtml(item.label || item.id)}</th><td>${escapeHtml(location)}</td><td>${escapeHtml(item.contentsCategory || item.contents || "configured")}</td><td>${escapeHtml(item.state?.temperature || "not modeled")}</td><td>${escapeHtml(item.state?.condition || item.state?.cleanliness || "configured")}</td><td>${escapeHtml(process || item.state?.transferState || "unchanged")}</td></tr>`;
  }).join("");
}

function renderCommands(state) {
  const items = state.commandLog.slice(-16).reverse();
  elements.commandLog.innerHTML = items.length ? items.map((entry) => `
    <li data-tone="${entry.ok ? "ready" : "error"}"><code>${String(entry.index).padStart(2, "0")}</code><span><strong>${escapeHtml(entry.method)}</strong><small>${escapeHtml(entry.message)}</small></span><span>${escapeHtml(entry.code)}</span></li>`).join("")
    : `<li class="lab-empty">Run Python or Blockly to populate API calls.</li>`;
}

function setCollapsibleExpanded(bodyId, expanded) {
  const body = document.getElementById(bodyId);
  const button = document.querySelector(`[data-lab-collapse][aria-controls="${bodyId}"]`);
  if (!body || !button) return;
  body.hidden = !expanded;
  button.setAttribute("aria-expanded", String(expanded));
}

function syncPreview(state) {
  if (!state || !app.simulation) return;
  if (app.arduinoPreview) {
    const angles = app.manifest.joints.map((joint) => Number(state.jointState[joint.id] ?? joint.home ?? 0));
    app.arduinoPreview.setAngles(angles);
  } else {
    const preview = activePreview();
    const simulationState = app.simulation.getState();
    const next = { ...simulationState, joints: { ...simulationState.joints, ...state.jointState } };
    if (app.definition.robotId === "lekiwi_sim") {
      const scale = Number(preview?.config?.mobileBase?.positionScale) || 1000;
      next.mobileBase = { x: state.rootPose.positionMm[0] / scale, y: -state.rootPose.positionMm[2] / scale, theta: state.rootPose.headingDeg };
    }
    if (app.definition.robotId === "unitree_g1_29dof") {
      next.humanoidRoot = { x: state.rootPose.positionMm[0] / 1000, z: state.rootPose.positionMm[2] / 1000, theta: state.rootPose.headingDeg };
    }
    preview?.updateState?.(next);
  }
  syncFollowingInspectionCamera(state);
  app.equipment?.update(state);
  const correspondence = app.equipment?.effectorFrameCorrespondence?.(state.lastReachedFrame);
  if (correspondence) {
    elements.preview.dataset.rendererFrame = correspondence.frameId;
    elements.preview.dataset.rendererErrorMm = correspondence.errorMm.toFixed(3);
    elements.preview.dataset.rendererActualMm = correspondence.actual.map((value) => value.toFixed(3)).join(",");
    elements.preview.dataset.rendererExpectedMm = correspondence.expected.map((value) => value.toFixed(3)).join(",");
  } else {
    delete elements.preview.dataset.rendererFrame;
    delete elements.preview.dataset.rendererErrorMm;
    delete elements.preview.dataset.rendererActualMm;
    delete elements.preview.dataset.rendererExpectedMm;
  }
}

function renderState(state = app.engine?.snapshot()) {
  if (!state) return;
  renderGoals(state);
  renderEvidence(state);
  renderObjects(state);
  renderCommands(state);
  syncPreview(state);
  const fault = app.engine?.plant?.fault || state.plant?.fault || (state.runState === "fault" ? state.feedback?.details : null);
  const passed = state.grade.passed && !fault;
  const paused = app.paused || state.runState === "paused";
  const running = app.running || state.runState === "running";
  const stopped = state.runState === "stopped";
  const feedback = fault
    ? {
      code: fault.code || "SIMULATOR_FAULT",
      message: `Motion stopped at the last safe pose: ${fault.collision?.robotProxyId || "robot geometry"} contacted ${fault.collision?.obstacleId || "configured workcell geometry"}. Reset Task, inspect the route and contact pose, then retry.`,
      tone: "error"
    }
    : passed
    ? { code: state.grade.code, message: "Observable outcomes, safety constraints, causal constraints, and evidence all pass.", tone: "success" }
    : state.feedback || { code: "READY", message: "Scenario v2 is ready.", tone: "ready" };
  elements.feedbackCode.textContent = feedback.code;
  elements.feedbackMessage.textContent = feedback.message;
  tone(elements.feedback, passed ? "success" : feedback.tone);
  const held = Object.values(state.objects).find((item) => item.attachedTo);
  const stateLabel = fault ? "Collision fault" : passed ? "Success" : paused ? "Paused" : running ? "Running" : stopped ? "Stopped" : "Ready";
  const frameLabel = state.lastReachedFrame ? readableId(state.lastReachedFrame) : "No task frame reached";
  elements.previewStatus.textContent = `${stateLabel} · ${frameLabel} · ${held ? `${objectLabel(held.id)} attached after live contact` : "No object attached"}`;
  tone(elements.previewStatus, fault ? "error" : passed ? "success" : paused || stopped ? "warning" : running ? "running" : "ready");
  elements.previewStage.dataset.runState = fault ? "fault" : passed ? "complete" : paused ? "paused" : running ? "running" : stopped ? "stopped" : "ready";
  elements.previewStage.setAttribute("aria-busy", String(running && !paused));
  if (fault) setCollapsibleExpanded("labCommandPanel", true);
  const announcementKey = `${stateLabel}:${feedback.code}`;
  if (announcementKey !== app.lastAnnouncedState) {
    app.lastAnnouncedState = announcementKey;
    announce(`${stateLabel}. ${feedback.message}`);
  }
  updateControls();
}

function setEditorStatus(message, value = "ready") {
  elements.editorStatus.textContent = message;
  tone(elements.editorStatus, value);
}

function updateControls() {
  const state = app.engine?.snapshot?.();
  const fault = app.engine?.plant?.fault || state?.plant?.fault || state?.runState === "fault";
  const stopped = state?.runState === "stopped";
  const needsReset = Boolean(fault || stopped);
  elements.run.disabled = app.running || needsReset;
  elements.pause.disabled = !app.running;
  elements.stop.disabled = !app.running;
  elements.emergencyStop.disabled = !app.running;
  elements.pause.setAttribute("aria-pressed", String(app.paused));
  elements.pause.querySelector("span").textContent = app.paused ? "Resume" : "Pause";
  elements.run.classList.toggle("lab-button--primary", !needsReset);
  elements.reset.classList.toggle("lab-button--primary", needsReset);
  elements.generatePython.hidden = app.language !== "blockly";
}

function saveDrafts() {
  if (!app.definition) return false;
  const save = PORTABLE_ROBOTS.has(app.definition.robotId) ? savePortableV3Draft : saveV2Draft;
  const blocklySaved = app.workspace ? save(app.definition.id, "blockly", serializeBlockly()) : true;
  const pythonSaved = save(app.definition.id, "python", elements.pythonEditor.value);
  return blocklySaved && pythonSaved;
}

function switchLanguage(language, initial = false) {
  if (!initial) saveDrafts();
  app.language = language === "python" ? "python" : "blockly";
  elements.languageTabs.forEach((tab) => {
    const active = tab.dataset.labLanguage === app.language;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  elements.blocklyPanel.hidden = app.language !== "blockly";
  elements.pythonPanel.hidden = app.language !== "python";
  const url = new URL(location.href);
  url.searchParams.set("language", app.language);
  history.replaceState({}, "", url);
  if (app.language === "blockly") setTimeout(() => app.blockly?.svgResize(app.workspace), 0);
  updateControls();
}

function runtimeErrorMessage(error) {
  const fault = app.engine?.plant?.fault;
  if (fault) return `Motion stopped at the last safe pose: ${fault.collision?.robotProxyId || "robot geometry"} contacted ${fault.collision?.obstacleId || "configured workcell geometry"}. Reset Task, inspect the route and contact pose, then retry.`;
  const code = String(error.code || "PYTHON_ERROR");
  if (code === "STOPPED") return "Run stopped at the last valid state. Reset Task before running again; your draft is preserved.";
  if (/TIMEOUT/i.test(code) || /timed out/i.test(error.message || "")) return "Execution timed out and was stopped. Check for an infinite loop or a missing bounded sleep, then Reset Task and retry.";
  if (/JSPI|UNSUPPORTED_BROWSER|PYODIDE_UNAVAILABLE/i.test(code)) return "This browser cannot run the required Pyodide/JSPI bridge. Use a current supported Chrome or Edge build; your draft remains saved locally.";
  if (/UNSUPPORTED|CAMERAS|SENSING|CUSTOM_GAINS/i.test(code)) return `${code}: ${error.message} Remove the unsupported hardware-only option and run again.`;
  return `${code}: ${error.message}`;
}

async function runProgram() {
  if (app.running) return;
  let program;
  try {
    program = app.language === "blockly" ? compileV2BlocklyProgram(app.workspace, { robotId: app.definition.robotId }) : elements.pythonEditor.value;
    if (!String(program).trim()) throw new Error(PORTABLE_ROBOTS.has(app.definition.robotId) ? "Add a complete synchronous physical-style Python program before running." : "Add an async main(robot, lab) program before running.");
  } catch (error) {
    setEditorStatus(error.message, "error");
    return;
  }
  saveDrafts();
  app.running = true;
  app.paused = false;
  setEditorStatus(PORTABLE_ROBOTS.has(app.definition.robotId) ? "Executing the whole synchronous Python script through the pinned browser compatibility modules..." : "Executing Python asynchronously in Pyodide against ScenarioV2...", "running");
  renderState();
  try {
    const portable = PORTABLE_ROBOTS.has(app.definition.robotId);
    const result = await app.python.run(program, {
      apiLevel: app.definition.api.level,
      // A complete portable reference performs real approach, contact, lift,
      // transfer, placement, opening, and retreat waits against the fixed
      // 20 ms plant. Keep a bounded guard, but do not terminate a legitimate
      // two-hand physical sequence at the shorter guided-API budget.
      timeoutMs: portable ? 240000 : 60000,
      robotId: app.definition.robotId,
      profileFiles: portable ? portableProfileFiles() : {},
    });
    const state = app.engine.snapshot();
    saveV2Progress(app.definition.id, { grade: state.grade, updatedAt: new Date().toISOString(), freshV2: true });
    const stdout = String(result.stdout || "").trim();
    setEditorStatus(state.grade.passed ? "Run completed: outcome and evidence assessment passed." : `Python completed; assessment remains incomplete.${stdout ? ` Output: ${stdout}` : ""}`, state.grade.passed ? "success" : "warning");
  } catch (error) {
    const stopped = error.code === "STOPPED";
    setEditorStatus(runtimeErrorMessage(error), stopped ? "warning" : "error");
    setCollapsibleExpanded("labCommandPanel", true);
  } finally {
    app.running = false;
    app.paused = false;
    renderState();
  }
}

async function togglePause() {
  if (!app.running) return;
  app.paused = !app.paused;
  if (app.paused) {
    app.python.pause();
    await app.engine.call("robot.pause", {});
    setEditorStatus("Paused at the last executed trajectory sample.", "warning");
  } else {
    await app.engine.call("robot.resume", {});
    app.python.resume();
    setEditorStatus("Execution resumed.", "running");
  }
  renderState();
}

async function stopRun(reason = "user") {
  const result = await app.engine.call("robot.stop", { reason });
  app.python.cancel(reason);
  app.running = false;
  app.paused = false;
  renderState(result.state);
  setEditorStatus("Stopped. The last executed joint sample is retained; attachment changes occur only after contact.", "warning");
  announce("Simulation stopped at the last executed sample.");
}

async function resetTask() {
  if (app.running) await stopRun("reset");
  const result = await app.engine.call("robot.reset", {});
  resetV2Progress(app.definition.id);
  app.lastAnnouncedState = "";
  renderState(result.state);
  setEditorStatus("Fresh v2 state restored. Drafts, camera preferences, and read-only v1 data were preserved.", "ready");
}

function loadStarter() {
  if (app.language === "python") elements.pythonEditor.value = starterPython();
  else loadStarterBlocks();
  saveDrafts();
  setEditorStatus("ScenarioV2 starter loaded. Inspect named frames and adapt it to the observable goal.", "ready");
}

function generatePython() {
  try {
    elements.pythonEditor.value = compileV2BlocklyProgram(app.workspace, { robotId: app.definition.robotId });
    (PORTABLE_ROBOTS.has(app.definition.robotId) ? savePortableV3Draft : saveV2Draft)(app.definition.id, "python", elements.pythonEditor.value);
    switchLanguage("python");
    setEditorStatus(PORTABLE_ROBOTS.has(app.definition.robotId) ? "Blockly compiled to complete synchronous physical-style Python. Review, edit, or export it before running." : "Blockly compiled to real async Python. Review before running.", "ready");
  } catch (error) { setEditorStatus(error.message, "error"); }
}

function exportPython() {
  let source;
  try {
    source = app.language === "blockly"
      ? compileV2BlocklyProgram(app.workspace, { robotId: app.definition.robotId })
      : elements.pythonEditor.value;
    if (!String(source).trim()) throw new Error("Load or write a Python program before exporting.");
  } catch (error) {
    setEditorStatus(error.message, "error");
    return;
  }
  const blob = new Blob([source.endsWith("\n") ? source : `${source}\n`], { type: "text/x-python;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${app.definition.id.replace(/[^a-z0-9_-]+/gi, "-")}.py`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setEditorStatus(`Exported ${link.download}. The source uses the documented browser compatibility profile; hardware validation remains pending.`, "success");
  announce(`Python source exported as ${link.download}.`);
}

function setCameraControl(name, enabled) {
  app.camera[name] = Boolean(enabled);
  const preview = activePreview();
  if (name === "movement") preview?.setCameraMovementEnabled?.(app.camera[name]);
  else preview?.setCameraZoomEnabled?.(app.camera[name]);
  localStorage.setItem(`robobuddy:lab-camera-${name}`, String(app.camera[name]));
  const button = name === "movement" ? elements.cameraMovement : elements.cameraZoom;
  button.setAttribute("aria-pressed", String(app.camera[name]));
  button.querySelector("span").textContent = `${name === "movement" ? "Move view" : "Zoom"}: ${app.camera[name] ? "on" : "off"}`;
  button.setAttribute("aria-label", `Camera ${name} ${app.camera[name] ? "on" : "off"}`);
}

function applyCameraPreferences() {
  setCameraControl("movement", app.camera.movement);
  setCameraControl("zoom", app.camera.zoom);
}

function resetCamera() {
  const preview = activePreview();
  preview?.camera?.up?.set?.(0, 1, 0);
  if (preview?.resetCamera) preview.resetCamera();
  else {
    const points = Object.values(app.definition.frames).map((frame) => frame.positionMm);
    const target = points.reduce((sum, point) => sum.map((value, index) => value + point[index] / points.length), [0, 0, 0]);
    preview?.controls?.target?.set(...target);
    preview?.camera?.position?.set(target[0] + 660, target[1] + 460, target[2] + 720);
    preview?.controls?.update?.();
  }
  app.camera.inspectionIndex = -1;
  syncInspectionCameraButton();
}

const SO101_INSPECTION_VIEWS = Object.freeze([
  { name: "front", position: [140, 240, 850], target: [140, 105, -35], up: [0, 1, 0] },
  { name: "top", position: [140, 900, -35], target: [140, 30, -35], up: [0, 0, -1] },
  { name: "close", offset: [230, 150, 330], target: [140, 105, -35], followActiveFrame: true, up: [0, 1, 0] },
  { name: "oblique", position: [540, 410, 720], target: [140, 105, -35], up: [0, 1, 0] }
]);

const OPENARM_INSPECTION_VIEWS = Object.freeze([
  { name: "left gripper outside", position: [-120, 720, -940], target: [448, 457, -345], up: [0, 1, 0] },
  { name: "left gripper inside", position: [880, 590, 120], target: [448, 457, -345], up: [0, 1, 0] },
  { name: "right gripper outside", position: [-120, 720, 940], target: [448, 457, 345], up: [0, 1, 0] },
  { name: "right gripper inside", position: [880, 590, -120], target: [448, 457, 345], up: [0, 1, 0] },
  { name: "bimanual top", position: [450, 1500, 0], target: [448, 410, 0], up: [0, 0, -1] },
]);

const LEKIWI_INSPECTION_VIEWS = Object.freeze([
  { name: "mobile front", offset: [320, 230, 430], followMobileBase: true, targetHeightMm: 115, up: [0, 1, 0] },
  { name: "mobile side", offset: [470, 190, 0], followMobileBase: true, targetHeightMm: 115, up: [0, 1, 0] },
  { name: "mobile rear", offset: [-310, 220, -420], followMobileBase: true, targetHeightMm: 115, up: [0, 1, 0] },
  { name: "mobile top", offset: [0, 720, 0], followMobileBase: true, targetHeightMm: 30, up: [0, 0, -1] },
]);

function inspectionViews() {
  if (app.definition?.robotId === "so101_follower") return { robot: "SO-101", views: SO101_INSPECTION_VIEWS };
  if (app.definition?.robotId === "lekiwi_sim") return { robot: "LeKiwi", views: LEKIWI_INSPECTION_VIEWS };
  if (app.definition?.robotId === "openarm_v2_bimanual") return { robot: "OpenArm", views: OPENARM_INSPECTION_VIEWS };
  return null;
}

function inspectionViewTarget(view, state) {
  if (view?.followMobileBase && state?.rootPose?.positionMm) {
    return [
      Number(state.rootPose.positionMm[0]),
      Number(view.targetHeightMm ?? 115),
      Number(state.rootPose.positionMm[2]),
    ];
  }
  const activeFrame = view?.followActiveFrame ? app.definition?.frames?.[state?.lastReachedFrame] : null;
  return activeFrame?.positionMm || view?.target;
}

function applyInspectionView(view, state) {
  const preview = activePreview();
  if (!view || !preview?.camera || !preview?.controls) return false;
  const target = inspectionViewTarget(view, state);
  if (!target) return false;
  const position = view.offset ? target.map((value, index) => value + view.offset[index]) : view.position;
  preview.camera.up.set(...view.up);
  preview.camera.position.set(...position);
  preview.controls.target.set(...target);
  preview.controls.update();
  return true;
}

function syncFollowingInspectionCamera(state) {
  const inspection = inspectionViews();
  const view = inspection?.views?.[app.camera.inspectionIndex];
  if (!view?.followMobileBase) return;
  applyInspectionView(view, state);
}

function syncInspectionCameraButton() {
  if (!elements.cameraInspection) return;
  const inspection = inspectionViews();
  elements.cameraInspection.hidden = !inspection;
  if (!inspection) return;
  const nextIndex = (app.camera.inspectionIndex + 1) % inspection.views.length;
  const nextName = inspection.views[nextIndex].name;
  elements.cameraInspection.querySelector("span").textContent = `Next view: ${nextName}`;
  elements.cameraInspection.setAttribute("aria-label", `Show ${inspection.robot} ${nextName} inspection view`);
  elements.cameraInspection.title = `Show ${inspection.robot} ${nextName} inspection view`;
}

function cycleInspectionCamera() {
  const inspection = inspectionViews();
  if (!inspection) return;
  const preview = activePreview();
  if (!preview?.camera || !preview?.controls) return;
  app.camera.inspectionIndex = (app.camera.inspectionIndex + 1) % inspection.views.length;
  const view = inspection.views[app.camera.inspectionIndex];
  const state = app.engine?.snapshot?.();
  if (!applyInspectionView(view, state)) return;
  preview.resize?.();
  syncInspectionCameraButton();
  renderState(state);
  announce(`${inspection.robot} ${view.name} inspection view shown. Robot and scenario state were unchanged.`);
}

async function toggleFullscreen() {
  if (!document.fullscreenEnabled || !elements.previewStage.requestFullscreen) return;
  if (document.fullscreenElement === elements.previewStage) await document.exitFullscreen();
  else await elements.previewStage.requestFullscreen();
}

function syncFullscreen() {
  const expanded = document.fullscreenElement === elements.previewStage;
  elements.sceneFullscreen.setAttribute("aria-expanded", String(expanded));
  elements.sceneFullscreen.querySelector("span").textContent = expanded ? "Exit expanded scene" : "Expand scene";
  activePreview()?.resize?.();
}

function exportLegacy() {
  const blob = new Blob([exportLegacyV1Archive()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `robobuddy-lab-v1-read-only-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  announce("Read-only legacy v1 browser data exported. It was not reinterpreted as v2 progress.");
}

function bindEvents() {
  elements.languageTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => switchLanguage(tab.dataset.labLanguage));
    tab.addEventListener("keydown", (event) => {
      let nextIndex = index;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) nextIndex = (index + 1) % elements.languageTabs.length;
      else if (["ArrowLeft", "ArrowUp"].includes(event.key)) nextIndex = (index - 1 + elements.languageTabs.length) % elements.languageTabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = elements.languageTabs.length - 1;
      else return;
      event.preventDefault();
      const next = elements.languageTabs[nextIndex];
      switchLanguage(next.dataset.labLanguage);
      next.focus();
    });
  });
  elements.run.addEventListener("click", runProgram);
  elements.pause.addEventListener("click", togglePause);
  [elements.stop, elements.emergencyStop].forEach((button) => button.addEventListener("click", () => stopRun("user")));
  elements.reset.addEventListener("click", resetTask);
  elements.starter.addEventListener("click", loadStarter);
  elements.save.addEventListener("click", () => setEditorStatus(saveDrafts() ? "Separate v2 drafts saved in this browser." : "Draft storage unavailable.", "ready"));
  elements.generatePython.addEventListener("click", generatePython);
  elements.exportPython.addEventListener("click", exportPython);
  elements.cameraMovement.addEventListener("click", () => setCameraControl("movement", !app.camera.movement));
  elements.cameraZoom.addEventListener("click", () => setCameraControl("zoom", !app.camera.zoom));
  elements.cameraReset.addEventListener("click", resetCamera);
  elements.cameraInspection?.addEventListener("click", cycleInspectionCamera);
  elements.sceneFullscreen.addEventListener("click", toggleFullscreen);
  elements.exportLegacy?.addEventListener("click", exportLegacy);
  document.addEventListener("fullscreenchange", syncFullscreen);
  elements.taskSelect.addEventListener("change", () => {
    const option = elements.taskSelect.selectedOptions[0];
    const url = new URL(location.href);
    url.searchParams.set("robot", option.dataset.robotId);
    url.searchParams.set("task", option.value);
    location.href = url;
  });
  document.querySelectorAll("[data-lab-collapse]").forEach((button) => button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    const body = document.getElementById(button.getAttribute("aria-controls"));
    if (body) body.hidden = expanded;
  }));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.running) { if (!document.fullscreenElement) event.preventDefault(); void stopRun("escape"); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveDrafts(); setEditorStatus("Separate v2 drafts saved.", "ready"); }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void runProgram(); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); void togglePause(); }
  });
  window.addEventListener("beforeunload", () => { app.disposed = true; saveDrafts(); app.python?.dispose(); app.equipment?.dispose(); app.simulation?.dispose?.(); });
}

async function init() {
  try {
    app.catalog = await fetchJson("missions/lab-assistant/v2/index.json");
    if (app.catalog.schema !== "robobuddy.lab-catalog.v2") throw new Error("The ScenarioV2 catalog schema is unavailable.");
    let summary = selectedSummary();
    if (!summary) summary = app.catalog.tasks[0];
    if (!summary) throw new Error("The ScenarioV2 catalog contains no tasks.");
    app.robotId = summary.robotId;
    app.taskId = summary.id;
    app.definition = await fetchJson(summary.definition);
    populateDefinition();
    const manifest = initializeRegistry();
    initializeSimulation(manifest);
    app.engine = await ScenarioV2Engine.create(app.definition, {
      intervalMs: 34,
      autoStartPlant: true,
      onSample: (_sample, _index, state) => renderState(state),
      onEvent: (_event, _context, state) => renderState(state)
    });
    app.python = new PythonRpcClient({ apiHandler: async (method, args) => {
      const response = await app.engine.call(method, args);
      renderState(response.state);
      if (method.startsWith("compat.")) {
        if (!response.ok) {
          const error = new Error(response.message);
          error.code = response.code;
          throw error;
        }
        return response.publicResult ?? null;
      }
      return response;
    }, timeoutMs: 60000 });
    initializeBlockly();
    bindEvents();
    switchLanguage(app.language, true);
    renderState();
    elements.loading.hidden = true;
    elements.shell.hidden = false;
    if (window.lucide) window.lucide.createIcons();
  } catch (error) {
    console.error(error);
    elements.loading.hidden = true;
    elements.error.hidden = false;
    elements.error.querySelector("p").textContent = `${error.message} Serve RoboBuddy over HTTP and verify the v2 catalog was generated.`;
  }
}

init();
