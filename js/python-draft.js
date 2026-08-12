(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const HOME_ANGLES = [90, 90, 90, 90, 90, 90];
  const JOINT_LIMITS = NS.Generator ? NS.Generator.JOINT_LIMITS : [[20, 130], [15, 165], [0, 180], [0, 180], [0, 180], [25, 130]];
  const MOTORS_STORAGE_KEY = "roboadmin.motorsEnabled.v1";
  const OUTPUT_PANEL_COLLAPSED_STORAGE_KEY = "roboadmin.pythonOutputPanelCollapsed.v1";
  const EXPECTED_FIRMWARE_PROFILE_ID = "RA1";
  const BLOCKS_FILE_SCHEMA = "robobuddy.blocks.v1";
  const BLOCKS_FILE_ACCEPT = ".robobuddy-blocks.json,.json";
  const PYTHON_FILE_ACCEPT = ".py,.txt";
  const JSON_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
  const PYTHON_IMPORT_MAX_BYTES = 1024 * 1024;
  const MAX_PYTHON_COMMANDS = 1000;
  const PYTHON_TIMEOUT_MS = 8000;
  const DISCONNECT_PARK_SPEED = 50;
  const CONTROL_OWNER = {
    IDLE: "idle",
    PROGRAM: "program"
  };
  const TIER1_MISSION_FILES = [
    "python-quick-start.json",
    "safety-basics.json",
    "first-joint-move.json",
    "robot-wave.json",
    "gripper-open-close.json",
    "lekiwi-drive-square.json",
    "lekiwi-mobile-pick-preview.json",
    "unitree-g1-walk-grab-return.json"
  ];
  const QUICK_START_PYTHON = [
    "robot.home()",
    'robot.move_joint("base", 100, speed=50)',
    "robot.wait(0.5)",
    "print(robot.get_joints())"
  ].join("\n");
  const QUICK_START_MISSION = Object.freeze({
    id: "python-quick-start",
    title: "Python Quick Start",
    robotIds: ["arduino_arm"],
    difficulty: "beginner",
    brief: "Home the Arduino arm, move the base safely, wait, and inspect joint values.",
    starterPython: QUICK_START_PYTHON
  });
  const ALLOWED_URL_EXAMPLES = Object.freeze({
    "python-quick-start": Object.freeze({ missionId: "python-quick-start", robotId: "arduino_arm" })
  });

  const state = {
    angles: HOME_ANGLES.slice(),
    poses: {},
    workspace: null,
    serial: null,
    preview3d: null,
    storage: null,
    runner: null,
    motorsEnabled: false,
    controlOwner: CONTROL_OWNER.IDLE,
    firmwareMismatch: null,
    serialLines: [],
    outputLines: [],
    blockReferenceCommands: null,
    lastGeneratedPython: "",
    pythonWorker: null,
    pythonRequestId: 0,
    pendingPythonRun: null,
    pythonRuntimeReady: false,
    pythonBusy: false,
    editor: null,
    resizeQueued: false,
    outputPanelCollapsed: true,
    outputPanel: null,
    jointState: null,
    tier1Missions: [],
    lastSyncedRobotId: null,
    activeMode: "python",
    savedPython: "",
    pythonSourceKind: "starter",
    suppressEditorChange: false,
    pageInitialized: false,
    urlExampleHandled: false,
    bridgeSessionStatus: "none",
    bridgeArmPending: false,
    copyableStatusText: "",
    copyStatusResetTimer: 0
  };

  const ui = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheUi();
    setupEditor();
    markPythonSaved("starter");
    initRobotUi();
    initSharedWorkbenchUi();

    NS.Blocks.registerBlocks();
    ui.toolbox.innerHTML = NS.Blocks.toolboxXml();

    state.workspace = Blockly.inject("pythonBlocklyDiv", {
      toolbox: ui.toolbox,
      theme: NS.Blocks.createTheme(),
      renderer: "zelos",
      grid: {
        spacing: 20,
        length: 2,
        colour: "#d7deea",
        snap: true
      },
      zoom: {
        controls: true,
        wheel: true,
        startScale: 0.9,
        maxScale: 1.5,
        minScale: 0.45,
        scaleSpeed: 1.15
      },
      trashcan: true
    });

    state.serial = new NS.SerialManager({ baudRate: 9600 });
    const previewRegistry = window.RoboBuddy3DPreview || {};
    const ArmPreview3D = previewRegistry.ArmPreview3D || NS.ArmPreview;
    if (typeof ArmPreview3D === "function" && ui.arm3dFallbackSvg) {
      state.preview3d = new ArmPreview3D(ui.arm3dFallbackSvg, {
        jointLimits: JOINT_LIMITS,
        initialAngles: state.angles,
        cameraPreset: "compact"
      });
    } else {
      mark3dPreviewUnavailable();
    }
    state.storage = new NS.ProgramStorage();

    NS.getPoseNames = () => Object.keys(state.poses).sort((a, b) => a.localeCompare(b));

    state.runner = new NS.ProgramRunner({
      serial: state.serial,
      getAngles: () => state.angles.slice(),
      applyAngles: (angles) => applyAngles(angles, { source: "runner" }),
      getPose: (name) => (state.poses[name] ? state.poses[name].slice() : null),
      savePose: (name, angles) => {
        state.poses[name] = angles.slice();
        setStatus(`Pose saved: ${name}`);
      }
    });

    state.motorsEnabled = readMotorsEnabled();

    wireSerialEvents();
    wireRunnerEvents();
    wireButtons();
    wireRobotUi();
    selectProgramMode("python", { focus: false });
    createPythonWorker();
    loadInitialWorkspace();
    applyAngles(getActiveInitialAngles(), { source: "init" });
    syncRobotPreviewVisibility();
    syncMotorsToggleUi();
    updateRunControls();
    appendOutput("Python runtime loading...");
    state.pageInitialized = true;

    window.addEventListener("resize", scheduleLayoutRefresh);
    if (ui.workbench) {
      ui.workbench.addEventListener(NS.WorkbenchUI.LAYOUT_EVENT, scheduleLayoutRefresh);
    }
    window.addEventListener("unload", destroySharedWorkbenchUi, { once: true });

    if (!state.serial.supportsWebSerial()) {
      ui.btnConnect.disabled = true;
      setConnectionStatus(false, "Web Serial unavailable");
    }
    window.addEventListener("pagehide", () => {
      if (NS.RobotRuntime && typeof NS.RobotRuntime.disarmBridgeForPageExit === "function") {
        NS.RobotRuntime.disarmBridgeForPageExit();
      }
    }, { capture: true });
    void restoreSo101BridgeSession();
  }

  function cacheUi() {
    ui.workbench = document.querySelector(".python-workbench");
    ui.statusDot = document.getElementById("statusDot");
    ui.statusText = document.getElementById("statusText");
    ui.programStatus = document.getElementById("programStatus");
    ui.programStatusIcon = document.getElementById("programStatusIcon");
    ui.outputDrawer = document.querySelector(".python-output-drawer");
    ui.btnCopyProgramStatus = document.getElementById("btnCopyProgramStatus");
    ui.btnConnect = document.getElementById("btnConnect");
    ui.btnHome = document.getElementById("btnHome");
    ui.btnEmergencyStop = document.getElementById("btnEmergencyStop");
    ui.btnMainPage = document.getElementById("btnMainPage");
    ui.robotChooser = document.getElementById("pythonRobotChooser");
    ui.executionTarget = document.querySelector("[data-execution-target]");
    ui.btnLoadCodeExample = document.getElementById("btnLoadCodeExample");
    ui.codeExampleMenu = document.getElementById("pythonCodeExampleMenu");
    ui.codeExampleItems = document.querySelector("[data-code-example-items]");
    ui.fileMenuTrigger = document.getElementById("btnPythonFileMenu");
    ui.fileMenu = document.getElementById("pythonFileMenu");
    ui.modeTabs = Array.from(document.querySelectorAll("[data-python-mode]"));
    ui.blocklyPanel = document.getElementById("pythonBlocklyPanel");
    ui.pythonPanel = document.getElementById("pythonPythonPanel");
    ui.modeOnly = Array.from(document.querySelectorAll("[data-mode-only]"));
    ui.fileBadge = document.getElementById("pythonFileBadge");
    ui.fileState = document.getElementById("pythonFileState");

    ui.toolbox = document.getElementById("pythonToolbox");
    ui.blocklyDiv = document.getElementById("pythonBlocklyDiv");
    ui.pythonEditor = document.getElementById("pythonEditor");
    ui.pythonRuntimeStatus = document.getElementById("pythonRuntimeStatus");
    ui.effectCard = document.getElementById("pythonEffectCard");
    ui.effectStatus = document.getElementById("pythonEffectStatus");
    ui.commandSummary = document.getElementById("pythonCommandSummary");
    ui.outputLog = document.getElementById("pythonOutputLog");
    ui.serialLog = document.getElementById("pythonSerialLog");
    ui.arm3dFallbackSvg = document.getElementById("pythonArm3dFallbackSvg");
    ui.previewSketchPanel = document.getElementById("pythonPreviewSketchPanel");
    ui.robotSimPreview = document.getElementById("pythonRobotSimPreview");
    ui.outputPanelToggle = document.getElementById("btnOutputPanelToggle");
    ui.outputPanelBody = document.getElementById("pythonOutputPanelBody");
    ui.jointStatePanel = document.getElementById("pythonJointStatePanel");
    ui.jointStateToggle = document.getElementById("pythonJointStateToggle");
    ui.jointStateBody = document.getElementById("pythonJointStateBody");
    ui.jointStateCount = document.getElementById("pythonJointStateCount");
    ui.motorsEnabled = document.getElementById("pythonMotorsEnabled");
    ui.motorsLabel = document.getElementById("pythonMotorsLabel");
    ui.btnRunBlocks = document.getElementById("btnRunBlocks");
    ui.btnConvertPython = document.getElementById("btnConvertPython");
    ui.btnConvertRunPython = document.getElementById("btnConvertRunPython");
    ui.btnRunPython = document.getElementById("btnRunPython");
    ui.btnPause = document.getElementById("btnDraftPause");
    ui.btnStop = document.getElementById("btnDraftStop");
    ui.btnLoadExample = document.getElementById("btnLoadExample");
    ui.btnSaveBlocks = document.getElementById("btnSaveBlocks");
    ui.btnLoadUserBlocks = document.getElementById("btnLoadUserBlocks");
    ui.btnClearWorkspace = document.getElementById("btnClearWorkspace");
    ui.btnSavePython = document.getElementById("btnSavePython");
    ui.btnLoadPython = document.getElementById("btnLoadPython");
    ui.btnCopyPython = document.getElementById("btnCopyPython");
    ui.btnClearOutput = document.getElementById("btnClearOutput");
  }

  function initSharedWorkbenchUi() {
    const workbenchUi = NS.WorkbenchUI;
    if (!workbenchUi) {
      throw new Error("The shared RoboBuddy workbench UI module is unavailable.");
    }
    state.outputPanel = new workbenchUi.CollapsiblePanel({
      root: ui.outputPanelToggle ? ui.outputPanelToggle.closest(".python-output-drawer") : null,
      toggle: ui.outputPanelToggle,
      body: ui.outputPanelBody,
      label: "Output & Serial",
      defaultExpanded: false,
      readExpanded: () => !readStoredOutputPanelCollapsed(true),
      writeExpanded: (expanded) => localStorage.setItem(OUTPUT_PANEL_COLLAPSED_STORAGE_KEY, expanded ? "false" : "true"),
      onChange: (expanded) => {
        state.outputPanelCollapsed = !expanded;
        scheduleLayoutRefresh();
      }
    });
    state.outputPanelCollapsed = !state.outputPanel.expanded;

    const adapter = workbenchUi.createJointStateAdapter({
      getManifest: () => activeManifest(),
      getValues: () => state.angles
    });
    state.jointState = new workbenchUi.JointStateView({
      root: ui.jointStatePanel,
      toggle: ui.jointStateToggle,
      body: ui.jointStateBody,
      list: ui.jointStateBody,
      count: ui.jointStateCount,
      adapter,
      storageKey: "robobuddy:panel:python:joint-state:v1",
      defaultExpanded: true,
      rowSelector: "[data-python-joint-row]",
      rowAttribute: "data-python-joint-row",
      valueIdPrefix: "pythonJointValue",
      onExpandedChange: scheduleLayoutRefresh
    });
  }

  function destroySharedWorkbenchUi() {
    if (state.outputPanel) state.outputPanel.destroy();
    if (state.jointState) state.jointState.destroy();
  }

  function setupEditor() {
    if (!window.CodeMirror || !ui.pythonEditor) {
      if (ui.pythonEditor) {
        ui.pythonEditor.addEventListener("input", handlePythonEditorChange);
      }
      return;
    }

    state.editor = window.CodeMirror.fromTextArea(ui.pythonEditor, {
      mode: "python",
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      lineWrapping: true,
      viewportMargin: Infinity
    });
    state.editor.setSize("100%", "100%");
    const editorInput = state.editor.getInputField();
    if (editorInput) {
      editorInput.setAttribute("aria-label", "Python code editor");
    }
    state.editor.on("change", handlePythonEditorChange);
  }

  function initRobotUi() {
    if (NS.RobotRuntime && ui.robotSimPreview) {
      NS.RobotRuntime.init({ container: ui.robotSimPreview });
    }
    renderRobotChooser();
    void loadTier1Missions();
  }

  function activeManifest() {
    return NS.RobotRegistry && NS.RobotRegistry.getActive ? NS.RobotRegistry.getActive() : null;
  }

  function activeRobotId() {
    const manifest = activeManifest();
    return manifest ? manifest.id : "arduino_arm";
  }

  function isArduinoActive() {
    return activeRobotId() === "arduino_arm";
  }

  function activeJoints() {
    const manifest = activeManifest();
    return manifest && Array.isArray(manifest.joints) ? manifest.joints : [];
  }

  function getActiveHomeAngles() {
    return NS.RobotSafety && activeManifest() ? NS.RobotSafety.getHomeAngles(activeManifest()) : HOME_ANGLES.slice();
  }

  function getActiveInitialAngles() {
    return NS.RobotSafety && activeManifest() && typeof NS.RobotSafety.getInitialAngles === "function"
      ? NS.RobotSafety.getInitialAngles(activeManifest())
      : getActiveHomeAngles();
  }

  function getActiveJointLimits() {
    return NS.RobotSafety && activeManifest() ? NS.RobotSafety.getJointLimits(activeManifest()) : JOINT_LIMITS.slice();
  }

  function getActiveJointState() {
    const joints = {};
    activeJoints().forEach((joint, index) => {
      const value = state.angles[index] ?? joint.home ?? 0;
      joints[joint.id] = NS.RobotSafety && typeof NS.RobotSafety.clampJointValue === "function"
        ? NS.RobotSafety.clampJointValue(joint, value)
        : Math.min(Number(joint.max), Math.max(Number(joint.min), Number(value)));
    });
    return joints;
  }

  function renderRobotChooser() {
    if (!ui.robotChooser || !NS.RobotRegistry) {
      return;
    }
    const active = activeRobotId();
    ui.robotChooser.innerHTML = NS.RobotRegistry.list().map((manifest) => (
      `<option value="${escapeHtml(manifest.id)}"${manifest.id === active ? " selected" : ""}>${escapeHtml(manifest.name)}</option>`
    )).join("");
  }

  async function loadTier1Missions() {
    try {
      const results = await Promise.all(TIER1_MISSION_FILES.map((file) => (
        fetch(`missions/tier1/${file}`)
          .then((res) => res.ok ? res.json() : null)
          .catch(() => null)
      )));
      const byId = new Map([[QUICK_START_MISSION.id, QUICK_START_MISSION]]);
      results.filter(Boolean).forEach((mission) => byId.set(mission.id, mission));
      state.tier1Missions = Array.from(byId.values());
    } catch (error) {
      state.tier1Missions = [QUICK_START_MISSION];
    }
    updateCodeExampleMenu();
    await waitForPageInitialization();
    ensureStarterForActiveRobot();
    applyAllowlistedExampleFromUrl();
  }

  function codeExampleMissions() {
    const robotId = activeRobotId();
    return state.tier1Missions.filter((mission) => (
      Array.isArray(mission.robotIds) &&
      mission.robotIds.includes(robotId) &&
      typeof mission.starterPython === "string" &&
      mission.starterPython.trim()
    ));
  }

  function updateCodeExampleMenu() {
    if (!ui.codeExampleItems) {
      return;
    }
    const missions = codeExampleMissions();
    if (missions.length === 0) {
      const manifest = activeManifest();
      const robotName = manifest ? (manifest.shortName || manifest.name) : "this robot";
      ui.codeExampleItems.innerHTML = `<p class="python-draft__example-empty">No code examples for ${escapeHtml(robotName)}.</p>`;
      return;
    }
    ui.codeExampleItems.innerHTML = missions.map((mission) => `
      <button class="python-draft__example-item" type="button" role="menuitem" data-code-example-id="${escapeHtml(mission.id)}">
        <i data-lucide="file-code-2" aria-hidden="true"></i>
        <span><strong>${escapeHtml(mission.title)}</strong><small>${escapeHtml(mission.brief || mission.difficulty || "Example code")}</small></span>
      </button>
    `).join("");
    if (window.lucide) {
      lucide.createIcons({ nodes: Array.from(ui.codeExampleItems.querySelectorAll("[data-lucide]")) });
    }
  }

  function setCodeExampleMenuOpen(open) {
    if (!ui.btnLoadCodeExample || !ui.codeExampleMenu) {
      return;
    }
    const shouldOpen = Boolean(open);
    if (shouldOpen) {
      updateCodeExampleMenu();
    }
    ui.codeExampleMenu.hidden = !shouldOpen;
    ui.btnLoadCodeExample.setAttribute("aria-expanded", String(shouldOpen));
  }

  function loadCodeExample(missionId) {
    if (state.runner.isRunning() || state.pythonBusy) {
      setStatus("Wait for the active run to finish before loading example code.");
      return;
    }
    const mission = state.tier1Missions.find((item) => item.id === missionId);
    if (!mission) {
      setStatus("Example code not found");
      return;
    }
    if (!Array.isArray(mission.robotIds) || !mission.robotIds.includes(activeRobotId())) {
      setStatus("Example code is not available for the selected robot.");
      return;
    }
    if (!mission.starterPython || !mission.starterPython.trim()) {
      setStatus("Example has no Python snippet.");
      return;
    }
    setPythonEditorValue(mission.starterPython, { dirty: true, sourceKind: "example" });
    state.blockReferenceCommands = null;
    state.lastGeneratedPython = "";
    updateCommandSummary("-");
    updateEffectStatus("Example code loaded. Run to validate commands.", "warning");
    setStatus(`Loaded example code: ${mission.title}`);
    selectProgramMode("python", { focus: false });
    updateRunControls();
  }

  function wireRobotUi() {
    if (ui.robotChooser) {
      ui.robotChooser.addEventListener("change", async () => {
        clearRobotScopedBlocklyState();
        if (NS.RobotRuntime) {
          if (
            activeRobotId() === "so101_follower" &&
            ui.robotChooser.value !== "so101_follower" &&
            NS.RobotRuntime.isBridgeConnected &&
            NS.RobotRuntime.isBridgeConnected()
          ) {
            await NS.RobotRuntime.setBridgeSafetyConfirmed(false).catch(() => NS.RobotRuntime.stopHardware());
          }
          NS.RobotRuntime.setActive(ui.robotChooser.value);
        } else if (NS.RobotRegistry) {
          NS.RobotRegistry.setActive(ui.robotChooser.value);
        }
      });
    }
    window.addEventListener("robobuddy:active-robot-change", () => {
      syncRobotUi();
      closeAllMenus();
      updateCodeExampleMenu();
      setStatus(`Robot switched to ${activeManifest().name}`);
      if (activeRobotId() === "so101_follower") {
        void restoreSo101BridgeSession();
      } else {
        state.bridgeSessionStatus = "none";
        syncExecutionContext();
      }
    });
    syncRobotUi();
    updateCodeExampleMenu();
  }

  function syncRobotUi() {
    const robotId = activeRobotId();
    if (state.lastSyncedRobotId && state.lastSyncedRobotId !== robotId) {
      clearRobotScopedBlocklyState();
    }
    if (ui.robotChooser) {
      ui.robotChooser.value = robotId;
    }
    if (NS.Blocks && typeof NS.Blocks.refreshToolbox === "function") {
      NS.Blocks.refreshToolbox(state.workspace, ui.toolbox);
    }
    syncConnectButton();
    syncMotorsToggleUi();
    syncRobotPreviewVisibility();
    applyAngles(getActiveInitialAngles(), { source: "robot-switch" });
    state.lastSyncedRobotId = robotId;
    ensureStarterForActiveRobot();
  }

  function clearRobotScopedBlocklyState() {
    if (!state.workspace || state.workspace.getTopBlocks(false).length === 0) {
      return;
    }
    state.workspace.clear();
    state.blockReferenceCommands = null;
    state.lastGeneratedPython = "";
    updateCommandSummary("-");
    updateEffectStatus("Blockly workspace cleared for the selected robot.", "warning");
    scheduleBlocklyResize();
  }

  function syncRobotPreviewVisibility() {
    const showArduino = isArduinoActive();
    if (ui.previewSketchPanel) {
      ui.previewSketchPanel.hidden = !showArduino;
      if (showArduino && state.preview3d && typeof state.preview3d.resize === "function") {
        window.requestAnimationFrame(() => state.preview3d.resize());
      }
    }
    if (ui.robotSimPreview) {
      ui.robotSimPreview.hidden = showArduino;
      if (!showArduino && NS.RobotRuntime) {
        NS.RobotRuntime.render(ui.robotSimPreview);
      }
    }
  }

  function mark3dPreviewUnavailable() {
    const container = ui.previewSketchPanel
      ? ui.previewSketchPanel.querySelector(".arm-preview-container")
      : null;
    if (!container) {
      return;
    }
    container.classList.add("is-3d-unavailable");
    const preview = container.querySelector("[data-arm-preview-3d]");
    if (preview) {
      preview.hidden = true;
    }
    const fallbackStatus = container.querySelector("[data-arm-preview-3d-fallback-status]");
    if (fallbackStatus) {
      fallbackStatus.hidden = false;
      fallbackStatus.textContent = "3D preview unavailable.";
    }
  }

  function getPythonEditorValue() {
    return state.editor ? state.editor.getValue() : (ui.pythonEditor.value || "");
  }

  function setPythonEditorValue(code, options = {}) {
    state.suppressEditorChange = true;
    if (state.editor) {
      state.editor.setValue(code || "");
      window.requestAnimationFrame(() => state.editor.refresh());
    } else {
      ui.pythonEditor.value = code || "";
    }
    state.suppressEditorChange = false;
    if (options.saved) {
      markPythonSaved(options.sourceKind || "starter");
    } else if (options.dirty) {
      state.pythonSourceKind = options.sourceKind || "example";
      renderPythonFileState(true);
    } else {
      syncPythonFileState();
    }
  }

  function handlePythonEditorChange() {
    if (state.suppressEditorChange) {
      return;
    }
    state.blockReferenceCommands = null;
    state.lastGeneratedPython = "";
    updateCommandSummary("-");
    updateEffectStatus("Python changed. Validate & Run to check commands.", "warning");
    syncPythonFileState();
  }

  function markPythonSaved(sourceKind = "user") {
    state.savedPython = getPythonEditorValue();
    state.pythonSourceKind = sourceKind;
    renderPythonFileState(false);
  }

  function syncPythonFileState() {
    renderPythonFileState(getPythonEditorValue() !== state.savedPython);
  }

  function renderPythonFileState(dirty) {
    if (ui.fileBadge) {
      ui.fileBadge.dataset.state = dirty ? "dirty" : "saved";
      ui.fileBadge.title = dirty ? "robot_program.py — Unsaved changes" : "robot_program.py — Saved";
    }
    if (ui.fileState) {
      ui.fileState.textContent = dirty ? "Unsaved changes" : "Saved";
    }
  }

  function pythonFileIsDirty() {
    return getPythonEditorValue() !== state.savedPython;
  }

  function starterMissionForActiveRobot() {
    const robotId = activeRobotId();
    if (robotId === "arduino_arm") {
      return state.tier1Missions.find((mission) => mission.id === QUICK_START_MISSION.id) || QUICK_START_MISSION;
    }
    return state.tier1Missions.find((mission) => (
      Array.isArray(mission.robotIds) &&
      mission.robotIds.includes(robotId) &&
      typeof mission.starterPython === "string" &&
      mission.starterPython.trim()
    )) || null;
  }

  function ensureStarterForActiveRobot() {
    if (!state.editor && !ui.pythonEditor) {
      return;
    }
    if (state.pythonSourceKind !== "starter" || pythonFileIsDirty()) {
      return;
    }
    const mission = starterMissionForActiveRobot();
    if (!mission || !mission.starterPython || getPythonEditorValue() === mission.starterPython) {
      return;
    }
    setPythonEditorValue(mission.starterPython, { saved: true, sourceKind: "starter" });
    state.blockReferenceCommands = null;
    state.lastGeneratedPython = "";
    updateCommandSummary("-");
    updateEffectStatus(`Ready to validate for ${activeManifest().shortName || activeManifest().name}.`, "ready");
  }

  async function waitForPageInitialization() {
    const startedAt = Date.now();
    while (!state.pageInitialized && Date.now() - startedAt < 2000) {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
  }

  function applyAllowlistedExampleFromUrl() {
    if (state.urlExampleHandled) {
      return;
    }
    state.urlExampleHandled = true;
    const params = new URLSearchParams(window.location.search);
    const requestedId = String(params.get("example") || "").trim();
    if (!requestedId) {
      return;
    }
    const route = ALLOWED_URL_EXAMPLES[requestedId];
    if (!route) {
      setStatus(`Unknown example "${requestedId}". Editor unchanged.`);
      return;
    }

    if (NS.RobotRuntime) {
      NS.RobotRuntime.setActive(route.robotId);
    } else if (NS.RobotRegistry) {
      NS.RobotRegistry.setActive(route.robotId);
    }
    const mission = state.tier1Missions.find((item) => item.id === route.missionId) || QUICK_START_MISSION;
    setPythonEditorValue(mission.starterPython, { dirty: true, sourceKind: "example" });
    state.blockReferenceCommands = null;
    state.lastGeneratedPython = "";
    updateCommandSummary("-");
    updateEffectStatus("Quick Start loaded. Validate & Run when you are ready.", "warning");
    selectProgramMode("python", { focus: false });
    setStatus("Loaded Python Quick Start from Docs. Nothing has run.");
    updateRunControls();
  }

  function wireSerialEvents() {
    state.serial.addEventListener("status", (event) => {
      const detail = event.detail || {};
      const connected = Boolean(detail.connected);
      setConnectionStatus(connected, detail.message || "");
      appendSerial("SYS", `${connected ? "Connected" : "Disconnected"}: ${detail.message || "-"}`);
      syncConnectButton();
      updateRunControls();
    });

    state.serial.addEventListener("positions", (event) => {
      const angles = event.detail && Array.isArray(event.detail.angles) ? event.detail.angles : null;
      if (angles && isArduinoActive()) {
        applyAngles(angles, { source: "serial" });
      }
    });

    state.serial.addEventListener("tx", (event) => {
      const command = event.detail ? event.detail.command : "";
      if (command) {
        appendSerial("TX", command);
      }
    });

    state.serial.addEventListener("line", (event) => {
      const line = event.detail ? event.detail.line : "";
      if (!line) {
        return;
      }
      appendSerial("RX", line);
      if (line === "STOPPED") {
        setStatus("Emergency stop confirmed");
      } else if (line.startsWith("ERR")) {
        setStatus(`Device error: ${line}`);
      } else if (line === "READY") {
        setStatus("Device ready");
      }
    });
  }

  function wireRunnerEvents() {
    state.runner.addEventListener("status", (event) => {
      const text = event.detail ? event.detail.text : "";
      if (text) {
        setStatus(text);
      }
      updateRunControls();
    });

    state.runner.addEventListener("paused", updateRunControls);

    state.runner.addEventListener("running", (event) => {
      const running = Boolean(event.detail && event.detail.running);
      state.controlOwner = running ? CONTROL_OWNER.PROGRAM : CONTROL_OWNER.IDLE;
      updateRunControls();
    });

    state.runner.addEventListener("error", (event) => {
      const error = event.detail ? event.detail.error : null;
      if (error) {
        const presentation = formatRunnerError(error);
        setStatus(presentation.summary, { copyableText: presentation.detail });
        updateEffectStatus(presentation.detail, "error");
        appendOutput(`ERROR: ${presentation.detail}`);
        setOutputPanelCollapsed(false, { persist: false });
      }
      state.controlOwner = CONTROL_OWNER.IDLE;
      updateRunControls();
    });
  }

  function wireButtons() {
    document.addEventListener("keydown", handleGlobalEmergencyKey, true);
    wireProgramTabs();
    wireProgramMenus();

    ui.btnConnect.addEventListener("click", () => {
      void handleConnectToggle();
    });

    ui.btnHome.addEventListener("click", () => {
      void handleHome();
    });

    ui.btnEmergencyStop.addEventListener("click", () => {
      void handleEmergencyStop();
    });

    ui.motorsEnabled.addEventListener("change", (event) => {
      void setMotorsEnabled(Boolean(event.target && event.target.checked), { sendCommand: true });
    });

    ui.btnRunBlocks.addEventListener("click", () => {
      void runBlocklyProgram();
    });

    ui.btnConvertPython.addEventListener("click", () => {
      void convertBlocklyToPython({ runAfter: false });
    });

    ui.btnConvertRunPython.addEventListener("click", () => {
      void convertBlocklyToPython({ runAfter: true });
    });

    ui.btnRunPython.addEventListener("click", () => {
      void runPythonEditor();
    });

    ui.btnPause.addEventListener("click", () => {
      void handlePauseResume();
    });

    ui.btnStop.addEventListener("click", () => {
      void handleStop();
    });

    ui.btnLoadExample.addEventListener("click", () => {
      if (state.runner.isRunning() || state.pythonBusy) {
        setStatus("Wait for the active run to finish before loading example blocks.");
        return;
      }
      loadInitialWorkspace({ force: true });
      closeAllMenus();
    });

    if (ui.codeExampleMenu) {
      ui.codeExampleMenu.addEventListener("click", (event) => {
        const item = event.target.closest("[data-code-example-id]");
        if (!item) {
          return;
        }
        loadCodeExample(item.dataset.codeExampleId || "");
        closeAllMenus();
      });
    }

    if (ui.btnSaveBlocks) {
      ui.btnSaveBlocks.addEventListener("click", () => {
        void saveBlocksToFile();
        closeAllMenus();
      });
    }

    if (ui.btnLoadUserBlocks) {
      ui.btnLoadUserBlocks.addEventListener("click", () => {
        void loadBlocksFromFile();
        closeAllMenus();
      });
    }

    ui.btnClearWorkspace.addEventListener("click", () => {
      state.workspace.clear();
      state.blockReferenceCommands = null;
      state.lastGeneratedPython = "";
      updateEffectStatus("Build blocks, then convert to Python.", "ready");
      setStatus("Workspace cleared");
      closeAllMenus();
    });

    if (ui.btnSavePython) {
      ui.btnSavePython.addEventListener("click", () => {
        void savePythonToFile();
        closeAllMenus();
      });
    }

    if (ui.btnLoadPython) {
      ui.btnLoadPython.addEventListener("click", () => {
        void loadPythonFromFile();
        closeAllMenus();
      });
    }

    ui.btnCopyPython.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getPythonEditorValue());
        setStatus("Python copied");
      } catch (error) {
        setStatus("Copy failed (clipboard permission)");
      }
      closeAllMenus();
    });

    if (ui.btnCopyProgramStatus) {
      ui.btnCopyProgramStatus.addEventListener("click", async (event) => {
        event.stopPropagation();
        const text = state.copyableStatusText;
        if (!text) {
          return;
        }
        try {
          await copyTextToClipboard(text);
          setCopyStatusButtonState("Error details copied", "check");
        } catch (error) {
          setCopyStatusButtonState("Copy failed", "triangle-alert");
        }
        window.clearTimeout(state.copyStatusResetTimer);
        state.copyStatusResetTimer = window.setTimeout(() => {
          setCopyStatusButtonState("Copy error details", "copy");
        }, 2000);
      });
    }

    ui.btnClearOutput.addEventListener("click", () => {
      state.outputLines = [];
      ui.outputLog.textContent = "";
      setStatus("Python output cleared");
    });

  }

  function wireProgramTabs() {
    ui.modeTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        selectProgramMode(tab.dataset.pythonMode, { focus: false });
      });
      tab.addEventListener("keydown", (event) => {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key)) {
          return;
        }
        const currentIndex = ui.modeTabs.indexOf(tab);
        let nextIndex = currentIndex;
        if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = ui.modeTabs.length - 1;
        } else if (event.key === "ArrowLeft") {
          nextIndex = (currentIndex - 1 + ui.modeTabs.length) % ui.modeTabs.length;
        } else {
          nextIndex = (currentIndex + 1) % ui.modeTabs.length;
        }
        selectProgramMode(ui.modeTabs[nextIndex].dataset.pythonMode, { focus: true });
        event.preventDefault();
      });
    });
  }

  function selectProgramMode(mode, options = {}) {
    const nextMode = mode === "blockly" ? "blockly" : "python";
    state.activeMode = nextMode;
    document.body.dataset.workbenchMode = nextMode;
    ui.modeTabs.forEach((tab) => {
      const selected = tab.dataset.pythonMode === nextMode;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && options.focus) {
        tab.focus();
      }
    });
    if (ui.blocklyPanel) {
      ui.blocklyPanel.hidden = nextMode !== "blockly";
    }
    if (ui.pythonPanel) {
      ui.pythonPanel.hidden = nextMode !== "python";
    }
    ui.modeOnly.forEach((element) => {
      element.hidden = element.dataset.modeOnly !== nextMode;
    });
    closeAllMenus();
    scheduleLayoutRefresh();
  }

  function wireProgramMenus() {
    const menuPairs = [
      [ui.btnLoadCodeExample, ui.codeExampleMenu],
      [ui.fileMenuTrigger, ui.fileMenu]
    ].filter(([trigger, menu]) => trigger && menu);

    menuPairs.forEach(([trigger, menu]) => {
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        const willOpen = menu.hidden;
        closeAllMenus();
        setMenuOpen(trigger, menu, willOpen, { focusFirst: false });
      });
      trigger.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown") {
          return;
        }
        closeAllMenus();
        setMenuOpen(trigger, menu, true, { focusFirst: true });
        event.preventDefault();
      });
      menu.addEventListener("keydown", (event) => handleMenuKeydown(event, trigger, menu));
    });

    document.addEventListener("click", (event) => {
      const insideMenu = menuPairs.some(([trigger, menu]) => trigger.contains(event.target) || menu.contains(event.target));
      if (!insideMenu) {
        closeAllMenus();
      }
    });
  }

  function setMenuOpen(trigger, menu, open, options = {}) {
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open && options.focusFirst) {
      const firstItem = visibleMenuItems(menu)[0];
      if (firstItem) {
        firstItem.focus();
      }
    }
  }

  function closeAllMenus() {
    if (ui.btnLoadCodeExample && ui.codeExampleMenu) {
      setCodeExampleMenuOpen(false);
    }
    if (ui.fileMenuTrigger && ui.fileMenu) {
      setMenuOpen(ui.fileMenuTrigger, ui.fileMenu, false);
    }
  }

  function visibleMenuItems(menu) {
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter((item) => !item.hidden && !item.closest("[hidden]"));
  }

  function handleMenuKeydown(event, trigger, menu) {
    const items = visibleMenuItems(menu);
    const currentIndex = items.indexOf(document.activeElement);
    if (event.key === "Tab") {
      window.setTimeout(closeAllMenus, 0);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || items.length === 0) {
      return;
    }
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "ArrowDown") {
      nextIndex = (nextIndex + 1) % items.length;
    } else {
      nextIndex = (nextIndex - 1 + items.length) % items.length;
    }
    items[nextIndex].focus();
    event.preventDefault();
  }

  function handleGlobalEmergencyKey(event) {
    if (event.key !== "Escape" || event.__robobuddyEmergencyHandled) {
      return;
    }
    event.__robobuddyEmergencyHandled = true;
    event.preventDefault();
    event.stopImmediatePropagation();
    void handleEmergencyStop();
    closeAllMenus();
  }

  function createPythonWorker() {
    if (state.pythonWorker) {
      state.pythonWorker.terminate();
    }

    state.pythonRuntimeReady = false;
    state.pythonWorker = new Worker("js/python-worker.js?v=20260811-unitree-g1-solu-1");
    state.pythonWorker.addEventListener("message", onPythonWorkerMessage);
    state.pythonWorker.addEventListener("error", (event) => {
      state.pythonRuntimeReady = false;
      setPythonRuntimeStatus(`Python runtime error: ${event.message || "worker failed"}`, "error");
      if (state.pendingPythonRun) {
        finishPendingPythonRun({
          ok: false,
          commands: [],
          stdout: "",
          stderr: "",
          error: event.message || "Python worker failed",
          traceback: ""
        });
      }
      updateRunControls();
    });
    setPythonRuntimeStatus("Loading Python runtime...", "warning");
  }

  function onPythonWorkerMessage(event) {
    const data = event.data || {};
    if (data.type === "status") {
      if (data.phase === "ready") {
        state.pythonRuntimeReady = true;
        setPythonRuntimeStatus("Python runtime ready", "ready");
      } else {
        setPythonRuntimeStatus("Loading Python runtime...", "warning");
      }
      updateRunControls();
      return;
    }

    if (data.type === "result") {
      finishPendingPythonRun(data);
    }
  }

  function finishPendingPythonRun(data) {
    if (!state.pendingPythonRun || data.id !== state.pendingPythonRun.id) {
      return;
    }

    window.clearTimeout(state.pendingPythonRun.timeoutId);
    const pending = state.pendingPythonRun;
    state.pendingPythonRun = null;
    state.pythonBusy = false;
    updateRunControls();
    pending.resolve(data);
  }

  function executePython(code) {
    if (!state.pythonWorker) {
      createPythonWorker();
    }

    if (state.pendingPythonRun) {
      return Promise.reject(new Error("Python is already running."));
    }

    state.pythonBusy = true;
    updateRunControls();
    const id = state.pythonRequestId + 1;
    state.pythonRequestId = id;

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!state.pendingPythonRun || state.pendingPythonRun.id !== id) {
          return;
        }
        state.pendingPythonRun = null;
        state.pythonBusy = false;
        state.pythonRuntimeReady = false;
        state.pythonWorker.terminate();
        state.pythonWorker = null;
        setPythonRuntimeStatus("Python runtime stopped after timeout", "error");
        createPythonWorker();
        updateRunControls();
        reject(new Error(`Python timed out after ${PYTHON_TIMEOUT_MS / 1000}s.`));
      }, PYTHON_TIMEOUT_MS);

      state.pendingPythonRun = { id, resolve, reject, timeoutId };
      state.pythonWorker.postMessage({
        type: "run",
        id,
        python: code,
        manifest: activeManifest(),
        activeRobotId: activeRobotId(),
        initialJoints: getActiveJointState(),
        poses: state.poses,
        maxCommands: MAX_PYTHON_COMMANDS
      });
    });
  }

  async function convertBlocklyToPython(options = {}) {
    if (state.runner.isRunning() || state.pythonBusy) {
      setStatus("Wait for the active run to finish before converting.");
      return false;
    }

    let blockCommands = [];
    try {
      blockCommands = getBlocklyCommands();
      if (blockCommands.length === 0) {
        setStatus("No blocks to convert");
        updateEffectStatus("Add at least one block before converting.", "warning");
        return false;
      }

      const emitted = NS.PythonEmitter.emit(state.workspace);
      setPythonEditorValue(emitted.code, { dirty: true, sourceKind: "conversion" });
      selectProgramMode("python", { focus: false });
      state.lastGeneratedPython = emitted.code;
      state.blockReferenceCommands = blockCommands;
      appendOutput("Converted Blockly workspace to Python.");
      if (emitted.warnings && emitted.warnings.length > 0) {
        appendOutput(emitted.warnings.join("\n"));
      }
    } catch (error) {
      setStatus(`Convert failed: ${error.message}`);
      updateEffectStatus(error.message, "error");
      return false;
    }

    const matches = await checkPythonEffect(getPythonEditorValue(), blockCommands);
    if (options.runAfter && matches) {
      return runPythonEditor();
    }
    return matches;
  }

  async function checkPythonEffect(code, referenceCommands) {
    try {
      setStatus("Checking generated Python effect...");
      const result = await executePython(code);
      appendPythonResult(result);
      if (!result.ok) {
        updateEffectStatus(`Python check failed: ${result.error || "unknown error"}`, "error");
        return false;
      }
      const commands = validatePythonCommands(result.commands || []);
      const same = commandsEqual(referenceCommands, commands);
      const summary = `${commands.length} Python commands vs ${referenceCommands.length} Blockly commands`;
      updateCommandSummary(summary);
      updateEffectStatus(
        same ? "Same effect confirmed" : "Python effect differs from Blockly",
        same ? "ready" : "warning"
      );
      setStatus(same ? "Same effect confirmed" : "Python effect differs from Blockly");
      return same;
    } catch (error) {
      updateEffectStatus(`Python check failed: ${error.message}`, "error");
      setStatus(`Python check failed: ${error.message}`);
      return false;
    }
  }

  async function runBlocklyProgram() {
    let commands = [];
    try {
      commands = getBlocklyCommands();
    } catch (error) {
      setStatus(`Could not prepare Blockly program: ${error.message}`);
      return false;
    }
    return runCommands(commands, state.workspace, "Blockly");
  }

  async function runPythonEditor() {
    const code = getPythonEditorValue();
    if (!code.trim()) {
      setStatus("Python editor is empty");
      updateEffectStatus("Write or convert Python before running.", "warning");
      return false;
    }

    try {
      setStatus("Preparing Python run...");
      if (
        bridgeExecutionRequired() &&
        NS.RobotRuntime &&
        typeof NS.RobotRuntime.refreshBridgeState === "function"
      ) {
        const programAvailability = typeof NS.RobotRuntime.getProgramAvailability === "function"
          ? NS.RobotRuntime.getProgramAvailability()
          : null;
        if (programAvailability && programAvailability.available === false) {
          throw new Error(programAvailability.reason);
        }
        await NS.RobotRuntime.refreshBridgeState({ strict: true });
        const measuredAngles = NS.RobotRuntime.getMeasuredJointArray
          ? NS.RobotRuntime.getMeasuredJointArray()
          : NS.RobotRuntime.getJointArray();
        applyAngles(measuredAngles, { source: "bridge-program-seed" });
      }
      const result = await executePython(code);
      appendPythonResult(result);
      if (!result.ok) {
        setStatus(`Python error: ${result.error || "unknown error"}`);
        updateEffectStatus(`Python error: ${result.error || "unknown error"}`, "error");
        return false;
      }

      const commands = validatePythonCommands(result.commands || []);
      updateCommandSummary(`${commands.length} Python commands ready`);
      if (state.blockReferenceCommands) {
        const same = commandsEqual(state.blockReferenceCommands, commands);
        updateEffectStatus(
          same ? "Same effect confirmed" : "Python differs from last Blockly conversion",
          same ? "ready" : "warning"
        );
      } else {
        updateEffectStatus("Python command list validated", "ready");
      }
      return runCommands(commands, null, "Python");
    } catch (error) {
      setStatus(`Python run failed: ${error.message}`);
      updateEffectStatus(`Python run failed: ${error.message}`, "error");
      return false;
    }
  }

  async function runCommands(commands, workspace, label) {
    if (!Array.isArray(commands) || commands.length === 0) {
      setStatus(`${label} has no commands to run`);
      return false;
    }
    if (state.runner.isRunning() || state.controlOwner === CONTROL_OWNER.PROGRAM) {
      setStatus("Program already running");
      return false;
    }
    if (!ensureSo101HardwareReady(`${label} run`)) {
      return false;
    }
    if (isArduinoActive() && state.serial.isConnected() && !ensureMotionAllowed()) {
      return false;
    }

    setStatus(`Starting ${label} run (${commands.length} steps)...`);
    try {
      await state.runner.run(commands, workspace);
      return true;
    } catch (error) {
      setStatus(`${label} run failed: ${error.message}`);
      return false;
    }
  }

  function getBlocklyCommands() {
    const commands = NS.Generator.generateCommands(state.workspace);
    return Array.isArray(commands) ? commands : [];
  }

  function validatePythonCommands(rawCommands) {
    if (!NS.RobotCommandSchema) {
      if (!Array.isArray(rawCommands)) {
        throw new Error("Python did not return a command list.");
      }
      return rawCommands;
    }
    return NS.RobotCommandSchema.validateCommandList(rawCommands, { activeRobotId: activeRobotId() });
  }

  function validatePythonCommand(command, index) {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error(`Command ${index + 1} is not an object.`);
    }
    const type = String(command.type || "");
    switch (type) {
      case "servo": {
        const servo = intInRange(command.servo, 0, 5, `Command ${index + 1} servo`);
        const limits = JOINT_LIMITS[servo] || [0, 180];
        const angle = intInRange(command.angle, limits[0], limits[1], `Command ${index + 1} angle`);
        const speed = intInRange(command.speed, 1, 100, `Command ${index + 1} speed`);
        return { type, servo, angle, speed };
      }
      case "home":
      case "emergencyStop":
        return { type };
      case "delay": {
        const ms = intInRange(command.ms, 0, 30000, `Command ${index + 1} delay`);
        return { type, ms };
      }
      case "savePose": {
        const name = safePoseName(command.name, `Command ${index + 1} pose`);
        return { type, name };
      }
      case "goPose": {
        const name = safePoseName(command.name, `Command ${index + 1} pose`);
        const speed = intInRange(command.speed, 1, 100, `Command ${index + 1} speed`);
        return { type, name, speed };
      }
      case "smoothMove": {
        const servo = intInRange(command.servo, 0, 5, `Command ${index + 1} servo`);
        const limits = JOINT_LIMITS[servo] || [0, 180];
        const from = intInRange(command.from, limits[0], limits[1], `Command ${index + 1} start angle`);
        const to = intInRange(command.to, limits[0], limits[1], `Command ${index + 1} end angle`);
        const durationMs = intInRange(command.durationMs, 200, 10000, `Command ${index + 1} duration`);
        return { type, servo, from, to, durationMs };
      }
      default:
        throw new Error(`Command ${index + 1} has unsupported type: ${type || "(missing)"}.`);
    }
  }

  function commandsEqual(left, right) {
    return JSON.stringify(normalizeCommands(left)) === JSON.stringify(normalizeCommands(right));
  }

  function normalizeCommands(commands) {
    return (Array.isArray(commands) ? commands : []).map((command) => {
      if (!command || typeof command !== "object") {
        return command;
      }
      const type = command.type;
      if (type === "servo") {
        return {
          type,
          servo: Number(command.servo),
          angle: Number(command.angle),
          speed: Number(command.speed)
        };
      }
      if (type === "delay") {
        return { type, ms: Number(command.ms) };
      }
      if (type === "savePose") {
        return { type, name: String(command.name || "") };
      }
      if (type === "goPose") {
        return { type, name: String(command.name || ""), speed: Number(command.speed) };
      }
      if (type === "smoothMove") {
        return {
          type,
          servo: Number(command.servo),
          from: Number(command.from),
          to: Number(command.to),
          durationMs: Number(command.durationMs)
        };
      }
      if (type === "home" || type === "emergencyStop") {
        return { type };
      }
      if (type === "move_joint") {
        return {
          type,
          robotId: String(command.robotId || ""),
          joint: String(command.joint || ""),
          value: Number(command.value),
          speed: Number(command.speed)
        };
      }
      if (type === "move_joints") {
        return {
          type,
          robotId: String(command.robotId || ""),
          joints: command.joints || {},
          speed: Number(command.speed)
        };
      }
      if (type === "set_gripper") {
        const normalized = {
          type,
          robotId: String(command.robotId || ""),
          speed: Number(command.speed)
        };
        if (command.joints && typeof command.joints === "object") {
          normalized.side = String(command.side || "both");
          normalized.joints = command.joints;
        } else {
          normalized.value = Number(command.value);
        }
        return normalized;
      }
      if (type === "wait") {
        return { type, seconds: Number(command.seconds) };
      }
      if (type === "drive") {
        return {
          type,
          robotId: String(command.robotId || ""),
          vx: Number(command.vx),
          vy: Number(command.vy),
          omega: Number(command.omega),
          seconds: Number(command.seconds)
        };
      }
      if (type === "stop") {
        return { type, robotId: String(command.robotId || "") };
      }
      return { type };
    });
  }

  async function handleConnectToggle() {
    if (activeRobotId() === "so101_follower") {
      await toggleSo101BridgeArm();
      return;
    }
    if (!isArduinoActive()) {
      setStatus("LeKiwi is simulation-only in Tier 1.");
      return;
    }
    if (state.serial.isConnected()) {
      try {
        await parkBeforeDisconnect();
        await state.serial.disconnect();
        setStatus("Serial disconnected");
      } catch (error) {
        setStatus(`Disconnect failed: ${error.message}`);
      }
      return;
    }

    ui.statusDot.classList.add("is-connecting");
    ui.statusText.textContent = "Connecting serial device...";
    try {
      setStatus("Requesting serial port (USB/Bluetooth)...");
      await state.serial.connect();
      setStatus("Connected. Waiting for READY...");
      try {
        await state.serial.waitForReady(3000);
      } catch (readyError) {
        appendSerial("SYS", "READY not received within 3s");
      }
      await state.serial.attachAll();
      const profileOk = await ensureFirmwareProfileCompatible("python-draft-connect");
      if (!profileOk) {
        return;
      }
      try {
        const positions = await state.serial.queryPositions();
        if (Array.isArray(positions)) {
          applyAngles(positions, { source: "connect-query" });
        }
      } catch (queryError) {
        appendSerial("SYS", `Position sync failed: ${queryError.message}`);
      }
      if (!state.motorsEnabled) {
        await state.serial.emergencyStop();
        setStatus("Serial connected; motors disabled");
      } else {
        setStatus("Serial connected and synchronized");
      }
    } catch (error) {
      setStatus(`Connect failed: ${error.message}`);
      ui.statusDot.classList.remove("is-connecting");
    }
  }

  async function parkBeforeDisconnect() {
    if (!state.serial.isConnected() || state.runner.isRunning() || !state.motorsEnabled || state.firmwareMismatch) {
      return false;
    }
    try {
      setStatus("Moving to safe park pose before disconnect...");
      await state.serial.attachAll();
      for (let servo = 0; servo < HOME_ANGLES.length; servo += 1) {
        await state.serial.moveServo(servo, clampAngle(servo, HOME_ANGLES[servo]), DISCONNECT_PARK_SPEED);
      }
      applyAngles(HOME_ANGLES, { source: "disconnect-park" });
      return true;
    } catch (error) {
      appendSerial("SYS", `Safe park before disconnect failed: ${error.message}`);
      return false;
    }
  }

  async function handleHome() {
    if (!isArduinoActive()) {
      if (activeRobotId() === "so101_follower" && bridgeExecutionRequired()) {
        if (!ensureSo101HardwareReady("Home")) {
          return;
        }
        try {
          await NS.RobotRuntime.applyCommand({ type: "home", robotId: "so101_follower" });
          applyAngles(NS.RobotRuntime.getJointArray(), { source: "bridge-home" });
          setStatus("SO-101 moved to Home through the retained local bridge");
        } catch (error) {
          setStatus(`SO-101 Home failed: ${error.message}`);
        }
        return;
      }
      if (NS.RobotRuntime) {
        NS.RobotRuntime.home();
        applyAngles(NS.RobotRuntime.getJointArray(), { source: "home" });
      }
      setStatus(`${activeManifest().shortName || activeManifest().name} moved to home pose`);
      return;
    }
    if (state.serial.isConnected() && !ensureMotionAllowed()) {
      return;
    }
    try {
      if (state.serial.isConnected()) {
        await state.serial.home();
      }
      applyAngles(HOME_ANGLES, { source: "home" });
      setStatus("Moved to home position");
    } catch (error) {
      setStatus(`Home failed: ${error.message}`);
    }
  }

  async function handleEmergencyStop() {
    terminatePythonRun("Python stopped by emergency stop");
    state.runner.stop();
    let hardwareStopError = null;
    if (NS.RobotRuntime) {
      try {
        if (activeRobotId() === "so101_follower" && bridgeExecutionRequired()) {
          await NS.RobotRuntime.stopHardware();
        } else {
          NS.RobotRuntime.stop();
        }
      } catch (error) {
        hardwareStopError = error;
      }
    }
    try {
      if (state.serial.isConnected()) {
        await state.serial.emergencyStop();
      }
      await setMotorsEnabled(false, { sendCommand: false });
      setStatus(hardwareStopError
        ? `Emergency stop was not confirmed: ${hardwareStopError.message}`
        : "Emergency stop triggered");
    } catch (error) {
      setStatus(`Emergency stop failed: ${error.message}`);
    }
  }

  async function handlePauseResume() {
    if (!state.runner.isRunning()) {
      return;
    }
    if (state.runner.isPaused()) {
      setStatus("Resuming program...");
      await state.runner.resume();
    } else {
      setStatus("Pausing program...");
      await state.runner.pause();
    }
    updateRunControls();
  }

  async function handleStop() {
    if (state.pendingPythonRun) {
      terminatePythonRun("Python stopped");
      setStatus("Python stopped");
      return;
    }
    if (!state.runner.isRunning()) {
      return;
    }
    try {
      setStatus("Stopping program...");
      await state.runner.stop({ mode: "immediate" });
      await waitForRunnerIdle(1800);
      setStatus("Program stopped");
    } catch (error) {
      setStatus(`Stop failed: ${error.message}`);
    } finally {
      updateRunControls();
    }
  }

  function terminatePythonRun(message) {
    if (state.pendingPythonRun) {
      window.clearTimeout(state.pendingPythonRun.timeoutId);
      state.pendingPythonRun.reject(new Error(message || "Python stopped"));
      state.pendingPythonRun = null;
    }
    state.pythonBusy = false;
    state.pythonRuntimeReady = false;
    if (state.pythonWorker) {
      state.pythonWorker.terminate();
      state.pythonWorker = null;
    }
    createPythonWorker();
    updateRunControls();
  }

  async function setMotorsEnabled(enabled, options = {}) {
    if (!isArduinoActive()) {
      state.motorsEnabled = false;
      localStorage.setItem(MOTORS_STORAGE_KEY, "0");
      syncMotorsToggleUi();
      setStatus("Motors toggle is only available for the Arduino arm in Tier 1.");
      return false;
    }
    const requested = Boolean(enabled);
    if (requested && state.firmwareMismatch) {
      setStatus(state.firmwareMismatch.message || "Firmware mismatch detected. Motors remain disabled.");
      state.motorsEnabled = false;
      syncMotorsToggleUi();
      return;
    }

    state.motorsEnabled = requested;
    localStorage.setItem(MOTORS_STORAGE_KEY, state.motorsEnabled ? "1" : "0");
    syncMotorsToggleUi();

    if (!state.motorsEnabled && state.runner.isRunning()) {
      state.runner.stop();
    }

    if (options.sendCommand !== false && state.serial.isConnected()) {
      try {
        if (state.motorsEnabled) {
          await state.serial.attachAll();
        } else {
          await state.serial.emergencyStop();
        }
      } catch (error) {
        setStatus(`Motor toggle failed: ${error.message}`);
      }
    }

    setStatus(state.motorsEnabled ? "Motors enabled" : "Motors disabled");
  }

  function ensureMotionAllowed() {
    if (state.firmwareMismatch) {
      setStatus(state.firmwareMismatch.message || "Firmware mismatch detected. Reflash required.");
      return false;
    }
    if (!state.motorsEnabled) {
      setStatus("Motors are disabled. Enable Motors Enabled first.");
      return false;
    }
    return true;
  }

  async function ensureFirmwareProfileCompatible(source) {
    if (!isArduinoActive()) {
      return true;
    }
    let profile = null;
    try {
      profile = await state.serial.getFirmwareProfile();
    } catch (error) {
      return activateFirmwareMismatch(`profile query failed: ${error.message}`, source);
    }

    const issues = [];
    const profileId = String(profile.id || "").trim();
    if (profileId !== EXPECTED_FIRMWARE_PROFILE_ID) {
      issues.push(`profile ${profileId || "(missing)"} expected ${EXPECTED_FIRMWARE_PROFILE_ID}`);
    }
    const gripperLimits = JOINT_LIMITS[5] || [25, 130];
    if (Number(profile.gripperMin) !== gripperLimits[0] || Number(profile.gripperMax) !== gripperLimits[1]) {
      issues.push(`gripper ${profile.gripperMin}..${profile.gripperMax} expected ${gripperLimits[0]}..${gripperLimits[1]}`);
    }
    if (issues.length > 0) {
      return activateFirmwareMismatch(issues.join("; "), source);
    }

    state.firmwareMismatch = null;
    appendOutput(`Firmware profile verified: ${profileId}`);
    return true;
  }

  async function activateFirmwareMismatch(reason, source) {
    const message = `Firmware mismatch detected (${reason}). Reflash required.`;
    state.firmwareMismatch = { message, source };
    await setMotorsEnabled(false, { sendCommand: false });
    try {
      if (state.serial.isConnected()) {
        await state.serial.emergencyStop({ immediate: true });
      }
    } catch (error) {
      appendSerial("SYS", `Mismatch guard stop failed: ${error.message}`);
    }
    setStatus(message);
    return false;
  }

  function appendPythonResult(result) {
    if (result.stdout) {
      appendOutput(result.stdout.trimEnd());
    }
    if (result.stderr) {
      appendOutput(result.stderr.trimEnd());
    }
    if (!result.ok && result.error) {
      appendOutput(result.error);
      if (result.traceback) {
        appendOutput(result.traceback.trimEnd());
      }
    }
  }

  function appendOutput(text) {
    const value = String(text || "");
    if (!value) {
      return;
    }
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    state.outputLines.push(`[${timestamp}] ${value}`);
    while (state.outputLines.length > 160) {
      state.outputLines.shift();
    }
    ui.outputLog.textContent = state.outputLines.join("\n");
    ui.outputLog.scrollTop = ui.outputLog.scrollHeight;
  }

  function appendSerial(kind, text) {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    state.serialLines.push(`[${timestamp}] ${kind}: ${text}`);
    while (state.serialLines.length > 160) {
      state.serialLines.shift();
    }
    ui.serialLog.textContent = state.serialLines.join("\n");
    ui.serialLog.scrollTop = ui.serialLog.scrollHeight;
  }

  function applyAngles(nextAngles) {
    if (!Array.isArray(nextAngles)) {
      return;
    }
    const joints = activeJoints();
    const fallback = getActiveHomeAngles();
    state.angles = joints.map((joint, index) => {
      const raw = index < nextAngles.length ? nextAngles[index] : fallback[index];
      return clampAngle(index, raw);
    });
    if (isArduinoActive() && state.preview3d) {
      state.preview3d.setAngles(state.angles);
    }
    if (!isArduinoActive() && NS.RobotRuntime) {
      NS.RobotRuntime.updateJointsFromArray(state.angles);
      NS.RobotRuntime.render(ui.robotSimPreview);
    }
    if (state.jointState) {
      state.jointState.refresh();
    }
  }

  function loadInitialWorkspace(options = {}) {
    if (!isArduinoActive()) {
      if (options.force) {
        setStatus(`${activeManifest().shortName || activeManifest().name} starts from missions or Python.`);
      }
      return;
    }
    if (!options.force && state.workspace.getTopBlocks(false).length > 0) {
      return;
    }
    const program = state.storage.getProgram("Wave Hello");
    if (!program) {
      return;
    }
    try {
      state.workspace.clear();
      Blockly.Xml.domToWorkspace(parseWorkspaceXml(program.xml), state.workspace);
      state.blockReferenceCommands = null;
      state.lastGeneratedPython = "";
      if (options.force) {
        setStatus("Loaded example blocks: Wave Hello");
        updateEffectStatus("Build blocks, then convert to Python.", "ready");
      }
      scheduleBlocklyResize();
    } catch (error) {
      setStatus("Could not load startup example");
    }
  }

  async function saveBlocksToFile() {
    const fileApi = NS.FileWorkflows;
    if (!fileApi || typeof fileApi.saveJsonFile !== "function") {
      setStatus("Block save failed: file helper unavailable.");
      return;
    }

    try {
      const blockXml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(state.workspace));
      const payload = buildBlockDiagramFile(blockXml, getCurrentPageSource());
      const result = await fileApi.saveJsonFile(payload, {
        suggestedName: `robobuddy-python-blocks-${slugTimestamp()}.robobuddy-blocks.json`,
        accept: BLOCKS_FILE_ACCEPT,
        description: "RoboBuddy block diagram"
      });
      if (!result.ok) {
        setStatus(result.canceled ? "Block save canceled." : `Block save failed: ${result.error ? result.error.message || result.error : "unknown error"}`);
        return;
      }
      setStatus(result.name ? `Blocks saved: ${result.name}` : "Blocks saved to local file.");
    } catch (error) {
      setStatus(`Block save failed: ${error.message}`);
    }
  }

  async function loadBlocksFromFile() {
    if (state.runner.isRunning() || state.pythonBusy) {
      setStatus("Wait for the active run to finish before loading blocks.");
      return;
    }
    const fileApi = NS.FileWorkflows;
    if (!fileApi || typeof fileApi.openTextFile !== "function") {
      setStatus("Block load failed: file helper unavailable.");
      return;
    }

    const result = await fileApi.openTextFile({
      accept: BLOCKS_FILE_ACCEPT,
      description: "RoboBuddy block diagram",
      maxBytes: JSON_IMPORT_MAX_BYTES
    });
    if (!result.ok) {
      setStatus(result.canceled ? "Block load canceled." : `Block load failed: ${result.error ? result.error.message || result.error : "unknown error"}`);
      return;
    }

    try {
      const blockXml = parseBlockDiagramFile(result.text);
      const xml = parseWorkspaceXml(blockXml);
      state.workspace.clear();
      Blockly.Xml.domToWorkspace(xml, state.workspace);
      state.blockReferenceCommands = null;
      state.lastGeneratedPython = "";
      updateEffectStatus("Build blocks, then convert to Python.", "ready");
      setStatus(`Loaded user blocks${result.name ? `: ${result.name}` : ""}.`);
      scheduleBlocklyResize();
    } catch (error) {
      setStatus(`Block load failed: ${error.message}`);
    }
  }

  async function savePythonToFile() {
    const fileApi = NS.FileWorkflows;
    if (!fileApi || typeof fileApi.saveTextFile !== "function") {
      setStatus("Python save failed: file helper unavailable.");
      return;
    }
    const result = await fileApi.saveTextFile(getPythonEditorValue(), {
      suggestedName: "robot_program.py",
      accept: PYTHON_FILE_ACCEPT,
      description: "Python code",
      mimeType: "text/plain;charset=utf-8"
    });
    if (!result.ok) {
      setStatus(result.canceled ? "Python save canceled." : `Python save failed: ${result.error ? result.error.message || result.error : "unknown error"}`);
      return;
    }
    markPythonSaved("user");
    setStatus(result.name ? `Python saved: ${result.name}` : "Python saved to local file.");
  }

  async function loadPythonFromFile() {
    if (state.runner.isRunning() || state.pythonBusy) {
      setStatus("Wait for the active run to finish before loading Python.");
      return;
    }
    const fileApi = NS.FileWorkflows;
    if (!fileApi || typeof fileApi.openTextFile !== "function") {
      setStatus("Python load failed: file helper unavailable.");
      return;
    }
    const result = await fileApi.openTextFile({
      accept: PYTHON_FILE_ACCEPT,
      description: "Python code",
      mimeType: "text/plain",
      maxBytes: PYTHON_IMPORT_MAX_BYTES
    });
    if (!result.ok) {
      setStatus(result.canceled ? "Python load canceled." : `Python load failed: ${result.error ? result.error.message || result.error : "unknown error"}`);
      return;
    }
    setPythonEditorValue(result.text, { saved: true, sourceKind: "file" });
    state.blockReferenceCommands = null;
    state.lastGeneratedPython = "";
    updateCommandSummary("-");
    updateEffectStatus("Python loaded. Run to validate commands.", "warning");
    setStatus(`Loaded Python${result.name ? `: ${result.name}` : ""}.`);
    updateRunControls();
  }

  function buildBlockDiagramFile(blockXml, sourcePage) {
    return {
      schema: BLOCKS_FILE_SCHEMA,
      kind: "block-diagram",
      source: sourcePage || getCurrentPageSource(),
      app: "RoboBuddy",
      savedAt: new Date().toISOString(),
      payload: {
        blockXml: String(blockXml || "")
      }
    };
  }

  function getCurrentPageSource() {
    const fallback = "python.html";
    try {
      const filename = String(window.location && window.location.pathname ? window.location.pathname : "")
        .split("/")
        .filter(Boolean)
        .pop();
      return filename || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function parseBlockDiagramFile(text) {
    let data = null;
    try {
      data = JSON.parse(String(text || ""));
    } catch (error) {
      throw new Error("File is not valid JSON.");
    }

    if (!data || typeof data !== "object" || data.schema !== BLOCKS_FILE_SCHEMA || data.kind !== "block-diagram") {
      throw new Error(`Expected ${BLOCKS_FILE_SCHEMA} block diagram file.`);
    }

    const payload = data.payload && typeof data.payload === "object" ? data.payload : null;
    const blockXml = payload && typeof payload.blockXml === "string" ? payload.blockXml : "";
    if (!blockXml.trim()) {
      throw new Error("Block file does not contain Blockly XML.");
    }
    return blockXml;
  }

  function slugTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("") + "-" + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join("");
  }

  function parseWorkspaceXml(xmlText) {
    let xml = null;
    if (Blockly.utils && Blockly.utils.xml && typeof Blockly.utils.xml.textToDom === "function") {
      xml = Blockly.utils.xml.textToDom(xmlText);
    } else if (Blockly.Xml && typeof Blockly.Xml.textToDom === "function") {
      xml = Blockly.Xml.textToDom(xmlText);
    } else {
      const doc = new DOMParser().parseFromString(xmlText, "text/xml");
      if (!doc.documentElement || doc.getElementsByTagName("parsererror").length > 0) {
        throw new Error("Blockly XML could not be parsed.");
      }
      xml = doc.documentElement;
    }

    if (!xml || String(xml.nodeName || "").toLowerCase() !== "xml") {
      throw new Error("Blockly XML must use an <xml> root.");
    }
    return xml;
  }

  function scheduleLayoutRefresh() {
    if (state.resizeQueued) {
      return;
    }
    state.resizeQueued = true;
    const runRefresh = () => {
      if (state.workspace && window.Blockly && Blockly.svgResize) {
        Blockly.svgResize(state.workspace);
      }
      if (state.editor && typeof state.editor.refresh === "function") {
        state.editor.refresh();
      }
      if (state.preview3d && typeof state.preview3d.resize === "function") {
        state.preview3d.resize();
      }
    };
    window.requestAnimationFrame(() => {
      state.resizeQueued = false;
      runRefresh();
      window.setTimeout(runRefresh, 120);
      window.setTimeout(runRefresh, 300);
    });
  }

  function scheduleBlocklyResize() {
    scheduleLayoutRefresh();
  }

  function updateRunControls() {
    const runnerRunning = Boolean(state.runner && state.runner.isRunning());
    const runnerPaused = runnerRunning && state.runner.isPaused();
    const busy = runnerRunning || state.pythonBusy;
    const canRun = !busy;
    ui.btnRunBlocks.disabled = !canRun;
    ui.btnConvertPython.disabled = busy;
    ui.btnConvertRunPython.disabled = busy;
    ui.btnRunPython.disabled = busy || !state.pythonRuntimeReady;
    if (ui.btnLoadExample) {
      ui.btnLoadExample.disabled = busy;
    }
    if (ui.btnLoadCodeExample) {
      ui.btnLoadCodeExample.disabled = busy;
      if (busy) {
        setCodeExampleMenuOpen(false);
      }
    }
    if (ui.btnLoadUserBlocks) {
      ui.btnLoadUserBlocks.disabled = busy;
    }
    if (ui.btnLoadPython) {
      ui.btnLoadPython.disabled = busy;
    }
    ui.btnPause.disabled = !runnerRunning;
    ui.btnStop.disabled = !busy;
    const pauseLabel = runnerPaused ? "Resume active program" : "Pause active program";
    ui.btnPause.setAttribute("aria-label", pauseLabel);
    const pauseText = ui.btnPause.querySelector("span");
    if (pauseText) {
      pauseText.textContent = runnerPaused ? "Resume" : "Pause";
    }
    const pauseTool = ui.btnPause.closest(".python-draft__tool");
    if (pauseTool) {
      pauseTool.dataset.hint = runnerPaused ? "Resume" : "Pause";
    }
    const pauseIcon = ui.btnPause.querySelector("[data-lucide]");
    if (pauseIcon && window.lucide) {
      pauseIcon.setAttribute("data-lucide", runnerPaused ? "play" : "pause");
      lucide.createIcons({ nodes: [pauseIcon] });
    }
    updateStatusIcon(
      runnerPaused ? "pause" : (busy ? "loader" : "circle-check"),
      busy && !runnerPaused,
      false,
      runnerPaused
    );
  }

  function syncConnectButton() {
    const runtimeState = NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    const bridgeConnected = Boolean(
      activeRobotId() === "so101_follower" &&
      runtimeState &&
      runtimeState.connection &&
      runtimeState.connection.connected
    );
    const bridgeArmed = Boolean(bridgeConnected && NS.RobotRuntime.isBridgeArmed && NS.RobotRuntime.isBridgeArmed());
    const connected = Boolean(isArduinoActive() && state.serial && state.serial.isConnected());
    const span = ui.btnConnect.querySelector("span");
    if (span) {
      span.textContent = activeRobotId() === "so101_follower"
        ? (bridgeConnected ? (bridgeArmed ? "Disarm" : "Arm Motion") : "Setup Bridge")
        : (!isArduinoActive() ? "Sim Only" : (connected ? "Disconnect" : "Connect"));
    }
    ui.btnConnect.disabled = activeRobotId() === "so101_follower"
      ? state.bridgeArmPending
      : (!isArduinoActive() || !state.serial || !state.serial.supportsWebSerial());
    const icon = ui.btnConnect.querySelector("[data-lucide]");
    if (icon && window.lucide) {
      icon.setAttribute("data-lucide", activeRobotId() === "so101_follower"
        ? (bridgeArmed ? "shield-off" : "shield-check")
        : (connected ? "unlink" : "plug"));
      lucide.createIcons({ nodes: [icon] });
    }
    syncExecutionContext();
  }

  function bridgeExecutionRequired() {
    if (activeRobotId() !== "so101_follower" || !NS.RobotRuntime) {
      return false;
    }
    const runtimeState = NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    return Boolean(
      (runtimeState && runtimeState.mode === "local_bridge") ||
      (NS.RobotRuntime.hasBridgeSession && NS.RobotRuntime.hasBridgeSession())
    );
  }

  function ensureSo101HardwareReady(action) {
    if (!bridgeExecutionRequired()) {
      return true;
    }
    if (!NS.RobotRuntime.isBridgeConnected || !NS.RobotRuntime.isBridgeConnected()) {
      setStatus(`${action} blocked: the retained SO-101 bridge is unavailable. Return to Main and reconnect.`);
      updateEffectStatus("Hardware execution blocked; commands were not sent to simulation.", "error");
      return false;
    }
    if (!NS.RobotRuntime.isBridgeArmed || !NS.RobotRuntime.isBridgeArmed()) {
      setStatus(`${action} blocked: select Arm Motion for this page first.`);
      updateEffectStatus("SO-101 is connected but motion is disarmed.", "warning");
      return false;
    }
    return true;
  }

  async function restoreSo101BridgeSession() {
    if (
      activeRobotId() !== "so101_follower" ||
      !NS.RobotRuntime ||
      typeof NS.RobotRuntime.hasBridgeSession !== "function" ||
      !NS.RobotRuntime.hasBridgeSession() ||
      typeof NS.RobotRuntime.reattachBridgeSession !== "function"
    ) {
      state.bridgeSessionStatus = "none";
      syncConnectButton();
      setConnectionStatus(false, activeRobotId() === "so101_follower" ? "Simulation · Bridge setup on Main" : undefined);
      return false;
    }
    state.bridgeSessionStatus = "reattaching";
    ui.statusDot.classList.add("is-connecting");
    setConnectionStatus(false, "Reattaching SO-101 bridge…");
    const result = await NS.RobotRuntime.reattachBridgeSession({ disarm: true });
    state.bridgeSessionStatus = result.status;
    if (!result.attached) {
      setConnectionStatus(false, "Bridge unavailable");
      setStatus(result.error && result.error.message
        ? result.error.message
        : "The retained SO-101 bridge is no longer connected. Return to Main to reconnect.");
      syncConnectButton();
      return false;
    }
    const angles = NS.RobotRuntime.getMeasuredJointArray
      ? NS.RobotRuntime.getMeasuredJointArray()
      : NS.RobotRuntime.getJointArray();
    applyAngles(angles, { source: "bridge-reattach" });
    setConnectionStatus(true, "Connected · Disarmed");
    setStatus("SO-101 connection retained. Select Arm Motion before running hardware commands.");
    updateEffectStatus("Local bridge attached; motion is disarmed for this page.", "warning");
    syncConnectButton();
    return true;
  }

  async function toggleSo101BridgeArm() {
    if (!NS.RobotRuntime) {
      return false;
    }
    if (!NS.RobotRuntime.isBridgeConnected || !NS.RobotRuntime.isBridgeConnected()) {
      const restored = await restoreSo101BridgeSession();
      if (!restored) {
        setStatus("Set up and connect the SO-101 from the Main page first.");
        return false;
      }
    }
    state.bridgeArmPending = true;
    syncConnectButton();
    try {
      const arm = !(NS.RobotRuntime.isBridgeArmed && NS.RobotRuntime.isBridgeArmed());
      const runtimeState = await NS.RobotRuntime.setBridgeSafetyConfirmed(arm);
      const armed = Boolean(runtimeState && runtimeState.connection && runtimeState.connection.armedForMotion);
      setConnectionStatus(true, armed ? "Connected · Armed" : "Connected · Disarmed");
      setStatus(armed ? "SO-101 armed for explicit hardware runs on this page." : "SO-101 motion disarmed; physical connection retained.");
      updateEffectStatus(armed ? "Hardware execution enabled for this page." : "Hardware motion is disarmed.", armed ? "ready" : "warning");
      return armed;
    } catch (error) {
      setStatus(`SO-101 arm change failed: ${error.message}`);
      return false;
    } finally {
      state.bridgeArmPending = false;
      syncConnectButton();
    }
  }

  function syncExecutionContext() {
    if (!ui.executionTarget) {
      return;
    }
    const bridgeConnected = Boolean(
      activeRobotId() === "so101_follower" &&
      NS.RobotRuntime &&
      NS.RobotRuntime.isBridgeConnected &&
      NS.RobotRuntime.isBridgeConnected()
    );
    const bridgeIntent = bridgeExecutionRequired();
    const serialHardware = Boolean(isArduinoActive() && state.serial && state.serial.isConnected());
    const hardware = bridgeConnected || serialHardware;
    const label = bridgeConnected ? "Local Bridge" : (serialHardware ? "Hardware" : (bridgeIntent ? "Bridge unavailable" : "Simulation"));
    ui.executionTarget.dataset.executionTarget = hardware ? "hardware" : (bridgeIntent ? "hardware-unavailable" : "simulation");
    ui.executionTarget.setAttribute("aria-label", `Execution target: ${label}`);
    const span = ui.executionTarget.querySelector("span");
    if (span) span.textContent = label;
    const icon = ui.executionTarget.querySelector("[data-lucide]");
    if (icon && window.lucide) {
      icon.setAttribute("data-lucide", hardware || bridgeIntent ? "cable" : "monitor");
      lucide.createIcons({ nodes: [icon] });
    }
  }

  function syncMotorsToggleUi() {
    const available = isArduinoActive();
    ui.motorsEnabled.checked = available && state.motorsEnabled;
    ui.motorsEnabled.disabled = !available;
    if (ui.motorsLabel) {
      ui.motorsLabel.textContent = available ? (state.motorsEnabled ? "Motors On" : "Motors Off") : "Motors N/A";
    }
    updateRunControls();
  }

  function readMotorsEnabled() {
    const raw = localStorage.getItem(MOTORS_STORAGE_KEY);
    return raw === "1" || raw === "true";
  }

  function readStoredOutputPanelCollapsed(fallback) {
    try {
      const raw = localStorage.getItem(OUTPUT_PANEL_COLLAPSED_STORAGE_KEY);
      if (raw === "false") {
        return false;
      }
      if (raw === "true") {
        return true;
      }
    } catch (error) {
      return fallback !== false;
    }
    return fallback !== false;
  }

  function setOutputPanelCollapsed(collapsed, options = {}) {
    const nextCollapsed = Boolean(collapsed);
    if (state.outputPanel) {
      state.outputPanel.setExpanded(!nextCollapsed, {
        persist: Boolean(options.persist),
        reason: options.reason || "python-output-api"
      });
      state.outputPanelCollapsed = nextCollapsed;
      return;
    }
    if (options.updateState !== false) {
      state.outputPanelCollapsed = nextCollapsed;
    }
    if (ui.outputPanelBody) {
      ui.outputPanelBody.hidden = nextCollapsed;
    }
    if (ui.outputPanelToggle) {
      ui.outputPanelToggle.setAttribute("aria-expanded", nextCollapsed ? "false" : "true");
      ui.outputPanelToggle.title = nextCollapsed ? "Show Output & Serial" : "Hide Output & Serial";
      ui.outputPanelToggle.dataset.hint = nextCollapsed ? "Show Output & Serial" : "Hide Output & Serial";
    }
    if (options.persist) {
      try {
        localStorage.setItem(OUTPUT_PANEL_COLLAPSED_STORAGE_KEY, nextCollapsed ? "true" : "false");
      } catch (error) {
        // Optional.
      }
    }
    scheduleLayoutRefresh();
  }

  function setConnectionStatus(connected, text) {
    ui.statusDot.classList.toggle("is-connected", connected);
    ui.statusDot.classList.remove("is-connecting");
    ui.statusText.textContent = text || (connected ? "Connected" : "Disconnected");
    syncExecutionContext();
  }

  function formatStatusNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return "?";
    }
    return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
  }

  function formatRunnerError(error) {
    const fallback = error && error.message ? error.message : String(error || "Unknown error");
    if (!error || error.code !== "TARGET_STEP_TOO_LARGE") {
      return {
        summary: "Program failed · Error details shown below",
        detail: `Runner error: ${fallback}`
      };
    }

    const jointDetails = error.details && error.details.joints;
    const steps = jointDetails && typeof jointDetails === "object"
      ? Object.entries(jointDetails)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([joint, detail]) => {
          const current = Number(detail && detail.current);
          const target = Number(detail && detail.target);
          const limit = Number(detail && detail.maxRelativeTarget);
          if (![current, target, limit].every(Number.isFinite)) {
            return null;
          }
          const step = Math.abs(target - current);
          return {
            joint,
            limit,
            text: `${joint}: ${formatStatusNumber(current)}° → ${formatStatusNumber(target)}° `
              + `needs ${formatStatusNumber(step)}°; limit ${formatStatusNumber(limit)}°`
          };
        })
        .filter(Boolean)
      : [];

    if (steps.length === 0) {
      return {
        summary: "Move blocked · Absolute step exceeds the safety limit",
        detail: "No motion sent. One or more absolute targets are too far from the measured pose. "
          + "Add smaller intermediate absolute targets."
      };
    }
    const limits = [...new Set(steps.map((step) => step.limit))];
    const limitLabel = limits.length === 1
      ? `${formatStatusNumber(limits[0])}° step limit`
      : "active step limits";
    return {
      summary: `Move blocked · ${steps.length} ${steps.length === 1 ? "joint exceeds" : "joints exceed"} the ${limitLabel}`,
      detail: `No motion sent. ${steps.map((step) => step.text).join("; ")}. `
        + "Add intermediate absolute targets within the stated limits."
    };
  }

  function setStatus(text, options = {}) {
    const value = String(text || "");
    const hadCopyableStatus = Boolean(state.copyableStatusText);
    ui.programStatus.textContent = value;
    state.copyableStatusText = options.copyableText
      ? String(options.copyableText)
      : (options.copyable ? value : "");
    ui.programStatus.title = state.copyableStatusText || value;
    if (ui.btnCopyProgramStatus) {
      ui.btnCopyProgramStatus.hidden = !state.copyableStatusText;
      window.clearTimeout(state.copyStatusResetTimer);
      if (state.copyableStatusText || hadCopyableStatus) {
        setCopyStatusButtonState("Copy error details", "copy");
      }
    }
  }

  function setCopyStatusButtonState(label, iconName) {
    if (!ui.btnCopyProgramStatus) {
      return;
    }
    ui.btnCopyProgramStatus.setAttribute("aria-label", label);
    ui.btnCopyProgramStatus.title = label;
    ui.btnCopyProgramStatus.dataset.hint = label;
    const currentIcon = ui.btnCopyProgramStatus.querySelector("svg, i");
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", iconName);
    icon.setAttribute("aria-hidden", "true");
    if (currentIcon) {
      currentIcon.replaceWith(icon);
    } else {
      ui.btnCopyProgramStatus.appendChild(icon);
    }
    if (window.lucide) {
      lucide.createIcons({ nodes: [icon] });
    }
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        // Fall through for browsers that expose Clipboard API but deny the write.
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("Clipboard write was denied.");
    }
  }

  function setPythonRuntimeStatus(text, tone) {
    ui.pythonRuntimeStatus.textContent = text;
    ui.pythonRuntimeStatus.dataset.tone = tone || "ready";
  }

  function updateEffectStatus(text, tone) {
    ui.effectStatus.textContent = text;
    ui.effectStatus.dataset.tone = tone || "ready";
    if (ui.effectCard) {
      ui.effectCard.dataset.tone = tone || "ready";
    }
  }

  function updateCommandSummary(text) {
    ui.commandSummary.textContent = text || "-";
  }

  function updateStatusIcon(iconName, isRunning, isError, isWarning) {
    if (!ui.programStatusIcon || !window.lucide) {
      return;
    }
    ui.programStatusIcon.setAttribute("data-lucide", iconName);
    ui.programStatusIcon.classList.toggle("is-running", Boolean(isRunning));
    ui.programStatusIcon.classList.toggle("is-error", Boolean(isError));
    ui.programStatusIcon.classList.toggle("is-warning", Boolean(isWarning));
    lucide.createIcons({ nodes: [ui.programStatusIcon] });
  }

  function intInRange(value, min, max, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) {
      throw new Error(`${label} must be ${min}..${max}.`);
    }
    return n;
  }

  function safePoseName(value, label) {
    const text = String(value || "").trim();
    if (!text) {
      throw new Error(`${label} name cannot be empty.`);
    }
    return text.slice(0, 40);
  }

  function clampAngle(servo, angle) {
    const limits = getActiveJointLimits()[servo] || [0, 180];
    const value = Number(angle);
    const safe = Number.isFinite(value) ? Math.round(value) : limits[0];
    return Math.min(limits[1], Math.max(limits[0], safe));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function waitForRunnerIdle(timeoutMs) {
    const start = Date.now();
    while (state.runner && state.runner.isRunning()) {
      if (Date.now() - start >= timeoutMs) {
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }
})();
