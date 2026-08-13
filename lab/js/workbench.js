import { LabScenarioEngine } from "./actions.js";
import { collectBlocklyCommands, createLabToolbox, loadCommandsIntoBlockly, registerLabBlocks, restoreWorkspace, serializeWorkspace } from "./blocks.js";
import { LabEquipmentScene } from "./equipment.js?v=20260812-lab-fidelity-14";
import { LAB_BOUNDARY_COPY } from "./instructions.js";
import { ROBOT_LABELS } from "./labels.js";
import { commandsToPython, loadDraft, parsePythonProgram, readCameraPreferences, saveCameraPreference, saveDraft } from "./interactions.js";
import { announce, renderApparatus, renderCheckpoints, renderCommandLog, renderEvidence, setTone } from "./ui.js";

const VISUAL_MOTION_COMMANDS = new Set(["move_to_pose", "move_joint", "move_joints", "smooth_move", "drive", "humanoid_walk", "humanoid_turn", "set_posture", "home"]);
const MANIPULATION_COMMANDS = new Set(["grasp", "pick_nearest", "place", "release_object", "insert_into", "pour_into", "operate", "set_gripper"]);

const elements = {
  loading: document.getElementById("labWorkbenchLoading"),
  error: document.getElementById("labWorkbenchError"),
  shell: document.getElementById("main-content"),
  title: document.getElementById("labWorkbenchTitle"),
  subtitle: document.getElementById("labWorkbenchSubtitle"),
  robotName: document.getElementById("labRobotName"),
  rank: document.getElementById("labRank"),
  assistance: document.getElementById("labAssistance"),
  source: document.getElementById("labSourceRefs"),
  limitations: document.getElementById("labLimitations"),
  safety: document.getElementById("labSafetyBoundary"),
  checkpoints: document.getElementById("labCheckpointList"),
  progress: document.getElementById("labProgress"),
  feedback: document.getElementById("labFeedback"),
  feedbackCode: document.getElementById("labFeedbackCode"),
  feedbackMessage: document.getElementById("labFeedbackMessage"),
  languageTabs: [...document.querySelectorAll("[data-lab-language]")],
  blocklyPanel: document.getElementById("labBlocklyPanel"),
  pythonPanel: document.getElementById("labPythonPanel"),
  blocklyEditor: document.getElementById("labBlocklyEditor"),
  pythonEditor: document.getElementById("labPythonEditor"),
  editorStatus: document.getElementById("labEditorStatus"),
  preview: document.getElementById("labRobotPreview"),
  previewStage: document.getElementById("labPreviewStage"),
  previewStatus: document.getElementById("labPreviewStatus"),
  apparatus: document.getElementById("labApparatusBody"),
  evidence: document.getElementById("labEvidenceLog"),
  commandLog: document.getElementById("labCommandLog"),
  taskSelect: document.getElementById("labTaskSelect"),
  backLink: document.getElementById("labBackLink"),
  run: document.getElementById("labRun"),
  pause: document.getElementById("labPause"),
  stop: document.getElementById("labStop"),
  emergencyStop: document.getElementById("labEmergencyStop"),
  stageStop: document.getElementById("labStageStop"),
  reset: document.getElementById("labReset"),
  starter: document.getElementById("labLoadStarter"),
  save: document.getElementById("labSaveDraft"),
  generatePython: document.getElementById("labGeneratePython"),
  cameraMovement: document.getElementById("labCameraMovement"),
  cameraZoom: document.getElementById("labCameraZoom"),
  cameraReset: document.getElementById("labCameraReset"),
  sceneFullscreen: document.getElementById("labSceneFullscreen"),
  live: document.getElementById("labWorkbenchLive")
};

