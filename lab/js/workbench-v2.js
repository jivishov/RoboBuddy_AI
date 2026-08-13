import { escapeHtml } from "./calculations.js";
import { LAB_BOUNDARY_COPY } from "./instructions.js";
import { ROBOT_LABELS } from "./labels.js";
import { createV2Toolbox, compileV2BlocklyProgram, registerV2Blocks } from "../v2/blockly-api.js";
import { ScenarioV2EquipmentScene } from "../v2/equipment-scene.js";
import { PythonRpcClient } from "../v2/python-rpc.js";
import { ScenarioV2Engine } from "../v2/scenario-engine.js";
import { exportLegacyV1Archive, loadV2Draft, resetV2Progress, saveV2Draft, saveV2Progress } from "../v2/storage.js";

const elements = Object.fromEntries([
  "loading", "error", "title", "subtitle", "robotName", "rank", "assistance", "source", "limitations", "safety",
  "checkpoints", "progress", "feedback", "feedbackCode", "feedbackMessage", "blocklyPanel", "pythonPanel", "blocklyEditor",
  "pythonEditor", "editorStatus", "preview", "previewStage", "previewStatus", "apparatus", "evidence", "commandLog", "taskSelect",
  "backLink", "run", "pause", "stop", "emergencyStop", "stageStop", "reset", "starter", "save", "generatePython",
  "cameraMovement", "cameraZoom", "cameraReset", "sceneFullscreen", "live", "exportLegacy"
].map((key) => [key, document.getElementById({
  title: "labWorkbenchTitle", subtitle: "labWorkbenchSubtitle", robotName: "labRobotName", rank: "labRank", assistance: "labAssistance",
  source: "labSourceRefs", limitations: "labLimitations", safety: "labSafetyBoundary", checkpoints: "labCheckpointList", progress: "labProgress",
  feedback: "labFeedback", feedbackCode: "labFeedbackCode", feedbackMessage: "labFeedbackMessage", blocklyPanel: "labBlocklyPanel",
  pythonPanel: "labPythonPanel", blocklyEditor: "labBlocklyEditor", pythonEditor: "labPythonEditor", editorStatus: "labEditorStatus",
  preview: "labRobotPreview", previewStage: "labPreviewStage", previewStatus: "labPreviewStatus", apparatus: "labApparatusBody",
  evidence: "labEvidenceLog", commandLog: "labCommandLog", taskSelect: "labTaskSelect", backLink: "labBackLink", run: "labRun",
  pause: "labPause", stop: "labStop", emergencyStop: "labEmergencyStop", stageStop: "labStageStop", reset: "labReset",
  starter: "labLoadStarter", save: "labSaveDraft", generatePython: "labGeneratePython", cameraMovement: "labCameraMovement",
  cameraZoom: "labCameraZoom", cameraReset: "labCameraReset", sceneFullscreen: "labSceneFullscreen", live: "labWorkbenchLive",
  exportLegacy: "labExportLegacy", loading: "labWorkbenchLoading", error: "labWorkbenchError"
}[key] || key)]));

elements.shell = document.getElementById("main-content");
elements.languageTabs = [...document.querySelectorAll("[data-lab-language]")];

const params = new URLSearchParams(window.location.search);
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
  camera: {
    movement: localStorage.getItem("robobuddy:lab-camera-movement") !== "false",
    zoom: localStorage.getItem("robobuddy:lab-camera-zoom") !== "false"
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
  return {
    objectId: object?.id || "object_id",
    approachFrame: frameForRole("approach", contactFrame),
    contactFrame,
    liftFrame: frameForRole("lift", contactFrame),
    destinationFrame: frameForRole("destination", contactFrame),
    retreatFrame: frameForRole("retreat", contactFrame),
    effector: app.definition.robotId === "openarm_v2_bimanual" ? "left" : "default",
    seed: 17
  };
}