const params = new URLSearchParams(window.location.search);
const app = {
  catalog: null,
  definition: null,
  language: params.get("language") === "python" ? "python" : "blockly",
  robotId: params.get("robot") || "arduino_arm",
  taskId: params.get("task") || "",
  engine: null,
  simulation: null,
  arduinoPreview: null,
  equipment: null,
  blockly: null,
  workspace: null,
  runToken: 0,
  presentationFrame: 0,
  pausedMobileMotion: null,
  running: false,
  paused: false,
  disposed: false,
  camera: readCameraPreferences()
};

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}.`);
  return response.json();
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
  return manifest;
}

function arduinoPreviewMarkup() {
  return `
    <div class="arm-preview-container arm-preview-container--3d lab-arm-preview">
      <svg viewBox="0 0 310 460" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Arduino arm 3D fallback"></svg>
      <div class="arm-preview-3d" data-arm-preview-3d hidden>
        <div class="arm-preview-3d__viewport" data-arm-preview-3d-viewport role="img" aria-label="Arduino Arm 3D simulator"></div>
        <div class="arm-preview-3d__toolbar">
          <span class="arm-preview-3d__status" data-arm-preview-3d-status role="status" aria-live="polite">Loading 3D robot...</span>
          <button class="arm-preview-3d__reset" type="button" data-arm-preview-3d-reset><span>Camera</span></button>
        </div>
      </div>
      <p class="arm-preview-3d__fallback-status" data-arm-preview-3d-fallback-status role="status" aria-live="polite" hidden></p>
    </div>
  `;
}

function initializeSimulation(manifest) {
  const factory = window.RoboAdmin?.RobotSimulation?.createSimulationAdapter;
  if (typeof factory !== "function") throw new Error("Simulation adapter did not load.");
  app.simulation = factory(manifest);
  if (manifest.id === "arduino_arm") {
    elements.preview.innerHTML = arduinoPreviewMarkup();
    const Preview = window.RoboBuddy3DPreview?.ArmPreview3D || window.RoboAdmin?.ArmPreview;
    if (typeof Preview !== "function") throw new Error("Arduino 3D preview did not load.");
    const host = elements.preview.querySelector("svg");
    app.arduinoPreview = new Preview(host, {
      jointLimits: manifest.joints.map((joint) => [joint.min, joint.max]),
      initialAngles: manifest.joints.map((joint) => joint.home),
      cameraPreset: "compact"
    });
  } else {
    elements.preview.dataset.robotCameraPreset = "inspection";
    app.simulation.render(elements.preview, app.simulation.getState());
  }
  const preview = activePreview();
  if (!preview || !preview.scene) throw new Error("Robot preview scene is unavailable.");
  app.equipment = new LabEquipmentScene(preview, app.definition);
  applyAuthoredCamera();
  applyCameraPreferences();
  elements.preview.setAttribute("aria-label", `${manifest.shortName || manifest.name} and laboratory apparatus 3D simulation`);
  elements.previewStatus.textContent = `${manifest.shortName || manifest.name} rig with Lab Studio reference-shaped procedural apparatus.`;
}

function activePreview() {
  return app.arduinoPreview || app.simulation?.preview3d || null;
}

function initializeBlockly() {
  const Blockly = window.Blockly;
  if (!Blockly) throw new Error("Blockly did not load.");
  app.blockly = Blockly;
  registerLabBlocks(Blockly);
  const theme = Blockly.Theme.defineTheme("robobuddyLab", {
    base: Blockly.Themes.Classic,
    componentStyles: {
      workspaceBackgroundColour: "#f7f9fa",
      toolboxBackgroundColour: "#eef2f3",
      toolboxForegroundColour: "#26333c",
      flyoutBackgroundColour: "#ffffff",
      flyoutForegroundColour: "#26333c",
      flyoutOpacity: 1,
      scrollbarColour: "#8b9ba5",
      insertionMarkerColour: "#197d74",
      insertionMarkerOpacity: 0.35
    }
  });
  app.workspace = Blockly.inject(elements.blocklyEditor, {
    toolbox: createLabToolbox(app.definition),
    theme,
    renderer: "zelos",
    grid: { spacing: 20, length: 2, colour: "#cad4d9", snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.84, maxScale: 1.35, minScale: 0.45, scaleSpeed: 1.12 },
    trashcan: true,
    move: { scrollbars: true, drag: true, wheel: true }
  });
  elements.blocklyEditor.querySelectorAll(".blocklyToolboxCategoryContainer > .blocklyToolboxCategory[id]").forEach((category) => {
    category.removeAttribute("id");
  });
  const saved = loadDraft(app.definition.id, "blockly", "");
  if (saved) {
    try {
      restoreWorkspace(Blockly, app.workspace, saved);
      setEditorStatus("Saved Blockly draft restored.", "ready");
    } catch (error) {
      setEditorStatus("The saved Blockly draft could not be restored. The workspace is empty.", "warning");
    }
  }
}

function populateTaskSelector() {
  const robotOrder = app.catalog.robots.map((robot) => robot.id);
  elements.taskSelect.innerHTML = robotOrder.map((robotId) => {
    const tasks = app.catalog.tasks.filter((task) => task.robotId === robotId).sort((a, b) => a.rank - b.rank);
    return `<optgroup label="${ROBOT_LABELS[robotId] || robotId}">${tasks.map((task) => `<option value="${task.id}" data-robot-id="${robotId}"${task.id === app.taskId ? " selected" : ""}>${task.rank}. ${task.title}</option>`).join("")}</optgroup>`;
  }).join("");
}

function populateDefinition() {
  elements.title.textContent = app.definition.title;
  elements.subtitle.textContent = app.definition.brief;
  elements.robotName.textContent = ROBOT_LABELS[app.definition.robotId] || app.definition.robotId;
  elements.rank.textContent = `Rank ${app.definition.rank}`;
  elements.assistance.textContent = app.definition.assistanceLevel;
  elements.source.innerHTML = app.definition.techniqueRefs.map((ref) => `<code title="${ref.actionIds.length} reviewed action reference${ref.actionIds.length === 1 ? "" : "s"}">${ref.techniqueId}</code>`).join(" ");
  elements.limitations.textContent = app.definition.limitations;
  elements.safety.textContent = `${LAB_BOUNDARY_COPY.full} ${app.definition.safetyBoundary}`;
  elements.backLink.href = `lab-scenarios.html?robot=${encodeURIComponent(app.robotId)}&task=${encodeURIComponent(app.taskId)}`;
  elements.pythonEditor.value = loadDraft(app.definition.id, "python", "");
  elements.pythonEditor.placeholder = pythonPlaceholder();
  populateTaskSelector();
}

function pythonPlaceholder() {
  const firstPose = Object.values(app.definition.robotPoses).find((pose) => !["home", "dock", "safety"].includes(pose.id))?.id || "work_zone";
  if (app.definition.robotId === "unitree_g1_29dof") {
    return `# Supported robot-command subset\nrobot.move_to_pose(${JSON.stringify(firstPose)})\nrobot.pick_nearest(hand="right_hand")`;
  }
  if (app.definition.robotId === "openarm_v2_bimanual") {
    return `# Specify the arm for bimanual actions\nrobot.move_to_pose(${JSON.stringify(firstPose)})\nrobot.grasp("object_id", effector="left")`;
  }
  if (app.definition.robotId === "lekiwi_sim") {
    return `# World-frame mobile route\nrobot.drive(vx=0.2, vy=0.0, omega=0, seconds=1.0)`;
  }
  return `# One simulation command per line\nrobot.move_to_pose(${JSON.stringify(firstPose)})\nrobot.grasp("object_id")`;
}

function renderState(options = {}) {
  const state = options.state || app.engine.snapshot();
  renderCheckpoints(elements.checkpoints, app.definition, state);
  renderEvidence(elements.evidence, state.evidence);
  renderApparatus(elements.apparatus, state.apparatus);
  renderCommandLog(elements.commandLog, state.commandLog);
  elements.progress.textContent = `${state.completedCheckpointIds.length} / ${app.definition.checkpoints.length}`;
  elements.feedbackCode.textContent = state.feedback.code;
  elements.feedbackMessage.textContent = state.feedback.message;
  setTone(elements.feedback, state.feedback.tone);
  if (options.syncEquipment !== false) app.equipment?.update(state);
  if (options.syncRobot !== false) syncArduinoPreview();
  updateSceneStatus(state);
  updateControls();
}

function updateSceneStatus(state = app.engine?.snapshot()) {
  if (!state || !app.definition) return;
  const complete = state.runState === "complete";
  const stopped = state.runState === "stopped";
  const mode = complete ? "Complete" : app.paused ? "Paused" : app.running ? "Running" : stopped ? "Stopped" : "Ready";
  const tone = complete ? "success" : app.paused || stopped ? "warning" : app.running ? "running" : state.feedback?.tone === "error" ? "error" : "ready";
  const checkpoint = app.definition.checkpoints[state.checkpointIndex];
  const step = checkpoint
    ? `Step ${state.checkpointIndex + 1} of ${app.definition.checkpoints.length}: ${checkpoint.label}`
    : `${app.definition.checkpoints.length} of ${app.definition.checkpoints.length} checkpoints complete`;
  const held = state.apparatus.find((item) => item.heldBy && !item.removed);
  const inserted = state.apparatus.find((item) => item.insertedInto && !item.removed);
  const relationship = held ? `${held.label} held` : inserted ? `${inserted.label} inserted` : "Apparatus staged";
  elements.previewStatus.textContent = `${mode} · ${step} · ${relationship}`;
  elements.previewStatus.dataset.tone = tone;
  elements.previewStage.dataset.runState = mode.toLowerCase();
  elements.previewStage.setAttribute("aria-busy", String(app.running && !app.paused));
}

function syncArduinoPreview() {
  if (!app.arduinoPreview || !app.simulation) return;
  const simulationState = app.simulation.getState();
  const angles = app.simulation.manifest.joints.map((joint) => simulationState.joints[joint.id]);
  app.arduinoPreview.setAngles(angles);
}

function applyPreviewJointState(simulationState, joints) {
  if (!app.simulation || !simulationState || !joints) return;
  if (app.arduinoPreview) {
    const angles = app.simulation.manifest.joints.map((joint) => Number(joints[joint.id] ?? joint.home ?? 0));
    app.arduinoPreview.setAngles(angles);
    return;
  }
  const preview = activePreview();
  if (typeof preview?.updateState === "function") preview.updateState({ ...simulationState, joints: { ...joints } });
}

function setEditorStatus(message, tone = "ready") {
  elements.editorStatus.textContent = message;
  elements.editorStatus.dataset.tone = tone;
}

function updateControls() {
  elements.run.disabled = app.running;
  elements.pause.disabled = !app.running;
  elements.pause.setAttribute("aria-pressed", String(app.paused));
  elements.pause.querySelector("span").textContent = app.paused ? "Resume" : "Pause";
  elements.generatePython.hidden = app.language !== "blockly";
}

function saveCurrentDraft() {
  if (!app.definition) return false;
  if (app.language === "blockly" && app.workspace) {
    return saveDraft(app.definition.id, "blockly", serializeWorkspace(app.blockly, app.workspace));
  }
  return saveDraft(app.definition.id, "python", elements.pythonEditor.value);
}

function saveAllDrafts() {
  if (!app.definition) return false;
  if (app.disposed) return true;
  const blocklySaved = app.workspace
    ? saveDraft(app.definition.id, "blockly", serializeWorkspace(app.blockly, app.workspace))
    : true;
  const pythonSaved = saveDraft(app.definition.id, "python", elements.pythonEditor.value);
  return blocklySaved && pythonSaved;
}