function starterPython() {
  const args = semanticTransportArgs();
  const lines = [
    "async def main(robot, lab):",
    "    frames = await lab.frames()",
    `    await robot.transport(${JSON.stringify(args.objectId)}, approach_frame=${JSON.stringify(args.approachFrame)}, contact_frame=${JSON.stringify(args.contactFrame)}, lift_frame=${JSON.stringify(args.liftFrame)}, destination_frame=${JSON.stringify(args.destinationFrame)}, retreat_frame=${JSON.stringify(args.retreatFrame)}, effector=${JSON.stringify(args.effector)}, seed=17)`
  ];
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
    toolbox: createV2Toolbox(app.definition.api.level), theme, renderer: "zelos",
    grid: { spacing: 20, length: 2, colour: "#cad4d9", snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.84, maxScale: 1.35, minScale: 0.45, scaleSpeed: 1.12 },
    trashcan: true, move: { scrollbars: true, drag: true, wheel: true }
  });
  const saved = loadV2Draft(app.definition.id, "blockly", "");
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
  const args = semanticTransportArgs();
  const specs = [{ type: "v2_transport", fields: {
    OBJECT: args.objectId, APPROACH: args.approachFrame, CONTACT: args.contactFrame, LIFT: args.liftFrame,
    DESTINATION: args.destinationFrame, RETREAT: args.retreatFrame, EFFECTOR: args.effector
  }}];
  const process = app.definition.processModels[0];
  if (process) specs.push({ type: "v2_fixture_operation", fields: { PROCESS: process.id, OBJECT: args.objectId, FIXTURE: process.fixtureId || app.definition.fixtures[0]?.id || "configured_fixture" } });
  app.definition.evidenceRequirements.forEach((requirement) => specs.push({ type: "v2_record_evidence", fields: { REQUIREMENT: requirement.id, VALUE: "" } }));
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
  elements.taskSelect.innerHTML = app.catalog.robots.map((robot) => {
    const tasks = app.catalog.tasks.filter((task) => task.robotId === robot.id).sort((a, b) => a.rank - b.rank);
    return `<optgroup label="${escapeHtml(ROBOT_LABELS[robot.id] || robot.id)}">${tasks.map((task) => `<option value="${escapeHtml(task.id)}" data-robot-id="${escapeHtml(robot.id)}"${task.id === app.taskId ? " selected" : ""}>${task.rank}. ${escapeHtml(task.title)}</option>`).join("")}</optgroup>`;
  }).join("");
}

function populateDefinition() {
  elements.title.textContent = app.definition.title;
  elements.subtitle.textContent = app.definition.brief;
  elements.robotName.textContent = ROBOT_LABELS[app.definition.robotId] || app.definition.robotId;
  elements.rank.textContent = `Rank ${app.definition.rank} · Class ${app.definition.migration.class}`;
  elements.assistance.textContent = `${app.definition.assistanceLevel} · ${app.definition.api.level}`;
  elements.source.innerHTML = app.definition.provenance.map((entry) => `<code title="${escapeHtml(entry.claim)}">${escapeHtml(entry.label)}</code>`).join(" ");
  elements.limitations.textContent = `${app.definition.modelClaim.supportedFidelity}. Unsupported: ${app.definition.modelClaim.unsupportedPhysics.join("; ")}.`;
  elements.safety.textContent = `${LAB_BOUNDARY_COPY.full} State changes commit only at modeled contact/process events; configured values are not physical measurements.`;
  elements.backLink.href = `lab-scenarios.html?robot=${encodeURIComponent(app.robotId)}&task=${encodeURIComponent(app.taskId)}`;
  elements.pythonEditor.value = loadV2Draft(app.definition.id, "python", "");
  elements.pythonEditor.placeholder = starterPython();
  populateTaskSelector();
}