function switchLanguage(language, options = {}) {
  if (!options.initial) saveCurrentDraft();
  app.language = language === "python" ? "python" : "blockly";
  elements.languageTabs.forEach((tab) => {
    const active = tab.dataset.labLanguage === app.language;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  elements.blocklyPanel.hidden = app.language !== "blockly";
  elements.pythonPanel.hidden = app.language !== "python";
  const url = new URL(window.location.href);
  url.searchParams.set("language", app.language);
  window.history.replaceState({}, "", url);
  if (app.language === "blockly") window.setTimeout(() => app.blockly?.svgResize(app.workspace), 0);
  else elements.pythonEditor.focus({ preventScroll: true });
  updateControls();
}

function programCommands() {
  return app.language === "blockly" ? collectBlocklyCommands(app.workspace) : parsePythonProgram(elements.pythonEditor.value);
}

async function waitDuringRun(milliseconds, token) {
  let remaining = Math.max(0, Number(milliseconds) || 0);
  while (remaining > 0) {
    if (token !== app.runToken) return false;
    while (app.paused && token === app.runToken) await new Promise((resolve) => window.setTimeout(resolve, 80));
    if (token !== app.runToken) return false;
    const slice = Math.min(80, remaining);
    await new Promise((resolve) => window.setTimeout(resolve, slice));
    remaining -= slice;
  }
  return token === app.runToken;
}

function visualMotionActive() {
  const preview = activePreview();
  return Boolean(preview?.activeMobileMotion || preview?.activeHumanoidMotion);
}

function setMobilePresentationPaused(paused) {
  const preview = activePreview();
  if (!preview?.config?.mobileBase) return;
  if (paused) {
    const motion = preview.activeMobileMotion;
    if (!motion) return;
    const remainingSeconds = Math.max(0, Number(motion.durationSeconds) - Number(motion.elapsedSeconds || 0));
    app.pausedMobileMotion = remainingSeconds > 0 ? {
      ...motion,
      id: `${motion.id || "lab-mobile"}-resume`,
      startPose: preview.getVisualMobileBasePose?.() || motion.startPose,
      durationSeconds: remainingSeconds,
      elapsedSeconds: 0
    } : null;
    preview.activeMobileMotion = null;
    return;
  }
  if (app.pausedMobileMotion && typeof preview.startMobileMotion === "function") preview.startMobileMotion(app.pausedMobileMotion);
  app.pausedMobileMotion = null;
}

function activeVisualDurationMs() {
  const preview = activePreview();
  const durations = [preview?.activeMobileMotion?.durationSeconds, preview?.activeHumanoidMotion?.durationSeconds]
    .map(Number)
    .filter(Number.isFinite);
  return durations.length ? Math.max(...durations) * 1000 : 0;
}

function commandDurationMs(command) {
  if (command.type === "drive" || command.type === "humanoid_turn" || command.type === "set_posture" || command.type === "move_to_pose") {
    const fallback = command.type === "set_posture" ? 0.8 : command.type === "humanoid_turn" ? 1.5 : 1.2;
    return Math.max(0, Number(command.seconds ?? fallback) || fallback) * 1000;
  }
  if (command.type === "humanoid_walk") {
    const steps = Math.max(1, Number(command.steps) || 1);
    const speed = Math.max(1, Number(command.speed) || 45);
    return Math.max(900, steps * 360 * (45 / speed));
  }
  return 0;
}

function jointPresentationPlan(beforeSimulation, afterSimulation, command, apparatusTransition) {
  if (app.definition.robotId === "unitree_g1_29dof" || !beforeSimulation?.joints || !afterSimulation?.joints) return null;
  const gripperIds = new Set(app.simulation.manifest.joints.filter((joint) => joint.type === "gripper").map((joint) => joint.id));
  const changedIds = app.simulation.manifest.joints
    .map((joint) => joint.id)
    .filter((id) => Number.isFinite(Number(beforeSimulation.joints[id])) && Number.isFinite(Number(afterSimulation.joints[id])))
    .filter((id) => Math.abs(Number(afterSimulation.joints[id]) - Number(beforeSimulation.joints[id])) > 0.001);
  const contactGripperIds = apparatusTransition ? changedIds.filter((id) => gripperIds.has(id)) : [];
  const ids = changedIds.filter((id) => !contactGripperIds.includes(id));
  if (!ids.length && !contactGripperIds.length) return null;
  const maxDelta = ids.length ? Math.max(...ids.map((id) => Math.abs(Number(afterSimulation.joints[id]) - Number(beforeSimulation.joints[id])))) : 0;
  const speed = Math.max(1, Math.min(100, Number(command.speed) || 45));
  const authoredDuration = commandDurationMs(command);
  const durationMs = apparatusTransition
    ? 420
    : authoredDuration
      ? Math.max(360, Math.min(2200, authoredDuration))
      : Math.max(360, Math.min(1600, 260 + maxDelta * 9 * (45 / speed)));
  return { ids, contactGripperIds, durationMs };
}

function normalizedDegrees(value) {
  let next = Number(value) || 0;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}

function g1NamedPosePlan(command, beforeState, afterState) {
  if (app.definition.robotId !== "unitree_g1_29dof" || !["move_to_pose", "home"].includes(command.type)) return null;
  const startPosition = beforeState?.basePositionMm || [0, 0, 0];
  const targetPosition = afterState?.basePositionMm || startPosition;
  const startRoot = {
    x: Number(startPosition[0] || 0) / 1000,
    z: Number(startPosition[2] || 0) / 1000,
    theta: normalizedDegrees(beforeState?.headingDeg)
  };
  const targetRoot = {
    x: Number(targetPosition[0] || 0) / 1000,
    z: Number(targetPosition[2] || 0) / 1000,
    theta: normalizedDegrees(afterState?.headingDeg)
  };
  const distanceMm = Math.hypot(targetPosition[0] - startPosition[0], targetPosition[2] - startPosition[2]);
  const authoredDuration = command.type === "move_to_pose" ? commandDurationMs(command) : 0;
  const durationMs = Math.max(700, Math.min(2600, Math.max(authoredDuration || 0, distanceMm / 0.35 || 0)));
  return {
    startRoot,
    targetRoot,
    startJoints: { ...(beforeState?.robotJoints || {}) },
    targetJoints: { ...(afterState?.robotJoints || {}) },
    durationMs
  };
}

function syncG1PresentationState(preview, root, joints) {
  preview.visualHumanoidState = { root: { ...root }, joints: { ...joints } };
  preview.applyHumanoidPose(root);
  preview.applyJointPoseTo(preview.groups, joints);
}

function commitG1PresentationState(preview, root, joints) {
  if (app.simulation?.state) {
    app.simulation.state.humanoidRoot = { ...root };
    app.simulation.state.joints = { ...app.simulation.state.joints, ...joints };
    app.simulation.state.humanoidMotion = {
      ...(app.simulation.state.humanoidMotion || {}),
      active: false,
      phase: "idle",
      progress: 1
    };
    app.simulation.pendingHumanoidAction = null;
  }
  if (typeof preview.updateState === "function") preview.updateState(app.simulation?.getState?.() || { humanoidRoot: root, joints });
  else syncG1PresentationState(preview, root, joints);
}

function presentG1NamedPose(plan, command, apparatusState, token) {
  if (!plan) return Promise.resolve(true);
  const preview = activePreview();
  if (!preview?.config?.humanoidRoot || typeof preview.applyHumanoidPose !== "function" || typeof preview.applyJointPoseTo !== "function") {
    return Promise.resolve(true);
  }

  // move_to_pose dispatches turn, walk, then posture synchronously in the
  // shared adapter. Stop that collapsed last action and present the authored
  // lab state as one continuous kinematic move without changing engine gates.
  preview.cancelHumanoidMotion?.({ lockToVisual: false });
  app.simulation.pendingHumanoidAction = null;
  syncG1PresentationState(preview, plan.startRoot, plan.startJoints);
  app.equipment?.syncHeldObjects(apparatusState);
  elements.previewStatus.textContent = `Running · Animating ${commandPresentationLabel(command)} · STOP remains available`;
  elements.previewStatus.dataset.tone = "running";

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (reducedMotion) {
    commitG1PresentationState(preview, plan.targetRoot, plan.targetJoints);
    app.equipment?.syncHeldObjects(apparatusState);
    return Promise.resolve(true);
  }

  const jointIds = new Set([...Object.keys(plan.startJoints), ...Object.keys(plan.targetJoints)]);
  const thetaDelta = normalizedDegrees(plan.targetRoot.theta - plan.startRoot.theta);
  return new Promise((resolve) => {
    let elapsedMs = 0;
    let previousTimestamp = 0;
    const step = (timestamp) => {
      if (token !== app.runToken || app.disposed) {
        app.presentationFrame = 0;
        resolve(false);
        return;
      }
      if (!previousTimestamp) previousTimestamp = timestamp;
      const deltaMs = Math.min(48, Math.max(0, timestamp - previousTimestamp));
      previousTimestamp = timestamp;
      if (!app.paused) elapsedMs += deltaMs;
      const progress = Math.min(1, elapsedMs / plan.durationMs);
      const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      const root = {
        x: plan.startRoot.x + (plan.targetRoot.x - plan.startRoot.x) * eased,
        z: plan.startRoot.z + (plan.targetRoot.z - plan.startRoot.z) * eased,
        theta: normalizedDegrees(plan.startRoot.theta + thetaDelta * eased)
      };
      const joints = {};
      jointIds.forEach((id) => {
        const start = Number(plan.startJoints[id] ?? plan.targetJoints[id] ?? 0);
        const target = Number(plan.targetJoints[id] ?? start);
        joints[id] = start + (target - start) * eased;
      });
      syncG1PresentationState(preview, root, joints);
      app.equipment?.syncHeldObjects(apparatusState);
      if (progress >= 1) {
        commitG1PresentationState(preview, plan.targetRoot, plan.targetJoints);
        app.equipment?.syncHeldObjects(apparatusState);
        app.presentationFrame = 0;
        resolve(true);
        return;
      }
      app.presentationFrame = window.requestAnimationFrame(step);
    };
    app.presentationFrame = window.requestAnimationFrame(step);
  });
}

function presentJointInterpolation(beforeSimulation, afterSimulation, plan, command, apparatusState, excludedItemId, token) {
  if (!plan) return Promise.resolve(true);
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (reducedMotion) {
    applyPreviewJointState(afterSimulation, afterSimulation.joints);
    app.equipment?.syncHeldObjects(apparatusState, excludedItemId);
    return Promise.resolve(true);
  }

  const startJoints = { ...beforeSimulation.joints };
  const targetJoints = { ...afterSimulation.joints };
  (plan.contactGripperIds || []).forEach((id) => { targetJoints[id] = beforeSimulation.joints[id]; });
  applyPreviewJointState(afterSimulation, startJoints);
  app.equipment?.syncHeldObjects(apparatusState, excludedItemId);
  elements.previewStatus.textContent = `Running · Animating ${commandPresentationLabel(command)} · STOP remains available`;
  elements.previewStatus.dataset.tone = "running";

  return new Promise((resolve) => {
    let elapsedMs = 0;
    let previousTimestamp = 0;
    const step = (timestamp) => {
      if (token !== app.runToken || app.disposed) {
        app.presentationFrame = 0;
        resolve(false);
        return;
      }
      if (!previousTimestamp) previousTimestamp = timestamp;
      const deltaMs = Math.min(48, Math.max(0, timestamp - previousTimestamp));
      previousTimestamp = timestamp;
      if (!app.paused) elapsedMs += deltaMs;
      const progress = Math.min(1, elapsedMs / plan.durationMs);
      const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      const joints = { ...targetJoints };
      plan.ids.forEach((id) => {
        const start = Number(startJoints[id]);
        joints[id] = start + (Number(targetJoints[id]) - start) * eased;
      });
      applyPreviewJointState(afterSimulation, joints);
      app.equipment?.syncHeldObjects(apparatusState, excludedItemId);
      if (progress >= 1) {
        app.presentationFrame = 0;
        resolve(true);
        return;
      }
      app.presentationFrame = window.requestAnimationFrame(step);
    };
    app.presentationFrame = window.requestAnimationFrame(step);
  });
}

function presentContactGripper(beforeSimulation, afterSimulation, jointPlan, progress) {
  const ids = jointPlan?.contactGripperIds || [];
  if (!ids.length || !beforeSimulation?.joints || !afterSimulation?.joints) return;
  const contactProgress = Math.min(1, Math.max(0, Number(progress) || 0));
  const eased = contactProgress < 0.5 ? 4 * contactProgress ** 3 : 1 - (-2 * contactProgress + 2) ** 3 / 2;
  const joints = { ...afterSimulation.joints };
  ids.forEach((id) => {
    const start = Number(beforeSimulation.joints[id]);
    joints[id] = start + (Number(afterSimulation.joints[id]) - start) * eased;
  });
  applyPreviewJointState(afterSimulation, joints);
}

async function presentCommandTransition(command, beforeState, afterState, beforeSimulation, afterSimulation, token) {
  const apparatusTransition = app.equipment?.apparatusTransition(beforeState, afterState) || null;
  const g1Plan = g1NamedPosePlan(command, beforeState, afterState);
  const jointPlan = jointPresentationPlan(beforeSimulation, afterSimulation, command, apparatusTransition);
  const robotPromise = g1Plan
    ? presentG1NamedPose(g1Plan, command, afterState, token)
    : presentJointInterpolation(
      beforeSimulation,
      afterSimulation,
      jointPlan,
      command,
      afterState,
      apparatusTransition?.itemId || "",
      token
    );
  if (apparatusTransition && !g1Plan && !jointPlan) {
    elements.previewStatus.textContent = `Running · Animating ${commandPresentationLabel(command)} · STOP remains available`;
    elements.previewStatus.dataset.tone = "running";
  }
  const apparatusPromise = apparatusTransition
    ? app.equipment.presentTransition(beforeState, afterState, {
      durationMs: Math.max(820, g1Plan?.durationMs || jointPlan?.durationMs || 0),
      isActive: () => token === app.runToken && !app.disposed,
      isPaused: () => app.paused,
      onContactProgress: (progress) => presentContactGripper(beforeSimulation, afterSimulation, jointPlan, progress)
    })
    : Promise.resolve(app.equipment ? (app.equipment.applyState(afterState), true) : true);
  const results = await Promise.all([robotPromise, apparatusPromise]);
  return { ok: results.every(Boolean), presented: Boolean(g1Plan || jointPlan || apparatusTransition) };
}

function presentationDwellMs(command) {
  if (MANIPULATION_COMMANDS.has(command.type)) return command.type === "operate" || command.type === "pour_into" ? 520 : 420;
  if (VISUAL_MOTION_COMMANDS.has(command.type)) return 260;
  if (command.type === "wait") return Math.min(800, Math.max(100, Number(command.seconds) * 100));
  return 180;
}

function commandPresentationLabel(command) {
  return String(command.type || "command").replace(/_/g, " ");
}

async function waitForCommandPresentation(command, token, alreadyPresented = false) {
  const dwell = alreadyPresented ? 0 : presentationDwellMs(command);
  let observedMs = 0;
  if (VISUAL_MOTION_COMMANDS.has(command.type)) {
    const timeoutMs = Math.min(32000, Math.max(1200, commandDurationMs(command), activeVisualDurationMs()) + 1200);
    let sawVisualMotion = visualMotionActive();
    elements.previewStatus.textContent = `Running · Animating ${commandPresentationLabel(command)} · STOP remains available`;
    elements.previewStatus.dataset.tone = "running";
    while (observedMs < timeoutMs) {
      if (token !== app.runToken) return false;
      while (app.paused && token === app.runToken) await new Promise((resolve) => window.setTimeout(resolve, 80));
      if (token !== app.runToken) return false;
      const active = visualMotionActive();
      sawVisualMotion ||= active;
      if (!active && (sawVisualMotion || observedMs >= dwell)) break;
      const slice = Math.min(50, timeoutMs - observedMs);
      await new Promise((resolve) => window.setTimeout(resolve, slice));
      observedMs += slice;
    }
  }
  if (observedMs < dwell && !await waitDuringRun(dwell - observedMs, token)) return false;
  if (token === app.runToken) updateSceneStatus(app.engine.snapshot());
  return token === app.runToken;
}

async function runProgram() {
  if (app.running) return;
  let commands;
  try {
    commands = programCommands();
    saveCurrentDraft();
  } catch (error) {
    setEditorStatus(error.message, "error");
    announce(elements.live, error.message);
    return;
  }
  app.running = true;
  app.paused = false;
  const token = ++app.runToken;
  app.engine.state.runState = "running";
  setEditorStatus(`Running ${commands.length} command${commands.length === 1 ? "" : "s"} in simulation.`, "running");
  updateSceneStatus(app.engine.snapshot());
  updateControls();
  for (const command of commands) {
    if (token !== app.runToken) break;
    while (app.paused && token === app.runToken) await new Promise((resolve) => window.setTimeout(resolve, 80));
    const beforeState = app.engine.snapshot();
    const beforeSimulation = app.simulation?.getState?.() || null;
    let result;
    try {
      result = app.engine.execute(command);
    } catch (error) {
      app.engine.state.feedback = { tone: "error", code: "SIMULATION_ERROR", message: error.message };
      result = { ok: false, code: "SIMULATION_ERROR", message: error.message };
    }
    const afterState = app.engine.snapshot();
    const afterSimulation = app.simulation?.getState?.() || null;
    renderState({ state: afterState, syncEquipment: !result.ok, syncRobot: !result.ok });
    announce(elements.live, result.message);
    if (!result.ok || result.code === "STOPPED") break;
    const presentation = await presentCommandTransition(command, beforeState, afterState, beforeSimulation, afterSimulation, token);
    if (!presentation.ok) break;
    if (!await waitForCommandPresentation(command, token, presentation.presented)) break;
    if (result.code === "TASK_COMPLETE") break;
  }
  if (token === app.runToken) {
    app.running = false;
    app.paused = false;
    const finalState = app.engine.snapshot();
    setEditorStatus(finalState.runState === "complete" ? "Task complete. Review the evidence log." : "Program stopped at the current recoverable task state.", finalState.runState === "complete" ? "success" : "ready");
    updateSceneStatus(finalState);
  }
  updateControls();
}

function togglePause() {
  if (!app.running) return;
  app.paused = !app.paused;
  if (typeof app.simulation?.setPaused === "function") app.simulation.setPaused(app.paused);
  setMobilePresentationPaused(app.paused);
  setEditorStatus(app.paused ? "Program queue paused. Current scenario state is preserved." : "Program queue resumed.", app.paused ? "warning" : "running");
  updateSceneStatus(app.engine.snapshot());
  updateControls();
}

function stopProgram() {
  app.runToken += 1;
  app.running = false;
  app.paused = false;
  app.pausedMobileMotion = null;
  const result = app.engine.execute({ type: "stop" });
  renderState();
  setEditorStatus(result.message, "warning");
  announce(elements.live, result.message);
}

function resetTask() {
  app.runToken += 1;
  app.running = false;
  app.paused = false;
  app.pausedMobileMotion = null;
  app.simulation?.stop?.();
  app.engine.reset();
  renderState();
  setEditorStatus("Task state reset. Both language drafts and camera preferences were preserved.", "ready");
  announce(elements.live, "Task reset to its authored initial state.");
}

function draftHasContent() {
  if (app.language === "python") return Boolean(elements.pythonEditor.value.trim());
  return Boolean(app.workspace?.getAllBlocks(false).length);
}

function loadStarter() {
  const starter = app.definition.starters[app.language];
  const hasStarter = app.language === "python" ? Boolean(starter.code.trim()) : Boolean(starter.commands.length);
  if (!hasStarter) {
    setEditorStatus("Challenge tasks intentionally start without task-specific starter commands.", "warning");
    return;
  }
  if (draftHasContent() && !window.confirm("Replace the current language draft with the authored starter? The other language draft is unchanged.")) return;
  if (app.language === "python") elements.pythonEditor.value = starter.code;
  else loadCommandsIntoBlockly(app.blockly, app.workspace, starter.commands);
  saveCurrentDraft();
  setEditorStatus(`${app.language === "python" ? "Python" : "Blockly"} starter loaded.`, "ready");
}

function generatePython() {
  try {
    const commands = collectBlocklyCommands(app.workspace);
    elements.pythonEditor.value = commandsToPython(commands);
    saveDraft(app.definition.id, "python", elements.pythonEditor.value);
    switchLanguage("python");
    setEditorStatus("Python generated from the current Blockly command sequence. The Blockly draft remains independent.", "ready");
  } catch (error) {
    setEditorStatus(error.message, "error");
  }
}

function setCameraControl(name, enabled) {
  app.camera[name] = Boolean(enabled);
  const preview = activePreview();
  if (name === "movement") {
    if (typeof preview?.setCameraMovementEnabled === "function") preview.setCameraMovementEnabled(app.camera[name]);
    else if (preview?.controls) { preview.controls.enableRotate = app.camera[name]; preview.controls.enablePan = app.camera[name]; }
  } else {
    if (typeof preview?.setCameraZoomEnabled === "function") preview.setCameraZoomEnabled(app.camera[name]);
    else if (preview?.controls) preview.controls.enableZoom = app.camera[name];
  }
  saveCameraPreference(name, app.camera[name]);
  const button = name === "movement" ? elements.cameraMovement : elements.cameraZoom;
  button.setAttribute("aria-pressed", String(app.camera[name]));
  button.querySelector("span").textContent = `${name === "movement" ? "Move view" : "Zoom"}: ${app.camera[name] ? "on" : "off"}`;
  const accessibleLabel = `Camera ${name} ${app.camera[name] ? "on" : "off"}`;
  button.setAttribute("aria-label", accessibleLabel);
  button.title = accessibleLabel;
}

function applyCameraPreferences() {
  setCameraControl("movement", app.camera.movement);
  setCameraControl("zoom", app.camera.zoom);
}

function applyAuthoredCamera() {
  const preview = activePreview();
  const camera = app.definition?.camera;
  if (!preview?.camera || !camera?.positionMm || !camera?.targetMm) return;
  preview.camera.position.set(...camera.positionMm);
  if (preview.controls) {
    preview.controls.target.set(...camera.targetMm);
    preview.controls.update();
  }
  preview.resize?.();
}

async function toggleSceneFullscreen() {
  if (!document.fullscreenEnabled || !elements.previewStage?.requestFullscreen) return;
  if (document.fullscreenElement === elements.previewStage) await document.exitFullscreen();
  else await elements.previewStage.requestFullscreen();
}

function reportFullscreenError(error) {
  const message = `Expanded 3D scene unavailable${error?.message ? `: ${error.message}` : "."}`;
  elements.previewStatus.textContent = message;
  elements.previewStatus.dataset.tone = "error";
  announce(elements.live, message);
}

function syncSceneFullscreenControl() {
  const expanded = document.fullscreenElement === elements.previewStage;
  elements.sceneFullscreen?.setAttribute("aria-label", expanded ? "Exit expanded 3D scene" : "Expand 3D scene");
  elements.sceneFullscreen?.setAttribute("aria-expanded", String(expanded));
  if (elements.sceneFullscreen) elements.sceneFullscreen.title = expanded ? "Exit expanded 3D scene" : "Expand 3D scene";
  const label = elements.sceneFullscreen?.querySelector("span");
  if (label) label.textContent = expanded ? "Exit expanded scene" : "Expand scene";
  const icon = elements.sceneFullscreen?.querySelector("[data-lucide]");
  const iconName = expanded ? "minimize-2" : "maximize-2";
  if (icon && icon.getAttribute("data-lucide") !== iconName) {
    icon.setAttribute("data-lucide", iconName);
    window.lucide?.createIcons({ nodes: elements.sceneFullscreen.querySelectorAll("[data-lucide]") });
  }
  window.setTimeout(() => activePreview()?.resize?.(), 60);
}

function bindCollapsibles() {
  document.querySelectorAll("[data-lab-collapse]").forEach((button) => {
    button.addEventListener("click", () => {
      const body = document.getElementById(button.getAttribute("aria-controls"));
      const expanded = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(expanded));
      body.hidden = !expanded;
    });
  });
}

function bindEvents() {
  elements.languageTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => switchLanguage(tab.dataset.labLanguage));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + elements.languageTabs.length) % elements.languageTabs.length;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % elements.languageTabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = elements.languageTabs.length - 1;
      const nextTab = elements.languageTabs[nextIndex];
      switchLanguage(nextTab.dataset.labLanguage);
      nextTab.focus({ preventScroll: true });
    });
  });
  elements.run.addEventListener("click", runProgram);
  elements.pause.addEventListener("click", togglePause);
  elements.stop.addEventListener("click", stopProgram);
  elements.emergencyStop.addEventListener("click", stopProgram);
  elements.stageStop.addEventListener("click", stopProgram);
  elements.reset.addEventListener("click", resetTask);
  elements.starter.addEventListener("click", loadStarter);
  elements.save.addEventListener("click", () => {
    const saved = saveAllDrafts();
    setEditorStatus(saved ? "Both independent language drafts were saved locally." : "Browser storage is unavailable; the drafts remain in this tab.", saved ? "success" : "warning");
  });
  elements.generatePython.addEventListener("click", generatePython);
  elements.cameraMovement.addEventListener("click", () => setCameraControl("movement", !app.camera.movement));
  elements.cameraZoom.addEventListener("click", () => setCameraControl("zoom", !app.camera.zoom));
  elements.cameraReset.addEventListener("click", applyAuthoredCamera);
  if (document.fullscreenEnabled && elements.previewStage?.requestFullscreen) {
    elements.sceneFullscreen.addEventListener("click", () => toggleSceneFullscreen().catch(reportFullscreenError));
    document.addEventListener("fullscreenchange", syncSceneFullscreenControl);
  } else {
    elements.sceneFullscreen.hidden = true;
  }
  elements.taskSelect.addEventListener("change", () => {
    saveAllDrafts();
    const option = elements.taskSelect.selectedOptions[0];
    const next = new URL(window.location.href);
    next.searchParams.set("robot", option.dataset.robotId);
    next.searchParams.set("task", option.value);
    next.searchParams.set("language", app.language);
    if (app.running) stopProgram();
    dispose();
    window.location.assign(next);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!document.fullscreenElement) event.preventDefault();
      stopProgram();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      elements.save.click();
    }
  });
  window.addEventListener("beforeunload", saveAllDrafts);
  window.addEventListener("pagehide", dispose, { once: true });
  bindCollapsibles();
}

function dispose() {
  if (app.disposed) return;
  app.disposed = true;
  app.runToken += 1;
  app.equipment?.dispose();
  app.workspace?.dispose();
  app.simulation?.dispose?.();
  app.arduinoPreview?.resizeObserver?.disconnect?.();
}

async function init() {
  try {
    app.catalog = await fetchJson("missions/lab-assistant/index.json");
    let summary = selectedSummary();
    if (!summary) {
      summary = app.catalog.tasks[0];
      app.robotId = summary.robotId;
      app.taskId = summary.id;
    }
    app.definition = await fetchJson(summary.definition);
    const manifest = initializeRegistry();
    populateDefinition();
    initializeSimulation(manifest);
    app.engine = new LabScenarioEngine(app.definition, app.simulation);
    initializeBlockly();
    bindEvents();
    switchLanguage(app.language, { initial: true });
    renderState();
    elements.loading.hidden = true;
    elements.shell.hidden = false;
    window.lucide?.createIcons();
    window.setTimeout(() => app.blockly?.svgResize(app.workspace), 0);
  } catch (error) {
    elements.loading.hidden = true;
    elements.error.hidden = false;
    elements.error.querySelector("p").textContent = `${error.message} Serve RoboBuddy through HTTP rather than opening the file directly, then retry.`;
  }
}

init();