function renderGoals(state) {
  const rows = [
    ...state.grade.goals.map((goal) => ({ id: goal.id, complete: goal.passed, label: goal.predicate.label || goal.predicate.description || `Observable outcome: ${goal.predicate.op}` })),
    ...state.grade.evidence.map((evidence) => ({ id: evidence.id, complete: evidence.passed, label: evidence.requirement.label || evidence.requirement.prompt || `Required evidence: ${evidence.id}` }))
  ];
  elements.checkpoints.innerHTML = rows.map((row, index) => `
    <li class="lab-checkpoint" data-status="${row.complete ? "complete" : "active"}">
      <span class="lab-checkpoint__index" data-readout>${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHtml(row.label)}</strong><small>${row.complete ? "Outcome/evidence satisfied" : "Observable completion required"}</small></span>
      <span class="lab-checkpoint__state">${row.complete ? "complete" : "pending"}</span>
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
  const items = state.commandLog.slice(-10).reverse();
  elements.commandLog.innerHTML = items.length ? items.map((entry) => `
    <li data-tone="${entry.ok ? "ready" : "error"}"><code>${String(entry.index).padStart(2, "0")}</code><span><strong>${escapeHtml(entry.method)}</strong><small>${escapeHtml(entry.message)}</small></span><span>${escapeHtml(entry.code)}</span></li>`).join("")
    : `<li class="lab-empty">Run Python or Blockly to populate API calls.</li>`;
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
  app.equipment?.update(state);
}

function renderState(state = app.engine?.snapshot()) {
  if (!state) return;
  renderGoals(state);
  renderEvidence(state);
  renderObjects(state);
  renderCommands(state);
  syncPreview(state);
  const passed = state.grade.passed;
  const stopped = state.runState === "stopped";
  const feedback = passed
    ? { code: state.grade.code, message: "Observable outcomes, safety constraints, causal constraints, and evidence all pass.", tone: "success" }
    : state.feedback || { code: "READY", message: "Scenario v2 is ready.", tone: "ready" };
  elements.feedbackCode.textContent = feedback.code;
  elements.feedbackMessage.textContent = feedback.message;
  tone(elements.feedback, passed ? "success" : feedback.tone);
  const held = Object.values(state.objects).find((item) => item.attachedTo);
  elements.previewStatus.textContent = `${passed ? "Complete" : app.paused ? "Paused" : app.running ? "Running" : stopped ? "Stopped" : "Ready"} · ${state.lastReachedFrame} · ${held ? `${held.id} attached after contact` : "No object attached"}`;
  tone(elements.previewStatus, passed ? "success" : app.paused || stopped ? "warning" : app.running ? "running" : "ready");
  elements.previewStage.dataset.runState = passed ? "complete" : app.running ? "running" : stopped ? "stopped" : "ready";
  elements.previewStage.setAttribute("aria-busy", String(app.running && !app.paused));
  updateControls();
}

function setEditorStatus(message, value = "ready") {
  elements.editorStatus.textContent = message;
  tone(elements.editorStatus, value);
}

function updateControls() {
  elements.run.disabled = app.running;
  elements.pause.disabled = !app.running;
  elements.pause.setAttribute("aria-pressed", String(app.paused));
  elements.pause.querySelector("span").textContent = app.paused ? "Resume" : "Pause";
  elements.generatePython.hidden = app.language !== "blockly";
}

function saveDrafts() {
  if (!app.definition) return false;
  const blocklySaved = app.workspace ? saveV2Draft(app.definition.id, "blockly", serializeBlockly()) : true;
  const pythonSaved = saveV2Draft(app.definition.id, "python", elements.pythonEditor.value);
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

async function runProgram() {
  if (app.running) return;
  let program;
  try {
    program = app.language === "blockly" ? compileV2BlocklyProgram(app.workspace) : elements.pythonEditor.value;
    if (!String(program).trim()) throw new Error("Add an async main(robot, lab) program before running.");
  } catch (error) {
    setEditorStatus(error.message, "error");
    return;
  }
  saveDrafts();
  app.running = true;
  app.paused = false;
  setEditorStatus("Executing Python asynchronously in Pyodide against ScenarioV2...", "running");
  renderState();
  try {
    const result = await app.python.run(program, { apiLevel: app.definition.api.level, timeoutMs: 60000 });
    const state = app.engine.snapshot();
    saveV2Progress(app.definition.id, { grade: state.grade, updatedAt: new Date().toISOString(), freshV2: true });
    const stdout = String(result.stdout || "").trim();
    setEditorStatus(state.grade.passed ? "Run completed: outcome and evidence assessment passed." : `Python completed; assessment remains incomplete.${stdout ? ` Output: ${stdout}` : ""}`, state.grade.passed ? "success" : "warning");
  } catch (error) {
    const stopped = error.code === "STOPPED";
    setEditorStatus(stopped ? "Run stopped at the last executed trajectory sample." : `${error.code || "PYTHON_ERROR"}: ${error.message}`, stopped ? "warning" : "error");
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
    elements.pythonEditor.value = compileV2BlocklyProgram(app.workspace);
    saveV2Draft(app.definition.id, "python", elements.pythonEditor.value);
    switchLanguage("python");
    setEditorStatus("Blockly compiled to real async Python. Review before running.", "ready");
  } catch (error) { setEditorStatus(error.message, "error"); }
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
  if (preview?.resetCamera) preview.resetCamera();
  else {
    const points = Object.values(app.definition.frames).map((frame) => frame.positionMm);
    const target = points.reduce((sum, point) => sum.map((value, index) => value + point[index] / points.length), [0, 0, 0]);
    preview?.controls?.target?.set(...target);
    preview?.camera?.position?.set(target[0] + 660, target[1] + 460, target[2] + 720);
    preview?.controls?.update?.();
  }
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
  elements.languageTabs.forEach((tab) => tab.addEventListener("click", () => switchLanguage(tab.dataset.labLanguage)));
  elements.run.addEventListener("click", runProgram);
  elements.pause.addEventListener("click", togglePause);
  [elements.stop, elements.emergencyStop, elements.stageStop].forEach((button) => button.addEventListener("click", () => stopRun("user")));
  elements.reset.addEventListener("click", resetTask);
  elements.starter.addEventListener("click", loadStarter);
  elements.save.addEventListener("click", () => setEditorStatus(saveDrafts() ? "Separate v2 drafts saved in this browser." : "Draft storage unavailable.", "ready"));
  elements.generatePython.addEventListener("click", generatePython);
  elements.cameraMovement.addEventListener("click", () => setCameraControl("movement", !app.camera.movement));
  elements.cameraZoom.addEventListener("click", () => setCameraControl("zoom", !app.camera.zoom));
  elements.cameraReset.addEventListener("click", resetCamera);
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
    if (event.key === "Escape") { if (!document.fullscreenElement) event.preventDefault(); void stopRun("escape"); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveDrafts(); setEditorStatus("Separate v2 drafts saved.", "ready"); }
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
      onSample: (_sample, _index, state) => renderState(state),
      onEvent: (_event, _context, state) => renderState(state)
    });
    app.python = new PythonRpcClient({ apiHandler: async (method, args) => {
      const response = await app.engine.call(method, args);
      renderState(response.state);
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
