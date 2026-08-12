(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const HOME_ANGLES = [90, 90, 90, 90, 90, 90];
  const DEFAULT_RESET_ANGLES = [90, 90, 90, 90, 90, 90];
  const DEFAULT_RESET_SPEED = 50;
  const DEFAULT_RESET_NUDGE_DEG = 2;
  // Keep disconnect park pose conservative and easy to tune per rig calibration.
  const DISCONNECT_PARK_ANGLES = DEFAULT_RESET_ANGLES.slice();
  const DISCONNECT_PARK_SPEED = DEFAULT_RESET_SPEED;
  const JOINT_LIMITS = NS.Generator ? NS.Generator.JOINT_LIMITS : [[20, 130], [15, 165], [0, 180], [0, 180], [0, 180], [25, 130]];
  const MOTORS_STORAGE_KEY = "roboadmin.motorsEnabled.v1";
  const DEBUG_TELEMETRY_EXPANDED_STORAGE_KEY = "roboadmin.debugTelemetryExpanded.v1";
  const GRIPPER_MAPPING_STORAGE_KEY = "robobuddy.so101.gripperMapping.v1";
  const SO101_MANUAL_JOINT_LIMITS = Object.freeze({
    wrist_roll: Object.freeze([-43.2, 52.2])
  });
  const CONSOLE_MAX_LINES = 200;
  const CONTROL_OWNER = {
    IDLE: "idle",
    MANUAL: "manual",
    PROGRAM: "program"
  };
  const GRIPPER_SERVO = 5;
  const EXPECTED_FIRMWARE_PROFILE_ID = "RA1";
  const MANUAL_SESSION_RELEASE_MS = 180;
  const MANUAL_SEND_DEBOUNCE_MS = 55;
  const MANUAL_SEND_SPEED = 65;
  const MANUAL_SLIDER_COMMIT_DEDUPE_MS = 300;
  const TEACH_PHASE = {
    OFF: "off",
    IDLE: "idle",
    RECORDING: "recording",
    PAUSED: "paused",
    STOPPED: "stopped",
    REPLAYING: "replaying"
  };
  const TEACH_CAPTURE_THRESHOLD_DEG = 2;
  const TEACH_CAPTURE_DEBOUNCE_MS = 140;
  const TEACH_IR_MIN_STEP_MS = 40;
  const TEACH_SCRIPT_SCHEMA = "teach-script.v1";
  const TEACH_PROGRAM_NAME_PREFIX = "Teach";
  const BLOCKS_FILE_SCHEMA = "robobuddy.blocks.v1";
  const BLOCKS_FILE_ACCEPT = ".robobuddy-blocks.json,.json";
  const JSON_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
  const MAX_PROGRAM_NAME_LENGTH = 40;
  const DEBUG_CONSOLE_MAX_LINES = 220;
  const SERVO_NAMES = ["Base", "Shoulder", "Elbow", "Wrist Rot", "Wrist Tilt", "Gripper"];

  const state = {
    angles: HOME_ANGLES.slice(),
    poses: {},
    sliderTimers: new Map(),
    manualQueuedTargets: new Map(),
    manualSliderCommitHistory: new Map(),
    manualInFlight: new Set(),
    workspace: null,
    serial: null,
    preview: null,
    storage: null,
    runner: null,
    motorsEnabled: false,
    serialConsoleLines: [],
    controlOwner: CONTROL_OWNER.IDLE,
    manualControl: {
      activeServo: null,
      sessionToken: 0,
      releaseTimer: null,
      lockHintAt: 0,
      streamSessionId: "",
      streamSequence: 0,
      streamPending: null,
      streamInFlight: false,
      streamTimer: null,
      streamLastSentAt: 0,
      telemetryTimer: null,
      telemetryFailures: 0,
      pointerActive: false,
      keyboardActive: false,
      armHintTimer: null,
      lastArmHintAt: 0,
      lastAnnouncedPhase: ""
    },
    bridgeUi: {
      tested: false,
      portsLoaded: false,
      connected: false,
      calibrated: false,
      armed: false,
      authRequired: false,
      localNoToken: false,
      localNoTokenRejected: false,
      connecting: false,
      armPending: false,
      homePending: false,
      lastPayload: null
    },
    teach: {
      enabled: false,
      phase: TEACH_PHASE.OFF,
      currentSession: null,
      savedSessions: [],
      nextSessionId: 1,
      captureTimer: null,
      replayStopRequested: false,
      replayToken: 0
    },
    motorDebug: {
      activeServos: new Set(),
      pendingMotion: [],
      lastTx: "",
      lastRx: "",
      note: "",
      snapshot: ""
    },
    debugTelemetryExpanded: false,
    debugConsoleLines: [],
    programStopInProgress: false,
    programLastError: "",
    firmwareMismatch: null,
    pendingDefaultReset: false,
    lastSyncedRobotId: null,
    workbenchMode: "blockly",
    workbenchModeTransitioning: false,
    workbenchLayoutQueued: false,
    drawerTab: "bridge",
    drawerPinnedLeader: false
  };

  const ui = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheUi();
    mountWorkbenchDetails();
    initMotorDebugUi();
    initRobotPortalUi();

    NS.Blocks.registerBlocks();
    ui.toolbox.innerHTML = NS.Blocks.toolboxXml();

    state.workspace = Blockly.inject("blocklyDiv", {
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
        startScale: 0.95,
        maxScale: 1.6,
        minScale: 0.45,
        scaleSpeed: 1.15
      },
      trashcan: true
    });

    installBlocklyWorkspaceSemantics();

    state.serial = new NS.SerialManager({ baudRate: 9600 });
    if (typeof NS.ArmPreview === "function" && ui.armPreview) {
      state.preview = new NS.ArmPreview(ui.armPreview, {
        jointLimits: JOINT_LIMITS,
        onAnglesChange: (angles, meta) => onPreviewAnglesChange(angles, meta),
        onDragStateChange: (isDragging) => onPreviewDragStateChange(isDragging)
      });
    } else {
      mark3dPreviewUnavailable();
    }
    state.storage = new NS.ProgramStorage();

    NS.getPoseNames = () => Object.keys(state.poses).sort((a, b) => a.localeCompare(b));

    state.runner = new NS.ProgramRunner({
      serial: state.serial,
      getAngles: () => state.angles.slice(),
      applyAngles: (angles) => applyAngles(angles, { syncSliders: true, source: "runner" }),
      getPose: (name) => (state.poses[name] ? state.poses[name].slice() : null),
      savePose: (name, angles) => {
        state.poses[name] = angles.slice();
        setProgramStatus(`Pose saved: ${name}`);
      }
    });

    state.motorsEnabled = readMotorsEnabled();
    syncRobotSpecificUi();
    syncGripperMappingControl();

    wireSerialEvents();
    wireRunnerEvents();
    wireButtons();
    wireSliders();
    wireRobotPortalEvents();
    wireKeyboardShortcuts();

    syncSliderLimitsFromJointLimits();
    loadInitialWorkspace();
    applyAngles(getActiveInitialAngles(), { syncSliders: true, source: "init" });

    document.querySelectorAll(".servo-slider").forEach(updateSliderFill);
    syncMotorsToggleUi();
    updateManualControlLockUi();
    updateTeachControlsUi();
    if (NS.VirtualLeaderUI && typeof NS.VirtualLeaderUI.init === "function") {
      NS.VirtualLeaderUI.init({
        getWorkspace: () => state.workspace,
        onEmergencyStop: ({ source } = {}) => triggerEmergencyStop(source || "gamepad"),
        onWorkspaceResize: () => {
          if (state.workspace) Blockly.svgResize(state.workspace);
        }
      });
    }
    initWorkbenchPresentation();

    appendSerialConsole("SYS", "RoboBuddy ready");
    appendSerialConsole("SYS", state.motorsEnabled ? "Motors enabled" : "Motors disabled");
    appendSerialConsole("SYS", "Bluetooth tip: pair HC-05 in OS settings, then click Connect and choose the paired serial port.");
    updateMotorDebugUi();

    window.addEventListener("resize", () => {
      if (state.workspace) {
        Blockly.svgResize(state.workspace);
      }
    });

    if (isArduinoActive() && !state.serial.supportsWebSerial()) {
      ui.btnConnect.disabled = true;
      setConnectionStatus(false, "Web Serial unavailable (use desktop Chrome/Edge)");
    }
    window.addEventListener("pagehide", () => {
      if (NS.RobotRuntime && typeof NS.RobotRuntime.disarmBridgeForPageExit === "function") {
        NS.RobotRuntime.disarmBridgeForPageExit();
      }
    }, { capture: true });
    void restoreRetainedSo101Bridge();
  }

  function installBlocklyWorkspaceSemantics() {
    const blocklyHost = document.getElementById("blocklyDiv");
    if (!blocklyHost || typeof MutationObserver !== "function") {
      return;
    }
    const applyRoles = () => {
      blocklyHost.querySelectorAll("g.blocklyWorkspace[aria-label]").forEach((group) => {
        if (group.getAttribute("role") !== "group") {
          group.setAttribute("role", "group");
        }
      });
    };
    const observer = new MutationObserver(applyRoles);
    observer.observe(blocklyHost, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label", "role"]
    });
    applyRoles();
    window.requestAnimationFrame(applyRoles);
  }

  function cacheUi() {
    ui.toolbox = document.getElementById("toolbox");
    ui.robotChooser = document.getElementById("robotChooser");
    ui.panelBlock = document.getElementById("panelBlock");

    ui.armPreview = document.getElementById("armPreview");
    ui.robotSimPreview = document.getElementById("robotSimPreview");

    ui.statusDot = document.getElementById("statusDot");
    ui.statusText = document.getElementById("statusText");
    ui.programStatus = document.getElementById("programStatus");
    ui.programStatusIcon = document.getElementById("programStatusIcon");

    ui.btnConnect = document.getElementById("btnConnect");
    ui.btnHome = document.getElementById("btnHome");
    ui.btnResetDefault = document.getElementById("btnResetDefault");
    ui.btnEmergencyStop = document.getElementById("btnEmergencyStop");
    ui.btnRun = document.getElementById("btnRun");
    ui.btnPause = document.getElementById("btnPause");
    ui.btnStop = document.getElementById("btnStop");
    ui.programControlHint = document.getElementById("programControlHint");
    ui.btnSave = document.getElementById("btnSave");
    ui.btnLoad = document.getElementById("btnLoad");
    ui.btnLoadUserBlocks = document.getElementById("btnLoadUserBlocks");
    ui.btnClear = document.getElementById("btnClear");
    ui.manualControlsCard = document.querySelector(".sidebar__controls");
    ui.manualControlMeta = document.getElementById("manualControlMeta");
    ui.manualControlMetaText = document.getElementById("manualControlMetaText");
    ui.manualArmAction = document.getElementById("manualArmAction");
    ui.manualLimitInfo = document.getElementById("manualLimitInfo");
    ui.manualLimitDetails = document.getElementById("manualLimitDetails");
    ui.servoSliders = document.querySelector(".servo-sliders");
    ui.robotDriveControls = document.getElementById("robotDriveControls");
    ui.robotHumanoidControls = document.getElementById("robotHumanoidControls");
    ui.robotBridgePanel = document.getElementById("robotBridgePanel");
    ui.bridgeUrl = document.getElementById("bridgeUrl");
    ui.bridgePortSelect = document.getElementById("bridgePortSelect");
    ui.bridgeRobotInstance = document.getElementById("bridgeRobotInstance");
    ui.bridgeGripperMapping = document.getElementById("bridgeGripperMapping");
    ui.bridgeToken = document.getElementById("bridgeToken");
    ui.bridgeLocalNoToken = document.getElementById("bridgeLocalNoToken");
    ui.bridgeDiagnostics = document.querySelector(".robot-bridge-panel__advanced");
    ui.bridgeLimitDiagnostics = document.getElementById("bridgeLimitDiagnostics");
    ui.bridgeLimitDiagnosticsStatus = document.getElementById("bridgeLimitDiagnosticsStatus");
    ui.bridgeLimitDiagnosticsRows = document.getElementById("bridgeLimitDiagnosticsRows");
    ui.bridgeSafetyConfirm = document.getElementById("bridgeSafetyConfirm");
    ui.btnBridgeHealth = document.getElementById("btnBridgeHealth");
    ui.btnBridgeConnect = document.getElementById("btnBridgeConnect");
    ui.btnBridgeDisconnect = document.getElementById("btnBridgeDisconnect");
    ui.bridgeStatus = document.getElementById("bridgeStatus");
    ui.bridgeStepBridge = document.getElementById("bridgeStepBridge");
    ui.bridgeStepPort = document.getElementById("bridgeStepPort");
    ui.bridgeStepCalibration = document.getElementById("bridgeStepCalibration");
    ui.bridgeStepMotion = document.getElementById("bridgeStepMotion");

    ui.motorsEnabled = document.getElementById("motorsEnabled");
    ui.teachModeEnabled = document.getElementById("teachModeEnabled");
    ui.teachControls = document.querySelector(".teach-controls");
    ui.btnTeachStart = document.getElementById("btnTeachStart");
    ui.btnTeachPause = document.getElementById("btnTeachPause");
    ui.btnTeachResume = document.getElementById("btnTeachResume");
    ui.btnTeachStop = document.getElementById("btnTeachStop");
    ui.btnTeachDiscard = document.getElementById("btnTeachDiscard");
    ui.btnTeachSave = document.getElementById("btnTeachSave");
    ui.btnTeachReplay = document.getElementById("btnTeachReplay");
    ui.teachStatusText = document.getElementById("teachStatusText");
    ui.debugTelemetryToggle = document.getElementById("debugTelemetryToggle");
    ui.debugTelemetryDetails = document.getElementById("debugTelemetryDetails");
    ui.debugChipMode = document.getElementById("debugChipMode");
    ui.debugChipTrajectory = document.getElementById("debugChipTrajectory");
    ui.debugChipQueue = document.getElementById("debugChipQueue");
    ui.debugChipWaiters = document.getElementById("debugChipWaiters");
    ui.debugDetailProtocol = document.getElementById("debugDetailProtocol");
    ui.debugDetailInFlight = document.getElementById("debugDetailInFlight");
    ui.debugDetailMotion = document.getElementById("debugDetailMotion");
    ui.debugDetailState = document.getElementById("debugDetailState");
    ui.debugDetailActive = document.getElementById("debugDetailActive");
    ui.debugDetailLimit = document.getElementById("debugDetailLimit");
    ui.debugDetailTx = document.getElementById("debugDetailTx");
    ui.debugDetailRx = document.getElementById("debugDetailRx");
    ui.debugConsoleLog = document.getElementById("debugConsoleLog");
    ui.btnDebugClear = document.getElementById("btnDebugClear");
    ui.serialConsoleLog = document.getElementById("serialConsoleLog");
    ui.btnConsoleCopy = document.getElementById("btnConsoleCopy");
    ui.btnConsoleClear = document.getElementById("btnConsoleClear");
    ui.indexConsoleToggle = document.getElementById("btnIndexConsoleToggle");
    ui.indexConsolePanel = document.getElementById("indexConsolePanelBody");
    ui.mainSplit = document.querySelector(".index-3d-main-split");
    ui.modeSelector = document.getElementById("manualModeSelector");
    ui.workbenchModeButtons = Array.from(document.querySelectorAll("[data-workbench-mode-option]"));
    ui.inspectorTitle = document.querySelector("[data-workbench-inspector-title]");
    ui.executionTarget = document.querySelector("[data-execution-target]");
    ui.drawerTabs = Array.from(document.querySelectorAll("[data-drawer-tab]"));
    ui.drawerPanels = Array.from(document.querySelectorAll("[data-drawer-panel]"));
    ui.drawerBridgeMount = document.getElementById("workbenchBridgeMount");
    ui.drawerLeaderMount = document.getElementById("workbenchLeaderDetailsMount");
    ui.drawerProgramMount = document.getElementById("workbenchProgramStatusMount");
    ui.drawerBridgeSummary = document.getElementById("workbenchBridgeSummary");
    ui.openProgramWorkspace = document.getElementById("leaderOpenProgramWorkspace");

    ui.saveDialog = document.getElementById("saveDialog");
    ui.saveName = document.getElementById("saveName");
    ui.saveDialogOk = document.getElementById("saveDialogOk");
    ui.saveDialogCancel = document.getElementById("saveDialogCancel");

    ui.loadDialog = document.getElementById("loadDialog");
    ui.programList = document.getElementById("programList");
    ui.loadDialogCancel = document.getElementById("loadDialogCancel");

    ui.scriptDialog = document.getElementById("scriptDialog");
    ui.scriptDialogName = document.getElementById("scriptDialogName");
    ui.scriptDialogText = document.getElementById("scriptDialogText");
    ui.scriptDialogCopy = document.getElementById("scriptDialogCopy");
    ui.scriptDialogClose = document.getElementById("scriptDialogClose");
  }

  function mountWorkbenchDetails() {
    if (ui.drawerBridgeMount && ui.robotBridgePanel && ui.robotBridgePanel.parentElement !== ui.drawerBridgeMount) {
      ui.drawerBridgeMount.appendChild(ui.robotBridgePanel);
    }

    if (ui.drawerBridgeMount && !ui.drawerBridgeMount.querySelector(".workbench-bridge-empty")) {
      const empty = document.createElement("p");
      empty.className = "workbench-bridge-empty";
      empty.hidden = true;
      ui.drawerBridgeMount.appendChild(empty);
    }

    if (ui.drawerLeaderMount) {
      [
        "leaderRangeRecovery",
        "leaderLayerControls",
        "leaderGamepad",
        "leaderPrecision",
        "leaderValues"
      ].forEach((id) => {
        const element = document.getElementById(id);
        if (element && element.parentElement !== ui.drawerLeaderMount) {
          ui.drawerLeaderMount.appendChild(element);
        }
      });
      const telemetry = document.querySelector(".leader-telemetry");
      const diagnostics = document.getElementById("leaderExportDiagnostics");
      if (telemetry && telemetry.parentElement !== ui.drawerLeaderMount) ui.drawerLeaderMount.appendChild(telemetry);
      if (diagnostics && diagnostics.parentElement !== ui.drawerLeaderMount) ui.drawerLeaderMount.appendChild(diagnostics);
    }

    if (ui.drawerProgramMount) {
      const messages = document.querySelector(".bottombar__messages");
      const status = document.querySelector(".bottombar__status");
      if (messages) {
        Array.from(messages.children).forEach((child) => ui.drawerProgramMount.appendChild(child));
      }
      if (status) ui.drawerProgramMount.appendChild(status);
    }
  }

  function initWorkbenchPresentation() {
    if (ui.mainSplit && NS.WorkbenchUI) {
      ui.mainSplit.addEventListener(NS.WorkbenchUI.LAYOUT_EVENT, scheduleWorkbenchLayoutRefresh);
    }
    ui.workbenchModeButtons.forEach((button, index) => {
      button.addEventListener("click", () => void setWorkbenchMode(button.dataset.workbenchModeOption));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + ui.workbenchModeButtons.length) % ui.workbenchModeButtons.length;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % ui.workbenchModeButtons.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = ui.workbenchModeButtons.length - 1;
        const nextButton = ui.workbenchModeButtons[nextIndex];
        nextButton.focus();
        void setWorkbenchMode(nextButton.dataset.workbenchModeOption);
      });
    });

    ui.drawerTabs.forEach((button, index) => {
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-disabled") === "true") {
          setProgramStatus(button.dataset.disabledReason || "This panel is unavailable for the selected robot.");
          return;
        }
        setDrawerTab(button.dataset.drawerTab);
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + ui.drawerTabs.length) % ui.drawerTabs.length;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % ui.drawerTabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = ui.drawerTabs.length - 1;
        ui.drawerTabs[nextIndex].focus();
        if (ui.drawerTabs[nextIndex].getAttribute("aria-disabled") !== "true") {
          setDrawerTab(ui.drawerTabs[nextIndex].dataset.drawerTab);
        }
      });
    });

    if (ui.openProgramWorkspace) {
      ui.openProgramWorkspace.hidden = false;
      ui.openProgramWorkspace.addEventListener("click", () => void setWorkbenchMode("blockly", { focusPanel: true }));
    }

    window.addEventListener("robobuddy:leader-details-request", (event) => {
      const detail = event.detail || {};
      if (typeof detail.pin === "boolean") state.drawerPinnedLeader = detail.pin;
      if (detail.open !== false) openWorkbenchDrawer("leader", { focus: Boolean(detail.focus) });
    });

    NS.MainWorkbench = Object.freeze({
      setMode: (mode) => setWorkbenchMode(mode),
      openDrawer: (tab, options) => openWorkbenchDrawer(tab, options),
      getMode: () => state.workbenchMode
    });

    syncWorkbenchAvailability();
    setDrawerTab("bridge");
    setIndexConsoleExpanded(true, { force: true });
    void setWorkbenchMode("blockly", { force: true, silent: true });
  }

  function scheduleWorkbenchLayoutRefresh() {
    if (state.workbenchLayoutQueued) {
      return;
    }
    state.workbenchLayoutQueued = true;
    window.requestAnimationFrame(() => {
      state.workbenchLayoutQueued = false;
      if (state.workspace && window.Blockly && Blockly.svgResize) {
        Blockly.svgResize(state.workspace);
      }
      if (state.preview && typeof state.preview.resize === "function") {
        state.preview.resize();
      }
    });
  }

  function workbenchModeReason(mode) {
    const manifest = activeManifest();
    const capabilities = new Set(manifest && Array.isArray(manifest.capabilities) ? manifest.capabilities : []);
    if (mode === "leader" && !capabilities.has("virtual_leader")) {
      return "Leader is available for the SO-101 follower.";
    }
    if (mode === "teach" && !capabilities.has("teach_replay")) {
      return "Teach is unavailable for the selected robot.";
    }
    if (mode === "joints" && !capabilities.has("joint_control")) {
      return "Joint control is unavailable for the selected robot.";
    }
    return "";
  }

  function syncWorkbenchAvailability() {
    ui.workbenchModeButtons.forEach((button) => {
      const reason = workbenchModeReason(button.dataset.workbenchModeOption);
      button.setAttribute("aria-disabled", reason ? "true" : "false");
      button.dataset.disabledReason = reason;
      button.title = reason;
    });
    const leaderTab = ui.drawerTabs.find((button) => button.dataset.drawerTab === "leader");
    const leaderReason = workbenchModeReason("leader");
    if (leaderTab) {
      leaderTab.setAttribute("aria-disabled", leaderReason ? "true" : "false");
      leaderTab.dataset.disabledReason = leaderReason;
      leaderTab.title = leaderReason;
    }
    const bridgeEmpty = ui.drawerBridgeMount && ui.drawerBridgeMount.querySelector(".workbench-bridge-empty");
    if (bridgeEmpty) {
      const manifest = activeManifest();
      const isSo101 = Boolean(manifest && manifest.id === "so101_follower");
      bridgeEmpty.hidden = isSo101;
      bridgeEmpty.textContent = manifest && manifest.id === "arduino_arm"
        ? "Arduino hardware uses the serial connection in the workbench header."
        : "This robot is simulation-only; no hardware bridge is available.";
    }
    syncExecutionTarget();
  }

  async function setWorkbenchMode(mode, options = {}) {
    const next = ["blockly", "joints", "leader", "teach"].includes(mode) ? mode : "blockly";
    const reason = workbenchModeReason(next);
    if (reason) {
      if (!options.silent) setProgramStatus(reason);
      return false;
    }
    if (!options.force && state.workbenchMode === next) return true;
    if (state.workbenchModeTransitioning) {
      if (!options.silent) setProgramStatus("Finish the current control handoff before changing modes again.");
      return false;
    }

    state.workbenchModeTransitioning = true;
    if (ui.modeSelector) ui.modeSelector.setAttribute("aria-busy", "true");
    try {
      if (NS.VirtualLeaderUI && typeof NS.VirtualLeaderUI.setMode === "function") {
        await NS.VirtualLeaderUI.setMode(next === "leader" ? "leader" : "joints");
      }
    } finally {
      state.workbenchModeTransitioning = false;
      if (ui.modeSelector) ui.modeSelector.removeAttribute("aria-busy");
    }
    if (next !== "leader" && state.drawerTab === "leader" && !state.drawerPinnedLeader) {
      setDrawerTab("program");
    }
    state.workbenchMode = next;
    document.body.dataset.workbenchMode = next;
    ui.workbenchModeButtons.forEach((button) => {
      const active = button.dataset.workbenchModeOption === next;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });

    const blockCard = document.querySelector(".index-3d-block-card");
    const manualCard = document.querySelector(".index-3d-manual-card");
    const previewCard = document.querySelector(".index-3d-preview-card");
    if (blockCard) blockCard.hidden = next !== "blockly";
    if (manualCard) manualCard.hidden = next === "blockly";
    const jointsPanel = document.getElementById("manualJointsPanel");
    const leaderPanel = document.getElementById("virtualLeaderPanel");
    const teachPanel = document.getElementById("teachControlsPanel");
    if (jointsPanel) jointsPanel.hidden = next !== "joints";
    if (leaderPanel) leaderPanel.hidden = next !== "leader";
    if (teachPanel) teachPanel.hidden = next !== "teach";
    if (previewCard) previewCard.dataset.workbenchRole = next === "blockly" ? "inspector" : "stage";
    if (ui.inspectorTitle) {
      const labels = { joints: "Joint Control", leader: "Virtual Leader", teach: "Teach & Replay" };
      ui.inspectorTitle.innerHTML = `<i data-lucide="${next === "leader" ? "scan-line" : next === "teach" ? "history" : "sliders-horizontal"}"></i> ${labels[next] || "Control"}`;
      if (window.lucide) lucide.createIcons({ nodes: [ui.inspectorTitle.querySelector("[data-lucide]")] });
    }
    window.requestAnimationFrame(() => {
      scheduleWorkbenchLayoutRefresh();
      if (options.focusPanel) {
        const focusTarget = next === "blockly" ? document.getElementById("blocklyDiv") : document.querySelector(`[data-workbench-mode-option="${next}"]`);
        if (focusTarget) focusTarget.focus();
      }
    });
    return true;
  }

  function setDrawerTab(tab) {
    const next = ["bridge", "leader", "serial", "debug", "program"].includes(tab) ? tab : "bridge";
    const targetButton = ui.drawerTabs.find((button) => button.dataset.drawerTab === next);
    if (targetButton && targetButton.getAttribute("aria-disabled") === "true") return false;
    state.drawerTab = next;
    ui.drawerTabs.forEach((button) => {
      const active = button.dataset.drawerTab === next;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    });
    ui.drawerPanels.forEach((panel) => { panel.hidden = panel.dataset.drawerPanel !== next; });
    scheduleWorkbenchLayoutRefresh();
    return true;
  }

  function openWorkbenchDrawer(tab = state.drawerTab, options = {}) {
    if (tab === "leader" && workbenchModeReason("leader")) return false;
    setIndexConsoleExpanded(true, { force: true });
    if (!setDrawerTab(tab)) return false;
    if (options.focus) {
      const button = ui.drawerTabs.find((item) => item.dataset.drawerTab === tab);
      if (button) button.focus();
    }
    return true;
  }

  function syncExecutionTarget() {
    if (!ui.executionTarget) return;
    const manifest = activeManifest();
    const serialHardware = Boolean(manifest && manifest.id === "arduino_arm" && state.serial && state.serial.isConnected());
    const bridgeHardware = Boolean(manifest && manifest.id === "so101_follower" && state.bridgeUi.connected);
    const hardware = serialHardware || bridgeHardware;
    const label = hardware ? (bridgeHardware ? "Local Bridge" : "Hardware") : "Simulation";
    ui.executionTarget.dataset.executionTarget = hardware ? "hardware" : "simulation";
    ui.executionTarget.setAttribute("aria-label", `Execution target: ${label}`);
    const span = ui.executionTarget.querySelector("span");
    if (span) span.textContent = label;
    const icon = ui.executionTarget.querySelector("[data-lucide]");
    if (icon) {
      icon.setAttribute("data-lucide", hardware ? "cable" : "monitor");
      if (window.lucide) lucide.createIcons({ nodes: [icon] });
    }
  }

  function initRobotPortalUi() {
    if (NS.RobotRuntime && ui.robotSimPreview) {
      NS.RobotRuntime.init({ container: ui.robotSimPreview });
    }
    window.addEventListener("robobuddy:robot-preview-3d-ready", () => {
      if (!isArduinoActive() && NS.RobotRuntime && ui.robotSimPreview) {
        NS.RobotRuntime.render(ui.robotSimPreview);
      }
    });
    renderRobotChooser();
    renderManualControls();
    renderDriveControls();
    renderHumanoidControls();
    syncRobotPreviewVisibility();
  }

  function activeManifest() {
    return NS.RobotRegistry && NS.RobotRegistry.getActive
      ? NS.RobotRegistry.getActive()
      : null;
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
    if (NS.RobotSafety && activeManifest()) {
      return NS.RobotSafety.getHomeAngles(activeManifest());
    }
    return HOME_ANGLES.slice();
  }

  function getActiveInitialAngles() {
    if (NS.RobotSafety && activeManifest() && typeof NS.RobotSafety.getInitialAngles === "function") {
      return NS.RobotSafety.getInitialAngles(activeManifest());
    }
    return getActiveHomeAngles();
  }

  function getActiveJointLimits() {
    if (NS.RobotSafety && activeManifest()) {
      return NS.RobotSafety.getJointLimits(activeManifest());
    }
    return JOINT_LIMITS.slice();
  }

  function getManualJointLimits(joint, fallback) {
    const base = Array.isArray(fallback) ? fallback.map(Number) : [Number(joint && joint.min), Number(joint && joint.max)];
    const override = activeRobotId() === "so101_follower" && joint
      ? SO101_MANUAL_JOINT_LIMITS[joint.id]
      : null;
    if (!override || !Number.isFinite(base[0]) || !Number.isFinite(base[1])) {
      return base;
    }
    const low = Math.max(base[0], Number(override[0]));
    const high = Math.min(base[1], Number(override[1]));
    return low < high ? [low, high] : base;
  }

  function getManualSliderLimits(servo) {
    const joint = activeJoints()[servo];
    const fallback = getActiveJointLimits()[servo] || [0, 180];
    return getManualJointLimits(joint, fallback);
  }

  function clampManualSliderValue(servo, value) {
    const [low, high] = getManualSliderLimits(servo);
    return Math.min(high, Math.max(low, Number(value)));
  }

  function getServoName(servo) {
    const joint = activeJoints()[servo];
    return joint ? joint.label : (SERVO_NAMES[servo] || `Joint ${servo + 1}`);
  }

  function formatNumericReadout(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return String(value ?? "");
    }
    return Math.abs(numeric - Math.round(numeric)) < 0.001
      ? String(Math.round(numeric))
      : String(Math.round(numeric * 10) / 10);
  }

  function getGripperStateLabel(joint, value) {
    if (!joint || joint.type !== "gripper") {
      return "";
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "";
    }
    const open = Number(joint.open);
    const close = Number(joint.close);
    const min = Number(joint.min);
    const max = Number(joint.max);
    const openValue = Number.isFinite(open) ? open : min;
    const closeValue = Number.isFinite(close) ? close : max;
    const tolerance = 0.5;
    if (Number.isFinite(closeValue) && numeric >= closeValue - tolerance) {
      return "closed";
    }
    if (Number.isFinite(openValue) && numeric <= openValue + tolerance) {
      return "open";
    }
    return "";
  }

  function formatJointReadout(joint, value) {
    const display = formatNumericReadout(value);
    const unit = joint && joint.unit === "percent" ? "%" : "\u00B0";
    const stateLabel = getGripperStateLabel(joint, value);
    return `${display}${unit}${stateLabel ? ` ${stateLabel}` : ""}`;
  }

  function formatJointAriaValue(joint, value, rangePercent = null) {
    const display = formatNumericReadout(value);
    const unit = joint && joint.unit === "percent" ? "percent" : "degrees";
    const stateLabel = getGripperStateLabel(joint, value);
    const stateText = stateLabel ? `, ${stateLabel}` : "";
    const rangeText = Number.isFinite(rangePercent) ? ` (${rangePercent}% of range)` : "";
    return `${display} ${unit}${stateText}${rangeText}`;
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

  function renderManualControls() {
    if (!ui.servoSliders) {
      return;
    }
    const joints = activeJoints();
    const initialAngles = getActiveInitialAngles();
    const renderChannel = (joint, index) => {
      const initialValue = Number(initialAngles[index]);
      const value = Number.isFinite(initialValue)
        ? initialValue
        : (Number.isFinite(Number(joint.home)) ? Number(joint.home) : Number(joint.min) || 0);
      const readout = formatJointReadout(joint, value);
      const ariaValueText = formatJointAriaValue(joint, value);
      return `
        <div class="servo-channel servo-channel--${escapeHtml(slugJoint(joint.id))}">
          <label class="servo-channel__label" for="slider${index}">
            <span class="servo-channel__dot"></span><span class="servo-channel__label-text">${escapeHtml(joint.label)}</span>
          </label>
          <div class="servo-channel__track">
            <input type="range" class="servo-slider" id="slider${index}" min="${escapeHtml(joint.min)}" max="${escapeHtml(joint.max)}" step="${escapeHtml(joint.step || 1)}" value="${escapeHtml(value)}" data-servo="${index}" data-joint="${escapeHtml(joint.id)}" aria-describedby="range${index} actual${index}" aria-valuenow="${escapeHtml(value)}" aria-valuetext="${escapeHtml(ariaValueText)}">
            <span class="servo-channel__range" id="range${index}"><span data-range-min>${escapeHtml(formatJointReadout(joint, joint.min))}</span><span data-range-max>${escapeHtml(formatJointReadout(joint, joint.max))}</span></span>
          </div>
          <span class="servo-channel__metrics">
            <span class="servo-channel__value" id="val${index}" title="Target">${escapeHtml(readout)}</span>
            <span class="servo-channel__actual" id="actual${index}" hidden>Actual —</span>
          </span>
        </div>
      `;
    };
    const manifest = activeManifest();
    const groups = manifest && manifest.ui && Array.isArray(manifest.ui.jointGroups)
      ? manifest.ui.jointGroups
      : [];
    if (groups.length > 0) {
      ui.servoSliders.innerHTML = groups.map((group, groupIndex) => {
        const grouped = joints
          .map((joint, index) => ({ joint, index }))
          .filter((entry) => entry.joint.subsystem === group.id);
        if (grouped.length === 0) {
          return "";
        }
        return `
          <details class="servo-joint-group"${groupIndex === 0 ? " open" : ""}>
            <summary>${escapeHtml(group.label || group.id)} <span>${grouped.length} joints</span></summary>
            <div class="servo-joint-group__body">
              ${grouped.map(({ joint, index }) => renderChannel(joint, index)).join("")}
            </div>
          </details>
        `;
      }).join("");
    } else {
      ui.servoSliders.innerHTML = joints.map(renderChannel).join("");
    }

    wireSliders();
    syncSliderLimitsFromJointLimits();
    updateManualControlTelemetry();
  }

  function formatJointRange(joint, min, max) {
    return `${formatJointReadout(joint, min)} to ${formatJointReadout(joint, max)}`;
  }

  function renderDriveControls() {
    if (!ui.robotDriveControls) {
      return;
    }
    const manifest = activeManifest();
    const show = Boolean(manifest && manifest.mobileBase);
    const controlsCard = ui.robotDriveControls.closest(".sidebar__controls");
    if (controlsCard) {
      controlsCard.classList.toggle("has-drive-controls", show);
    }
    ui.robotDriveControls.hidden = !show;
    if (!show) {
      ui.robotDriveControls.innerHTML = "";
      return;
    }
    const driveActions = [
      { action: "turn-left", label: "Turn Left", icon: "rotate-ccw", tone: "btn--load", slot: "turn-left" },
      { action: "forward", label: "Forward", icon: "arrow-up", tone: "btn--load", slot: "forward" },
      { action: "turn-right", label: "Turn Right", icon: "rotate-cw", tone: "btn--load", slot: "turn-right" },
      { action: "left", label: "Strafe Left", icon: "arrow-left", tone: "btn--load", slot: "left" },
      { action: "stop", label: "Stop", icon: "square", tone: "btn--stop", slot: "stop" },
      { action: "right", label: "Strafe Right", icon: "arrow-right", tone: "btn--load", slot: "right" },
      { action: "backward", label: "Backward", icon: "arrow-down", tone: "btn--load", slot: "backward" }
    ];
    ui.robotDriveControls.innerHTML = `
      <div class="panel-label"><i data-lucide="navigation"></i> Drive</div>
      <div class="robot-drive-controls__grid">
        ${driveActions.map(({ action, label, icon, tone, slot }) => `
          <button class="btn ${tone} robot-drive-controls__button robot-drive-controls__button--${slot}" type="button" data-drive="${action}" aria-label="${label}" title="${label}" data-hint="${label}">
            <i data-lucide="${icon}" aria-hidden="true"></i>
          </button>
        `).join("")}
      </div>
    `;
    ui.robotDriveControls.querySelectorAll("[data-drive]").forEach((button) => {
      button.addEventListener("click", () => {
        void handleDriveButton(button.dataset.drive);
      });
    });
    if (window.lucide) {
      lucide.createIcons({ nodes: ui.robotDriveControls.querySelectorAll("[data-lucide]") });
    }
  }

  function renderHumanoidControls() {
    if (!ui.robotHumanoidControls) {
      return;
    }
    const manifest = activeManifest();
    const show = Boolean(manifest && manifest.humanoid);
    ui.robotHumanoidControls.hidden = !show;
    if (!show) {
      ui.robotHumanoidControls.innerHTML = "";
      return;
    }
    const postures = Object.entries(manifest.postures || {});
    ui.robotHumanoidControls.innerHTML = `
      <div class="panel-label"><i data-lucide="person-standing"></i> Humanoid actions</div>
      <div class="robot-humanoid-controls__posture">
        <label for="g1PostureSelect">Posture</label>
        <select id="g1PostureSelect">
          ${postures.map(([id, posture]) => `<option value="${escapeHtml(id)}">${escapeHtml(posture.label || id)}</option>`).join("")}
        </select>
        <button class="btn btn--load" type="button" data-g1-action="posture">Apply</button>
      </div>
      <div class="robot-humanoid-controls__grid">
        <button class="btn btn--load" type="button" data-g1-action="walk-forward"><i data-lucide="arrow-up"></i><span>3 steps</span></button>
        <button class="btn btn--load" type="button" data-g1-action="walk-backward"><i data-lucide="arrow-down"></i><span>Back 3</span></button>
        <button class="btn btn--load" type="button" data-g1-action="turn-left"><i data-lucide="rotate-ccw"></i><span>Left 90 deg</span></button>
        <button class="btn btn--load" type="button" data-g1-action="turn-right"><i data-lucide="rotate-cw"></i><span>Right 90 deg</span></button>
        <button class="btn btn--load" type="button" data-g1-action="pick-right"><i data-lucide="hand"></i><span>Pick</span></button>
        <button class="btn btn--clear" type="button" data-g1-action="release-right"><i data-lucide="package-open"></i><span>Release</span></button>
        <button class="btn btn--run robot-humanoid-controls__demo" type="button" data-g1-action="demo"><i data-lucide="route"></i><span>Run demo</span></button>
        <button class="btn btn--stop" type="button" data-g1-action="stop"><i data-lucide="square"></i><span>Stop</span></button>
      </div>
      <p class="unitree-g1-action-status" id="g1ActionStatus" role="status" aria-live="polite">Kinematic simulation. Programs can control all 29 joints.</p>
    `;
    ui.robotHumanoidControls.querySelectorAll("[data-g1-action]").forEach((button) => {
      button.addEventListener("click", () => void handleHumanoidAction(button.dataset.g1Action));
    });
    if (window.lucide) {
      lucide.createIcons({ nodes: ui.robotHumanoidControls.querySelectorAll("[data-lucide]") });
    }
  }

  async function handleHumanoidAction(action) {
    const manifest = activeManifest();
    if (!manifest || !manifest.humanoid) {
      return;
    }
    let command = null;
    if (action === "posture") {
      const select = document.getElementById("g1PostureSelect");
      command = { type: "set_posture", robotId: manifest.id, posture: select ? select.value : "neutral", seconds: 0.8 };
    } else if (action === "walk-forward" || action === "walk-backward") {
      command = { type: "humanoid_walk", robotId: manifest.id, direction: action === "walk-forward" ? "forward" : "backward", steps: 3, stepLengthM: 0.08, speed: 50 };
    } else if (action === "turn-left" || action === "turn-right") {
      command = { type: "humanoid_turn", robotId: manifest.id, angleDeg: action === "turn-left" ? 90 : -90, seconds: 1.5 };
    } else if (action === "pick-right") {
      command = { type: "pick_nearest", robotId: manifest.id, hand: "right_hand" };
    } else if (action === "release-right") {
      command = { type: "release_object", robotId: manifest.id, hand: "right_hand" };
    } else if (action === "demo") {
      command = { type: "run_demo", robotId: manifest.id };
    } else if (action === "stop") {
      command = { type: "stop", robotId: manifest.id, reason: "user" };
    }
    if (!command) {
      return;
    }
    const result = await applyManualRobotCommand(command);
    const status = document.getElementById("g1ActionStatus");
    if (status) {
      status.dataset.active = String(Boolean(result.ok && !["stop", "pick_nearest", "release_object"].includes(command.type)));
      status.textContent = result.ok
        ? `${command.type.replace(/_/g, " ")} accepted. STOP remains available.`
        : (result.error && result.error.message) || "G1 action rejected.";
    }
  }

  function syncRobotPreviewVisibility() {
    const showArduino = isArduinoActive();
    if (ui.armPreview) {
      ui.armPreview.dataset.activeRobotId = activeRobotId();
      ui.armPreview.classList.toggle("is-robot-sim-active", !showArduino);
      const threeUnavailable = ui.armPreview.classList.contains("is-3d-unavailable");
      const three = ui.armPreview.querySelector(".arm-preview-3d");
      if (three) {
        three.hidden = !showArduino || threeUnavailable;
      }
      const threeFallback = ui.armPreview.querySelector("[data-arm-preview-3d-fallback-status]");
      if (threeFallback && !showArduino) {
        threeFallback.hidden = true;
      } else if (threeFallback && threeUnavailable) {
        threeFallback.hidden = false;
        threeFallback.textContent = "3D preview unavailable.";
      }
    }
    if (ui.robotSimPreview) {
      ui.robotSimPreview.hidden = showArduino;
      if (!showArduino && NS.RobotRuntime) {
        NS.RobotRuntime.render(ui.robotSimPreview);
      }
    }
    const label = document.querySelector(".sidebar__preview .panel-label");
    const manifest = activeManifest();
    if (label && manifest) {
      label.innerHTML = `<i data-lucide="eye"></i> ${escapeHtml(manifest.shortName || manifest.name)} Preview`;
      if (window.lucide) {
        lucide.createIcons({ nodes: [label.querySelector("[data-lucide]")] });
      }
    }
  }

  function mark3dPreviewUnavailable() {
    if (!ui.armPreview) {
      return;
    }
    ui.armPreview.classList.add("is-3d-unavailable");
    const three = ui.armPreview.querySelector(".arm-preview-3d");
    if (three) {
      three.hidden = true;
    }
    const fallbackStatus = ui.armPreview.querySelector("[data-arm-preview-3d-fallback-status]");
    if (fallbackStatus) {
      fallbackStatus.hidden = false;
      fallbackStatus.textContent = "3D preview unavailable.";
    }
  }

  function syncRobotSpecificUi() {
    const manifest = activeManifest();
    if (!manifest) {
      return;
    }
    if (state.lastSyncedRobotId && state.lastSyncedRobotId !== manifest.id) {
      clearRobotScopedBlocklyState();
    }
    if (ui.robotChooser) {
      ui.robotChooser.value = manifest.id;
    }
    renderManualControls();
    renderDriveControls();
    renderHumanoidControls();
    syncSliderLimitsFromJointLimits();
    if (ui.manualControlsCard) {
      ui.manualControlsCard.classList.toggle("has-bridge-controls", manifest.id === "so101_follower");
    }
    if (NS.Blocks && typeof NS.Blocks.refreshToolbox === "function") {
      NS.Blocks.refreshToolbox(state.workspace, ui.toolbox);
    }
    if (ui.robotBridgePanel) {
      ui.robotBridgePanel.hidden = manifest.id !== "so101_follower";
    }
    if (manifest.id !== "so101_follower") {
      resetBridgeUiState();
    } else {
      syncBridgeUx();
    }
    const supportsTeach = Array.isArray(manifest.capabilities) && manifest.capabilities.includes("teach_replay");
    if (ui.teachControls) {
      ui.teachControls.hidden = !supportsTeach;
    }
    if (ui.teachModeEnabled) {
      ui.teachModeEnabled.disabled = !supportsTeach;
    }
    if (ui.motorsEnabled) {
      ui.motorsEnabled.disabled = !isArduinoActive();
      if (!isArduinoActive()) {
        ui.motorsEnabled.checked = false;
      }
    }
    if (ui.btnConnect) {
      const isSo101 = manifest.id === "so101_follower";
      const isLeKiwi = manifest.id === "lekiwi_sim";
      ui.btnConnect.disabled = isArduinoActive() ? !state.serial.supportsWebSerial() : isLeKiwi;
      const span = ui.btnConnect.querySelector("span");
      if (span) {
        span.textContent = isArduinoActive()
          ? (state.serial.isConnected() ? "Disconnect" : "Connect")
          : (isSo101 ? "Connect Bridge" : "Simulation Only");
      }
      const actionLabel = isArduinoActive()
        ? "Connect or disconnect Arduino serial hardware"
        : isSo101
          ? "Open local bridge setup"
          : "LeKiwi is simulation-only";
      ui.btnConnect.title = actionLabel;
      ui.btnConnect.dataset.hint = actionLabel;
      ui.btnConnect.setAttribute("aria-label", actionLabel);
    }
    syncWorkbenchAvailability();
    syncRobotPreviewVisibility();
    applyAngles(getActiveInitialAngles(), { syncSliders: true, source: "robot-switch" });
    state.lastSyncedRobotId = manifest.id;
  }

  function clearRobotScopedBlocklyState() {
    if (!state.workspace || state.workspace.getTopBlocks(false).length === 0) {
      return;
    }
    state.workspace.clear();
    setProgramStatus("Blockly workspace cleared for the selected robot.");
  }

  function wireRobotPortalEvents() {
    if (ui.robotChooser) {
      ui.robotChooser.addEventListener("change", () => {
        clearRobotScopedBlocklyState();
        void switchActiveRobot(ui.robotChooser.value);
      });
    }
    window.addEventListener("robobuddy:active-robot-change", () => {
      syncRobotSpecificUi();
      void setWorkbenchMode("blockly", { force: true, silent: true });
      appendSerialConsole("SYS", `Robot switched to ${activeManifest().name}; incompatible queued commands cleared.`);
      clearPendingManualSends();
      clearManualSessionState();
    });
    if (ui.btnBridgeHealth) {
      ui.btnBridgeHealth.addEventListener("click", () => {
        void testBridgeHealth();
      });
    }
    if (ui.btnBridgeConnect) {
      ui.btnBridgeConnect.addEventListener("click", () => {
        void connectSo101Bridge();
      });
    }
    if (ui.btnBridgeDisconnect) {
      ui.btnBridgeDisconnect.addEventListener("click", () => {
        void disconnectSo101Bridge();
      });
    }
    if (ui.manualArmAction) {
      ui.manualArmAction.addEventListener("click", () => {
        if (!ui.bridgeSafetyConfirm || ui.bridgeSafetyConfirm.disabled || state.bridgeUi.armPending) {
          return;
        }
        ui.bridgeSafetyConfirm.checked = true;
        ui.bridgeSafetyConfirm.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    if (ui.manualLimitInfo && ui.manualLimitDetails) {
      ui.manualLimitInfo.addEventListener("click", () => {
        const expanded = ui.manualLimitInfo.getAttribute("aria-expanded") === "true";
        setManualLimitDetailsExpanded(!expanded);
      });
      ui.manualControlMeta.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && ui.manualLimitInfo.getAttribute("aria-expanded") === "true") {
          event.preventDefault();
          setManualLimitDetailsExpanded(false);
          ui.manualLimitInfo.focus();
        }
      });
    }
    if (ui.bridgeSafetyConfirm) {
      ui.bridgeSafetyConfirm.addEventListener("change", async () => {
        if (state.bridgeUi.armPending) {
          return;
        }
        const requested = Boolean(ui.bridgeSafetyConfirm.checked);
        state.bridgeUi.armPending = true;
        setBridgeStatus(requested ? "Arming SO-101…" : "Disarming and holding the measured pose…", "warning");
        updateManualControlMeta(requested ? "Arming…" : "Disarming…", "warning", requested
          ? "Waiting for the bridge to authorize live control."
          : "Waiting for the bridge to cancel motion and hold the measured pose.");
        syncBridgeUx();
        updateManualControlLockUi();
        try {
          const runtimeState = NS.RobotRuntime
            ? await NS.RobotRuntime.setBridgeSafetyConfirmed(requested)
            : null;
          state.bridgeUi.armed = Boolean(runtimeState && runtimeState.connection && runtimeState.connection.armedForMotion);
          updateManualControlTelemetry(runtimeState);
          if (state.bridgeUi.armed) {
            setBridgeStatus("SO-101 armed. Sliders now control hardware while you move them.", "ready");
          } else if (state.bridgeUi.connected) {
            setBridgeStatus("SO-101 connected. Arm motion to enable live slider control.", "warning");
          }
        } catch (error) {
          state.bridgeUi.armed = false;
          ui.bridgeSafetyConfirm.checked = false;
          setBridgeStatus(`${requested ? "Arm motion" : "Disarm"} failed: ${error.message}`, "error");
        } finally {
          state.bridgeUi.armPending = false;
          syncBridgeUx();
          updateManualControlLockUi();
        }
      });
    }
    if (ui.bridgePortSelect) {
      ui.bridgePortSelect.addEventListener("change", () => {
        if (!state.bridgeUi.connected) {
          state.bridgeUi.calibrated = false;
          state.bridgeUi.armed = false;
          state.bridgeUi.lastPayload = null;
          if (ui.bridgeSafetyConfirm) {
            ui.bridgeSafetyConfirm.checked = false;
          }
          if (NS.RobotRuntime && NS.RobotRuntime.setBridgeSafetyConfirmed) {
            void NS.RobotRuntime.setBridgeSafetyConfirmed(false);
          }
          if (NS.RobotRuntime && NS.RobotRuntime.applyBridgeState) {
            NS.RobotRuntime.applyBridgeState({
              connected: false,
              calibrated: false,
              armed: false,
              status: "DISCONNECTED",
              limitStatus: "unavailable",
              jointLimits: {}
            });
            syncSliderLimitsFromJointLimits();
          }
          if (state.bridgeUi.tested && getBridgeSelectedPort()) {
            setBridgeStatus("Port selected. Connect SO-101 to verify calibration.", "warning");
          }
        }
        syncBridgeUx();
      });
    }
    if (ui.bridgeRobotInstance) {
      ui.bridgeRobotInstance.addEventListener("input", () => {
        if (!state.bridgeUi.connected && !state.bridgeUi.connecting) {
          syncGripperMappingControl();
        }
      });
    }
    if (ui.bridgeGripperMapping) {
      ui.bridgeGripperMapping.addEventListener("change", () => {
        if (!state.bridgeUi.connected && !state.bridgeUi.connecting) {
          persistGripperMapping();
        }
      });
    }
    if (ui.bridgeToken) {
      ui.bridgeToken.addEventListener("input", () => {
        syncBridgeUx();
        if (state.bridgeUi.authRequired && state.bridgeUi.tested && !state.bridgeUi.connected && bridgeTokenValue()) {
          setBridgeStatus("Bridge token entered. Select the SO-101 port, then connect.", "ready");
        }
      });
    }
    if (ui.bridgeLocalNoToken) {
      ui.bridgeLocalNoToken.addEventListener("change", () => {
        state.bridgeUi.localNoToken = Boolean(ui.bridgeLocalNoToken.checked);
        state.bridgeUi.localNoTokenRejected = false;
        syncBridgeUx();
        if (state.bridgeUi.localNoToken) {
          setBridgeStatus("No-token local bridge selected. Use only with a bridge started using --no-token or -NoToken.", "warning");
        } else if (state.bridgeUi.authRequired && state.bridgeUi.tested && !bridgeTokenValue()) {
          setBridgeStatus("Enter the local bridge token before connecting.", "warning");
        }
      });
    }
  }

  async function switchActiveRobot(robotId) {
    if (!NS.RobotRuntime) {
      NS.RobotRegistry.setActive(robotId);
      return;
    }
    if (typeof NS.RobotRuntime.cancelLeaderSession === "function") {
      try {
        if (typeof NS.RobotRuntime.cancelRangeRecovery === "function") {
          await NS.RobotRuntime.cancelRangeRecovery("mode_switch");
        }
        await NS.RobotRuntime.cancelLeaderSession("mode_switch");
      } catch (error) {
        await NS.RobotRuntime.stopHardware().catch(() => NS.RobotRuntime.stop());
      }
    }
    if (
      activeRobotId() === "so101_follower" &&
      robotId !== "so101_follower" &&
      NS.RobotRuntime.isBridgeConnected &&
      NS.RobotRuntime.isBridgeConnected()
    ) {
      await NS.RobotRuntime.setBridgeSafetyConfirmed(false).catch(() => NS.RobotRuntime.stopHardware());
    }
    NS.RobotRuntime.setActive(robotId);
    if (robotId === "so101_follower") {
      void restoreRetainedSo101Bridge();
    }
  }

  async function applyManualRobotCommand(command) {
    if (isArduinoActive()) {
      const legacy = NS.RobotCommandSchema ? NS.RobotCommandSchema.toLegacyArduinoCommand(command) : null;
      if (legacy && legacy.type === "servo") {
        const servo = legacy.servo;
        state.angles[servo] = clampAngle(servo, legacy.angle);
        applyAngles(state.angles, { syncSliders: true, source: "manual-gripper" });
        if (state.serial.isConnected() && state.motorsEnabled && !state.runner.isRunning()) {
          scheduleManualSend(servo, state.angles[servo], null, { debounceMs: 0, showStatus: true });
        }
        return { ok: true, state: null, error: null };
      }
    }
    if (activeRobotId() === "so101_follower" && command.type !== "stop") {
      const armed = Boolean(NS.RobotRuntime && NS.RobotRuntime.isBridgeArmed && NS.RobotRuntime.isBridgeArmed());
      if (!armed) {
        setProgramStatus("SO-101 preview updated only. Connect, calibrate, and arm motion before hardware moves.");
        return { ok: false, state: null, error: new Error("SO-101 is not armed for motion.") };
      }
    }
    try {
      const runtimeState = await NS.RobotRuntime.applyCommand(command);
      syncBridgeUiFromRuntime();
      applyAngles(NS.RobotRuntime.getJointArray(), { syncSliders: true, source: "manual-robot" });
      setProgramStatus(`${activeManifest().shortName || activeManifest().name}: ${command.type}`);
      return { ok: true, state: runtimeState, error: null };
    } catch (error) {
      syncBridgeUiFromRuntime();
      const message = `Robot command rejected: ${error.message}`;
      if (activeRobotId() === "so101_follower") {
        if (error && error.code === "BRIDGE_OFFLINE") {
          blockSo101BridgeCommands(
            `Bridge connection lost during ${command.type || "motion"}. Hardware commands are blocked; test the bridge before reconnecting.`,
            { lastError: error.message || "Bridge connection unavailable." }
          );
        } else {
          setBridgeStatus(message, "error");
        }
      } else {
        setProgramStatus(message);
      }
      return { ok: false, state: NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null, error };
    }
  }

  function syncBridgeUiFromRuntime() {
    const runtimeState = NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    if (runtimeState && runtimeState.connection && activeRobotId() === "so101_follower") {
      state.bridgeUi.connected = Boolean(runtimeState.connection.connected);
      state.bridgeUi.calibrated = Boolean(runtimeState.connection.calibrated);
      state.bridgeUi.armed = Boolean(runtimeState.connection.armedForMotion);
      syncBridgeUx();
    }
    updateManualControlTelemetry(runtimeState);
    return runtimeState;
  }

  function startBridgeTelemetryPolling() {
    stopBridgeTelemetryPolling();
    state.manualControl.telemetryFailures = 0;
    state.manualControl.telemetryTimer = window.setInterval(() => {
      if (
        activeRobotId() !== "so101_follower" ||
        !state.bridgeUi.connected ||
        state.manualControl.telemetryInFlight ||
        !NS.RobotRuntime ||
        typeof NS.RobotRuntime.refreshBridgeState !== "function"
      ) {
        return;
      }
      state.manualControl.telemetryInFlight = true;
      void NS.RobotRuntime.refreshBridgeState()
        .then((runtimeState) => {
          state.manualControl.telemetryFailures = 0;
          applyBridgeUiPayload(runtimeState ? {
            connected: runtimeState.connection.connected,
            calibrated: runtimeState.connection.calibrated,
            armed: runtimeState.connection.armedForMotion,
            moving: runtimeState.connection.moving,
            limitStatus: runtimeState.connection.limitStatus,
            homeCompatible: runtimeState.connection.homeCompatible,
            homeLimitErrors: runtimeState.connection.homeLimitErrors,
            jointLimits: runtimeState.jointLimits,
            joints: runtimeState.measuredJoints,
            targetJoints: runtimeState.joints,
            gripperMapping: runtimeState.gripperMapping,
            homeControl: runtimeState.homeControl,
            manualControl: runtimeState.manualControl,
            status: runtimeState.connection.status,
            lastError: runtimeState.connection.lastError
          } : {});
        })
        .catch((error) => {
          state.manualControl.telemetryFailures += 1;
          if (state.manualControl.telemetryFailures < 3) {
            setBridgeStatus(`Feedback interrupted (${state.manualControl.telemetryFailures}/3). Retrying…`, "warning");
            updateManualControlMeta("Feedback unavailable · Retrying", "warning", "Measured feedback was interrupted. RoboBuddy is retrying without changing slider targets.");
            return;
          }
          const offlineState = {
            status: "BRIDGE_OFFLINE",
            connected: false,
            calibrated: false,
            armed: false,
            moving: false,
            limitStatus: "unavailable",
            jointLimits: {},
            manualControl: { phase: "error", error: "Bridge state polling failed." },
            lastError: error.message || "Bridge state polling failed."
          };
          blockSo101BridgeCommands(
            "Bridge connection lost after 3 missed updates. Hardware commands are blocked; test the bridge to reconnect.",
            offlineState
          );
        })
        .finally(() => {
          state.manualControl.telemetryInFlight = false;
        });
    }, 200);
  }

  function stopBridgeTelemetryPolling() {
    clearInterval(state.manualControl.telemetryTimer);
    state.manualControl.telemetryTimer = null;
    state.manualControl.telemetryInFlight = false;
  }

  function updateManualControlMeta(text, tone, title) {
    if (!ui.manualControlMeta || !ui.manualControlMetaText) {
      return;
    }
    if (ui.manualControlMetaText.textContent !== text) {
      ui.manualControlMetaText.textContent = text;
    }
    ui.manualControlMeta.dataset.tone = tone;
    ui.manualControlMeta.setAttribute("aria-label", `${text}. ${title}`);
    ui.manualControlMeta.removeAttribute("title");
    if (ui.manualLimitInfo) {
      const showLimitInfo = text.includes("Safe limits");
      ui.manualLimitInfo.hidden = !showLimitInfo;
      if (!showLimitInfo) {
        setManualLimitDetailsExpanded(false);
      }
    }
  }

  function setManualLimitDetailsExpanded(expanded) {
    if (!ui.manualLimitInfo || !ui.manualLimitDetails || !ui.manualControlMeta) {
      return;
    }
    const next = Boolean(expanded && !ui.manualLimitInfo.hidden);
    ui.manualLimitInfo.setAttribute("aria-expanded", next ? "true" : "false");
    ui.manualLimitDetails.hidden = !next;
    ui.manualControlMeta.dataset.expanded = next ? "true" : "false";
  }

  function showArmMotionRequiredHint() {
    const runtimeState = NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    const connection = runtimeState && runtimeState.connection ? runtimeState.connection : {};
    if (!connection.connected || !connection.calibrated || connection.limitStatus !== "verified") {
      setProgramStatus("Preview only. Connect the SO-101 and verify calibration before arming motion.");
      return;
    }
    if (connection.armedForMotion) {
      return;
    }
    const now = Date.now();
    if (now - state.manualControl.lastArmHintAt < 900) {
      return;
    }
    state.manualControl.lastArmHintAt = now;
    updateManualControlMeta("Preview only · Arm motion is off", "warning", "Select Arm beside this status to authorize hardware movement for this session.");
    setBridgeStatus("Preview only. Select Arm beside the Manual Control status to enable hardware movement.", "warning");
    if (ui.manualArmAction) {
      ui.manualArmAction.classList.add("is-attention");
    }
    const armLabel = ui.bridgeSafetyConfirm ? ui.bridgeSafetyConfirm.closest(".robot-bridge-panel__check--arm") : null;
    if (armLabel) {
      armLabel.classList.add("is-attention");
    }
    clearTimeout(state.manualControl.armHintTimer);
    state.manualControl.armHintTimer = window.setTimeout(() => {
      state.manualControl.armHintTimer = null;
      if (ui.manualArmAction) {
        ui.manualArmAction.classList.remove("is-attention");
      }
      if (armLabel) {
        armLabel.classList.remove("is-attention");
      }
      updateManualControlTelemetry();
    }, 2600);
  }

  function updateManualControlTelemetry(runtimeState = null) {
    const current = runtimeState || (NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null);
    const isSo101 = activeRobotId() === "so101_follower";
    const connected = Boolean(isSo101 && current && current.connection && current.connection.connected);
    const calibrated = Boolean(connected && current.connection.calibrated);
    const armed = Boolean(connected && current.connection.armedForMotion);
    const limitStatus = String((current && current.connection && current.connection.limitStatus) || "unavailable");
    const manual = current && current.manualControl && typeof current.manualControl === "object" ? current.manualControl : {};
    const homeControl = current && current.homeControl && typeof current.homeControl === "object" ? current.homeControl : {};
    const phase = String(manual.phase || "idle");
    const connectionStatus = String((current && current.connection && current.connection.status) || "").toUpperCase();
    const connectionError = String((current && current.connection && current.connection.lastError) || "").trim();
    updateBridgeLimitDiagnostics(current);

    if (!isSo101) {
      updateManualControlMeta("Preview · Default limits", "preview", "Default software limits are active.");
    } else if (phase === "feedback_unavailable") {
      updateManualControlMeta("Feedback unavailable", "error", "Measured joint feedback is unavailable. Target controls are not changed by stale feedback.");
    } else if (!connected && limitStatus === "calibration_mismatch") {
      updateManualControlMeta("Preview only · Calibration required", "error", "Hardware limits were read, but LeRobot calibration does not match the servo registers.");
    } else if (limitStatus === "unsafe_range") {
      updateManualControlMeta("Preview only · Safe range unavailable", "error", "A servo range is too narrow to apply the required safety inset.");
    } else if (!connected) {
      updateManualControlMeta("Preview · Default limits", "preview", "Default software limits are active.");
    } else if (!calibrated || limitStatus !== "verified") {
      updateManualControlMeta("Preview only · Calibration required", "error", "Motion is blocked until LeRobot calibration and hardware limits are verified.");
    } else if (!armed) {
      updateManualControlMeta("Connected · Not armed · Safe limits", "warning", "Targets stay 5° or 5% inside the servo-register limits. These limits do not detect self-collision.");
    } else if (homeControl.phase === "moving") {
      updateManualControlMeta("Moving Home · Safe limits", "live", "Home is converging through bounded LeRobot steps. STOP remains available.");
    } else {
      updateManualControlMeta("Live control · Safe limits", phase === "lagging" ? "warning" : "live", "Targets stay 5° or 5% inside the servo-register limits. These limits do not detect self-collision.");
    }

    if (ui.manualArmAction) {
      const showArmAction = connected && calibrated && limitStatus === "verified" && !armed;
      ui.manualArmAction.hidden = !showArmAction;
      ui.manualArmAction.disabled = Boolean(state.bridgeUi.armPending);
      ui.manualArmAction.textContent = state.bridgeUi.armPending ? "Arming…" : "Arm";
      if (!showArmAction) {
        ui.manualArmAction.classList.remove("is-attention");
      }
    }

    const measured = current && current.measuredJoints ? current.measuredJoints : {};
    activeJoints().forEach((joint, index) => {
      const actual = document.getElementById(`actual${index}`);
      if (!actual) {
        return;
      }
      const hasMeasurement = connected && Object.prototype.hasOwnProperty.call(measured, joint.id);
      actual.hidden = !hasMeasurement;
      if (!hasMeasurement) {
        actual.textContent = "Actual —";
        actual.removeAttribute("data-phase");
        return;
      }
      const isActiveJoint = manual.joint === joint.id;
      const limit = current && current.jointLimits ? current.jointLimits[joint.id] : null;
      const measuredValue = Number(measured[joint.id]);
      const manualLimits = getManualJointLimits(joint, limit ? [Number(limit.min), Number(limit.max)] : [Number(joint.min), Number(joint.max)]);
      const outsideSafe = Boolean(
        limit && Number.isFinite(measuredValue) &&
        (measuredValue < Number(limit.min) || measuredValue > Number(limit.max))
      );
      const outsideManual = Boolean(
        Number.isFinite(measuredValue) &&
        Number.isFinite(manualLimits[0]) && Number.isFinite(manualLimits[1]) &&
        (measuredValue < manualLimits[0] || measuredValue > manualLimits[1])
      );
      const phaseLabels = {
        queued: "Queued",
        moving: "Moving",
        reached: "Reached",
        lagging: "Lagging",
        cancelled: "Cancelled",
        program: "Program",
        error: "Error",
        feedback_unavailable: "No feedback"
      };
      let suffix = "";
      if (outsideSafe) {
        suffix = " · Outside safe range";
      } else if (outsideManual) {
        suffix = " · Outside manual range";
      } else if (isActiveJoint && phaseLabels[phase]) {
        suffix = ` · ${phaseLabels[phase]}`;
      }
      actual.textContent = `Actual ${formatJointReadout(joint, measured[joint.id])}${suffix}`;
      actual.title = isActiveJoint && manual.error ? String(manual.error) : "Measured position";
      if (outsideSafe || outsideManual) {
        actual.dataset.phase = "outside_safe";
      } else if (isActiveJoint) {
        actual.dataset.phase = phase;
      } else {
        actual.removeAttribute("data-phase");
      }
    });

    if (["reached", "lagging", "cancelled", "error", "feedback_unavailable"].includes(phase) && state.manualControl.lastAnnouncedPhase !== phase) {
      state.manualControl.lastAnnouncedPhase = phase;
      const joint = activeJoints().find((item) => item.id === manual.joint);
      const label = joint ? joint.label : "Joint";
      const messages = {
        reached: `${label} reached the requested target.`,
        lagging: `${label} has not reached the requested target.`,
        cancelled: `${label} live movement was cancelled.`,
        error: `${label} live movement failed.`,
        feedback_unavailable: `${label} measured feedback is unavailable.`
      };
      if (messages[phase]) {
        setProgramStatus(messages[phase]);
      }
    } else if (phase === "moving" || phase === "queued") {
      state.manualControl.lastAnnouncedPhase = "";
    }
    if (phase === "error" && manual.error && !armed) {
      setBridgeStatus(`Motion disarmed: ${manual.error}`, "error");
    } else if (
      connected && !armed && connectionError &&
      (connectionStatus === "ERROR" || /(?:hold|write|feedback).*failed|unavailable/i.test(connectionError))
    ) {
      setBridgeStatus(`Motion disarmed: ${connectionError}`, "error");
    }
    syncSliderLimitsFromJointLimits();
    updateManualControlLockUi();
  }

  function updateBridgeLimitDiagnostics(runtimeState) {
    if (!ui.bridgeLimitDiagnostics || !ui.bridgeLimitDiagnosticsRows || !ui.bridgeLimitDiagnosticsStatus) {
      return;
    }
    const limits = runtimeState && runtimeState.jointLimits && typeof runtimeState.jointLimits === "object"
      ? runtimeState.jointLimits
      : {};
    const rows = activeJoints()
      .map((joint) => ({ joint, limit: limits[joint.id] }))
      .filter(({ limit }) => limit && Number.isFinite(Number(limit.rawMin)) && Number.isFinite(Number(limit.rawMax)));
    ui.bridgeLimitDiagnostics.hidden = rows.length === 0;
    if (rows.length === 0) {
      ui.bridgeLimitDiagnosticsRows.replaceChildren();
      return;
    }
    const limitStatus = String((runtimeState.connection && runtimeState.connection.limitStatus) || "unavailable");
    ui.bridgeLimitDiagnosticsStatus.textContent = limitStatus === "verified" ? "Safe · verified" : "Safe · unverified";
    ui.bridgeLimitDiagnosticsRows.innerHTML = rows.map(({ joint, limit }) => {
      const resolution = Number(limit.resolution);
      const resolutionText = Number.isFinite(resolution) ? `${resolution} ticks/rev` : "resolution unavailable";
      const hardwareMin = Number(limit.hardwareMin);
      const hardwareMax = Number(limit.hardwareMax);
      const hardwareRange = Number.isFinite(hardwareMin) && Number.isFinite(hardwareMax)
        ? formatJointRange(joint, hardwareMin, hardwareMax)
        : "hardware range unavailable";
      const manualLimits = getManualJointLimits(joint, [Number(limit.min), Number(limit.max)]);
      const hasManualOverride = Number.isFinite(manualLimits[0]) && Number.isFinite(manualLimits[1]) && (
        Math.abs(manualLimits[0] - Number(limit.min)) > 0.001 ||
        Math.abs(manualLimits[1] - Number(limit.max)) > 0.001
      );
      const manualRange = hasManualOverride
        ? ` · Manual ${formatJointRange(joint, manualLimits[0], manualLimits[1])}`
        : "";
      const margin = Number(limit.margin);
      const marginUnit = joint.unit === "percent" ? "%" : "°";
      return `<div class="robot-bridge-panel__limit-row">
        <span>${escapeHtml(joint.label)}</span>
        <code>${escapeHtml(String(limit.rawMin))}–${escapeHtml(String(limit.rawMax))} ticks</code>
        <small>Safe ${escapeHtml(formatJointRange(joint, Number(limit.min), Number(limit.max)))}${escapeHtml(manualRange)} · Hardware ${escapeHtml(hardwareRange)} · ${escapeHtml(formatNumericReadout(margin))}${marginUnit} inset · ${escapeHtml(resolutionText)}</small>
      </div>`;
    }).join("");
  }

  async function handleDriveButton(action) {
    const manifest = activeManifest();
    if (!manifest || !manifest.mobileBase) {
      return;
    }
    const maxLinear = Number(manifest.mobileBase.maxLinearSpeed) || 1;
    const maxAngular = Number(manifest.mobileBase.maxAngularSpeed) || 90;
    const base = { type: "drive", robotId: manifest.id, vx: 0, vy: 0, omega: 0, seconds: 0.7, frame: "robot" };
    if (action === "forward") base.vx = 0.35 * maxLinear;
    if (action === "backward") base.vx = -0.35 * maxLinear;
    if (action === "left") base.vy = 0.35 * maxLinear;
    if (action === "right") base.vy = -0.35 * maxLinear;
    if (action === "turn-left") base.omega = 0.5 * maxAngular;
    if (action === "turn-right") base.omega = -0.5 * maxAngular;
    if (action === "stop") {
      await applyManualRobotCommand({ type: "stop", robotId: manifest.id, reason: "user" });
      return;
    }
    await applyManualRobotCommand(base);
  }

  async function testBridgeHealth() {
    if (!NS.RobotRuntime || !ui.bridgeUrl) {
      return;
    }
    const bridge = NS.RobotRuntime.createBridgeAdapter({ baseUrl: ui.bridgeUrl.value, token: bridgeTokenValue() });
    try {
      const result = await bridge.health();
      if (NS.RobotRuntime && typeof NS.RobotRuntime.applyBridgeCapabilities === "function") {
        NS.RobotRuntime.applyBridgeCapabilities(result);
      }
      state.bridgeUi.tested = true;
      state.bridgeUi.authRequired = Boolean(result && result.authRequired);
      if (!state.bridgeUi.authRequired) {
        state.bridgeUi.localNoToken = true;
        state.bridgeUi.localNoTokenRejected = false;
      } else if (bridgeUsesLocalNoToken()) {
        state.bridgeUi.localNoTokenRejected = true;
      } else {
        state.bridgeUi.localNoTokenRejected = false;
      }
      await loadBridgePorts(bridge);
      if (state.bridgeUi.localNoTokenRejected) {
        revealBridgeDiagnostics();
        setBridgeStatus(noTokenLocalRejectedMessage(), "error");
      } else if (bridgeRequiresToken() && !bridgeTokenValue()) {
        revealBridgeDiagnostics();
        setBridgeStatus(`Bridge ${result.status || "READY"}. Enter the local bridge token before connecting.`, "warning");
      } else if (bridgeUsesLocalNoToken()) {
        setBridgeStatus(`Bridge ${result.status || "READY"}. No-token local mode is active.`, "ready");
      } else {
        setBridgeStatus(`Bridge ${result.status || "READY"}`, "ready");
      }
      syncBridgeUx();
    } catch (error) {
      state.bridgeUi.tested = false;
      state.bridgeUi.authRequired = false;
      state.bridgeUi.localNoTokenRejected = false;
      setBridgeStatus(error.message || "Bridge unavailable", "error");
      syncBridgeUx();
    }
  }

  async function connectSo101Bridge() {
    if (!NS.RobotRuntime || !ui.bridgeUrl || state.bridgeUi.connecting) {
      return;
    }
    const bridge = NS.RobotRuntime.createBridgeAdapter({ baseUrl: ui.bridgeUrl.value, token: bridgeTokenValue() });
    const port = getBridgeSelectedPort();
    if (bridgeRequiresToken() && !bridgeTokenValue()) {
      revealBridgeDiagnostics();
      setBridgeStatus("Enter the bridge token printed by PowerShell before connecting.", "error");
      syncBridgeUx();
      return;
    }
    if (!port) {
      setBridgeStatus("Test the bridge, then select an SO-101 port before connecting.", "error");
      syncBridgeUx();
      return;
    }
    state.bridgeUi.connecting = true;
    setBridgeStatus("Connecting to SO-101 and reading servo limits…", "warning");
    updateManualControlMeta("Connecting · Reading limits", "warning", "Connecting to the bridge and reading servo position-limit registers.");
    syncBridgeUx();
    updateManualControlLockUi();
    try {
      persistGripperMapping();
      const result = await bridge.connect("so101_follower", {
        port,
        robotInstanceId: ui.bridgeRobotInstance ? ui.bridgeRobotInstance.value : "classroom_so101_01",
        gripperMapping: selectedGripperMapping(),
        dryRun: false
      });
      const description = NS.RobotRuntime.describeBridgeConnectionResult(result);
      const bridgeState = description.ok ? result : { ...result, connected: false, calibrated: false };
      NS.RobotRuntime.setMode("local_bridge");
      NS.RobotRuntime.applyBridgeState(bridgeState);
      applyBridgeUiPayload(bridgeState);
      setBridgeStatus(description.message, description.tone);
      if (bridgeState.connected) {
        if (NS.RobotRuntime && typeof NS.RobotRuntime.rememberBridgeSession === "function") {
          NS.RobotRuntime.rememberBridgeSession({
            bridgeUrl: ui.bridgeUrl.value,
            authRequired: state.bridgeUi.authRequired,
            noTokenLocal: !state.bridgeUi.authRequired
          });
        }
        startBridgeTelemetryPolling();
      }
    } catch (error) {
      state.bridgeUi.connected = false;
      state.bridgeUi.calibrated = false;
      state.bridgeUi.armed = false;
      if (/Bridge token required/i.test(error.message || "")) {
        state.bridgeUi.authRequired = true;
        if (bridgeUsesLocalNoToken()) {
          state.bridgeUi.localNoTokenRejected = true;
          revealBridgeDiagnostics();
          setBridgeStatus(noTokenLocalRejectedMessage(), "error");
          syncBridgeUx();
          return;
        }
        state.bridgeUi.localNoTokenRejected = false;
      }
      setBridgeStatus(error.message || "SO-101 bridge connection failed", "error");
    } finally {
      state.bridgeUi.connecting = false;
      syncBridgeUx();
      updateManualControlLockUi();
    }
  }

  async function disconnectSo101Bridge() {
    stopBridgeTelemetryPolling();
    const bridge = NS.RobotRuntime && NS.RobotRuntime.getBridgeAdapter ? NS.RobotRuntime.getBridgeAdapter() : null;
    if (!bridge) {
      if (NS.RobotRuntime && typeof NS.RobotRuntime.forgetBridgeSession === "function") {
        NS.RobotRuntime.forgetBridgeSession();
      }
      resetBridgeUiState({ keepTested: true });
      setBridgeStatus("SO-101 disconnected", "warning");
      return;
    }
    try {
      await clearManualSessionState("disconnect");
      if (NS.RobotRuntime && typeof NS.RobotRuntime.cancelRangeRecovery === "function") {
        await NS.RobotRuntime.cancelRangeRecovery("disconnect");
      }
      if (NS.RobotRuntime && typeof NS.RobotRuntime.cancelLeaderSession === "function") {
        await NS.RobotRuntime.cancelLeaderSession("disconnect");
      }
      const result = await bridge.disconnect("so101_follower");
      if (NS.RobotRuntime.invalidateBridgeConnection) {
        NS.RobotRuntime.invalidateBridgeConnection(result);
      } else {
        NS.RobotRuntime.applyBridgeState(result);
      }
      if (NS.RobotRuntime && typeof NS.RobotRuntime.forgetBridgeSession === "function") {
        NS.RobotRuntime.forgetBridgeSession();
      }
      resetBridgeUiState({ keepTested: state.bridgeUi.tested, keepPorts: true });
      setBridgeStatus("SO-101 disconnected", "warning");
    } catch (error) {
      const disconnectDetail = String(error.message || "bridge unavailable").trim().replace(/[.\s]+$/, "");
      blockSo101BridgeCommands(
        `Disconnect could not be confirmed: ${disconnectDetail}. Hardware commands are blocked; verify the arm is stationary before reconnecting.`,
        { lastError: error.message || "Disconnect failed." }
      );
    }
  }

  async function restoreRetainedSo101Bridge() {
    if (
      activeRobotId() !== "so101_follower" ||
      !NS.RobotRuntime ||
      typeof NS.RobotRuntime.hasBridgeSession !== "function" ||
      !NS.RobotRuntime.hasBridgeSession() ||
      typeof NS.RobotRuntime.reattachBridgeSession !== "function"
    ) {
      return false;
    }

    const descriptor = NS.RobotRuntime.readBridgeSession ? NS.RobotRuntime.readBridgeSession() : null;
    if (descriptor && ui.bridgeUrl) {
      ui.bridgeUrl.value = descriptor.bridgeUrl;
    }
    if (ui.bridgeLocalNoToken) {
      ui.bridgeLocalNoToken.checked = true;
    }
    state.bridgeUi.localNoToken = true;
    state.bridgeUi.connecting = true;
    setBridgeStatus("Reattaching to the retained SO-101 bridge...", "warning");
    syncBridgeUx();
    try {
      const result = await NS.RobotRuntime.reattachBridgeSession({ disarm: true });
      if (!result.attached) {
        const detail = result.error && result.error.message
          ? result.error.message
          : "The retained bridge session is no longer connected. Test the bridge and reconnect the SO-101.";
        state.bridgeUi.tested = result.status !== "BRIDGE_OFFLINE";
        resetBridgeUiState({ keepTested: state.bridgeUi.tested, keepPorts: true });
        setBridgeStatus(detail, "error");
        return false;
      }

      const bridgeState = result.bridgeState || {};
      state.bridgeUi.tested = true;
      state.bridgeUi.authRequired = false;
      state.bridgeUi.localNoToken = true;
      state.bridgeUi.localNoTokenRejected = false;
      const bridge = NS.RobotRuntime.getBridgeAdapter ? NS.RobotRuntime.getBridgeAdapter() : null;
      await loadBridgePorts(bridge);
      if (ui.bridgePortSelect && bridgeState.port) {
        ui.bridgePortSelect.value = bridgeState.port;
      }
      if (ui.bridgeRobotInstance && bridgeState.robotInstanceId) {
        ui.bridgeRobotInstance.value = bridgeState.robotInstanceId;
      }
      if (ui.bridgeGripperMapping && bridgeState.gripperMapping) {
        ui.bridgeGripperMapping.value = bridgeState.gripperMapping;
      }
      applyBridgeUiPayload(bridgeState);
      setBridgeStatus("SO-101 connection retained. Motion is disarmed for this page; arm it explicitly before moving.", "ready");
      startBridgeTelemetryPolling();
      return true;
    } finally {
      state.bridgeUi.connecting = false;
      syncBridgeUx();
      updateManualControlLockUi();
    }
  }

  async function loadBridgePorts(bridge) {
    if (!ui.bridgePortSelect || !bridge || typeof bridge.listPorts !== "function") {
      return;
    }
    try {
      const result = await bridge.listPorts();
      const ports = Array.isArray(result.ports) ? result.ports : [];
      state.bridgeUi.portsLoaded = true;
      ui.bridgePortSelect.innerHTML = ports.length
        ? ports.map((port) => `<option value="${escapeHtml(port.port)}">${escapeHtml(port.port)} - ${escapeHtml(port.label || port.port)}</option>`).join("")
        : `<option value="">${result.status === "PYSERIAL_NOT_INSTALLED" ? "Install bridge extras to list ports" : "No SO-101 ports found"}</option>`;
    } catch (error) {
      state.bridgeUi.portsLoaded = false;
      ui.bridgePortSelect.innerHTML = `<option value="">Port list unavailable</option>`;
    }
  }

  function getBridgeSelectedPort() {
    return ui.bridgePortSelect ? String(ui.bridgePortSelect.value || "").trim() : "";
  }

  function normalizedRobotInstanceId() {
    const value = ui.bridgeRobotInstance ? ui.bridgeRobotInstance.value : "classroom_so101_01";
    return String(value || "classroom_so101_01").trim().toLowerCase() || "classroom_so101_01";
  }

  function readGripperMappings() {
    try {
      const value = JSON.parse(localStorage.getItem(GRIPPER_MAPPING_STORAGE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      return {};
    }
  }

  function selectedGripperMapping() {
    const value = ui.bridgeGripperMapping ? ui.bridgeGripperMapping.value : "closed_at_min";
    return value === "closed_at_max" ? "closed_at_max" : "closed_at_min";
  }

  function syncGripperMappingControl() {
    if (!ui.bridgeGripperMapping) {
      return;
    }
    const mappings = readGripperMappings();
    const stored = mappings[normalizedRobotInstanceId()];
    ui.bridgeGripperMapping.value = stored === "closed_at_max" ? "closed_at_max" : "closed_at_min";
  }

  function persistGripperMapping() {
    const mappings = readGripperMappings();
    mappings[normalizedRobotInstanceId()] = selectedGripperMapping();
    try {
      localStorage.setItem(GRIPPER_MAPPING_STORAGE_KEY, JSON.stringify(mappings));
    } catch (error) {
      // The active selection still applies to this connection when storage is unavailable.
    }
  }

  function applyBridgeUiPayload(payload = {}) {
    state.bridgeUi.lastPayload = payload;
    state.bridgeUi.connected = Boolean(payload.connected);
    state.bridgeUi.calibrated = Boolean(payload.calibrated);
    state.bridgeUi.armed = Boolean(NS.RobotRuntime && NS.RobotRuntime.isBridgeArmed && NS.RobotRuntime.isBridgeArmed());
    state.bridgeUi.localNoTokenRejected = false;
    syncBridgeUx();
    if ((payload.targetJoints || payload.joints) && state.manualControl.activeServo === null && !state.manualControl.streamPending) {
      applyAngles(NS.RobotRuntime.getJointArray(), { syncSliders: true, source: "bridge-state" });
    }
    updateManualControlTelemetry();
  }

  function resetBridgeUiState(options = {}) {
    stopBridgeTelemetryPolling();
    state.bridgeUi.tested = Boolean(options.keepTested && state.bridgeUi.tested);
    state.bridgeUi.portsLoaded = Boolean(options.keepPorts && state.bridgeUi.portsLoaded);
    state.bridgeUi.connected = false;
    state.bridgeUi.calibrated = false;
    state.bridgeUi.armed = false;
    state.bridgeUi.connecting = false;
    state.bridgeUi.armPending = false;
    state.bridgeUi.homePending = false;
    state.manualControl.telemetryFailures = 0;
    if (!options.keepTested) {
      state.bridgeUi.authRequired = false;
      state.bridgeUi.localNoToken = false;
      state.bridgeUi.localNoTokenRejected = false;
    }
    state.bridgeUi.lastPayload = null;
    if (ui.bridgeSafetyConfirm) {
      ui.bridgeSafetyConfirm.checked = false;
    }
    if (NS.RobotRuntime && NS.RobotRuntime.setBridgeSafetyConfirmed) {
      void NS.RobotRuntime.setBridgeSafetyConfirmed(false);
    }
    syncBridgeUx();
  }

  function blockSo101BridgeCommands(message, payload = {}) {
    stopBridgeTelemetryPolling();
    void clearManualSessionState("bridge_offline", { sendCancel: false });
    const detail = payload.lastError || payload.error || "Bridge connection unavailable.";
    const offlineState = {
      ...payload,
      status: "BRIDGE_OFFLINE",
      connected: false,
      calibrated: false,
      armed: false,
      moving: false,
      limitStatus: "unavailable",
      jointLimits: {},
      manualControl: payload.manualControl || {
        phase: "error",
        error: detail
      },
      lastError: detail
    };
    if (NS.RobotRuntime && typeof NS.RobotRuntime.invalidateBridgeConnection === "function") {
      NS.RobotRuntime.invalidateBridgeConnection(offlineState);
    } else if (NS.RobotRuntime && typeof NS.RobotRuntime.applyBridgeState === "function") {
      NS.RobotRuntime.applyBridgeState(offlineState);
    }
    resetBridgeUiState({ keepTested: false, keepPorts: true });
    setBridgeStatus(message, "error");
    updateManualControlMeta("Feedback unavailable", "error", "Hardware commands are blocked until the bridge is tested and reconnected.");
  }

  function syncBridgeUx() {
    if (!ui.robotBridgePanel) {
      return;
    }
    const isSo101 = activeRobotId() === "so101_follower";
    ui.robotBridgePanel.hidden = !isSo101;
    if (ui.manualControlsCard) {
      ui.manualControlsCard.classList.toggle("has-bridge-controls", isSo101);
    }
    if (!isSo101) {
      return;
    }
    const hasPort = Boolean(getBridgeSelectedPort());
    const connected = state.bridgeUi.connected;
    const calibrated = state.bridgeUi.calibrated;
    const connecting = state.bridgeUi.connecting;
    const armPending = state.bridgeUi.armPending;
    const runtimeState = NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    const limitVerified = Boolean(runtimeState && runtimeState.connection && runtimeState.connection.limitStatus === "verified");
    const bridgePayloadStatus = String((state.bridgeUi.lastPayload && state.bridgeUi.lastPayload.status) || "").toUpperCase();
    const calibrationBlocked = bridgePayloadStatus === "NEEDS_CALIBRATION" || (connected && (!calibrated || !limitVerified));
    const needsToken = Boolean(bridgeRequiresToken() && !bridgeTokenValue());
    const noTokenRejected = Boolean(bridgeUsesLocalNoToken() && state.bridgeUi.localNoTokenRejected);
    const armed = Boolean(NS.RobotRuntime && NS.RobotRuntime.isBridgeArmed && NS.RobotRuntime.isBridgeArmed());
    state.bridgeUi.armed = armed;
    ui.robotBridgePanel.dataset.authRequired = state.bridgeUi.authRequired ? "true" : "false";
    ui.robotBridgePanel.dataset.localNoToken = bridgeUsesLocalNoToken() ? "true" : "false";
    ui.robotBridgePanel.dataset.localNoTokenRejected = noTokenRejected ? "true" : "false";
    if (needsToken || noTokenRejected) {
      revealBridgeDiagnostics();
    }
    setBridgeStep(ui.bridgeStepBridge, state.bridgeUi.tested ? "ready" : "pending");
    setBridgeStep(ui.bridgeStepPort, hasPort ? "ready" : (state.bridgeUi.tested ? "warning" : "pending"));
    setBridgeStep(ui.bridgeStepCalibration, calibrated && limitVerified ? "ready" : (calibrationBlocked ? "error" : "pending"));
    setBridgeStep(ui.bridgeStepMotion, armed ? "ready" : (connected && calibrated ? "warning" : "pending"));
    if (ui.btnBridgeHealth) {
      ui.btnBridgeHealth.hidden = connected;
      ui.btnBridgeHealth.disabled = connecting;
    }
    if (ui.btnBridgeConnect) {
      ui.btnBridgeConnect.hidden = false;
      ui.btnBridgeConnect.disabled = connecting || connected || !state.bridgeUi.tested || !hasPort || needsToken || noTokenRejected;
    }
    if (ui.btnBridgeDisconnect) {
      ui.btnBridgeDisconnect.hidden = false;
      ui.btnBridgeDisconnect.disabled = connecting || !connected;
    }
    if (ui.bridgeSafetyConfirm) {
      ui.bridgeSafetyConfirm.disabled = armPending || !connected || !calibrated || !limitVerified;
      ui.bridgeSafetyConfirm.checked = armed;
    }
    if (ui.bridgeToken) {
      ui.bridgeToken.disabled = bridgeUsesLocalNoToken();
    }
    if (ui.bridgeLocalNoToken) {
      ui.bridgeLocalNoToken.checked = bridgeUsesLocalNoToken();
    }
    if (ui.bridgePortSelect) {
      ui.bridgePortSelect.disabled = connecting || connected;
    }
    if (ui.bridgeRobotInstance) {
      ui.bridgeRobotInstance.disabled = connecting || connected;
    }
    if (ui.bridgeGripperMapping) {
      ui.bridgeGripperMapping.disabled = connecting || connected;
    }
    syncExecutionTarget();
  }

  function setBridgeStep(element, stateName) {
    if (element) {
      const label = String(element.dataset.label || element.textContent || "").trim() || "Step";
      const stateLabel = {
        pending: "pending",
        ready: "ready",
        warning: "waiting",
        error: "blocked"
      }[stateName] || stateName;
      element.dataset.state = stateName;
      element.title = `${label}: ${stateLabel}`;
      element.setAttribute("aria-label", `${label}: ${stateLabel}`);
    }
  }

  function setBridgeStatus(text, tone) {
    if (ui.bridgeStatus) {
      ui.bridgeStatus.textContent = text;
      ui.bridgeStatus.dataset.tone = tone || "warning";
    }
    if (ui.drawerBridgeSummary) {
      ui.drawerBridgeSummary.textContent = text;
      ui.drawerBridgeSummary.dataset.tone = tone || "warning";
    }
    setProgramStatus(text);
    if (tone === "error") {
      updateStatusIcon("alert-triangle", false, true);
    } else if (tone === "ready") {
      updateStatusIcon("circle-check", false, false);
    } else {
      updateStatusIcon("alert-triangle", false, false, true);
    }
  }

  function bridgeTokenValue() {
    if (bridgeUsesLocalNoToken()) {
      return "";
    }
    return ui.bridgeToken ? String(ui.bridgeToken.value || "").trim() : "";
  }

  function bridgeUsesLocalNoToken() {
    return Boolean(state.bridgeUi.localNoToken);
  }

  function bridgeRequiresToken() {
    return Boolean(state.bridgeUi.authRequired && !bridgeUsesLocalNoToken());
  }

  function noTokenLocalRejectedMessage() {
    return "This bridge is still token-protected. Restart it with --no-token or -NoToken, then click Test Bridge, or uncheck No-token local and enter the token.";
  }

  function revealBridgeDiagnostics() {
    if (ui.bridgeDiagnostics) {
      ui.bridgeDiagnostics.open = true;
    }
  }

  function slugJoint(value) {
    return String(value || "joint").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function wireSerialEvents() {
    state.serial.addEventListener("status", (event) => {
      const detail = event.detail || {};
      const connected = Boolean(detail.connected);
      const message = detail.message || "";
      setConnectionStatus(connected, message);
      appendSerialConsole("SYS", `${connected ? "Connected" : "Disconnected"}: ${message || "-"}`);
      if (!connected) {
        resetMotorDebugState(message || "Disconnected");
      } else {
        updateMotorDebugUi();
      }

      const btnSpan = ui.btnConnect.querySelector("span");
      if (btnSpan && isArduinoActive()) {
        btnSpan.textContent = connected ? "Disconnect" : "Connect";
      }
      const btnIcon = ui.btnConnect.querySelector("[data-lucide]");
      if (btnIcon && window.lucide && isArduinoActive()) {
        btnIcon.setAttribute("data-lucide", connected ? "unlink" : "plug");
        lucide.createIcons({ nodes: [btnIcon] });
      }

      updateProgramControlUi();
    });

    state.serial.addEventListener("positions", (event) => {
      if (!event.detail || !Array.isArray(event.detail.angles)) {
        return;
      }
      void processDevicePositions(event.detail.angles, "serial-stream");
    });

    state.serial.addEventListener("tx", (event) => {
      const command = event.detail ? event.detail.command : "";
      if (command) {
        appendSerialConsole("TX", command);
        onMotorDebugTx(command);
      }
    });

    state.serial.addEventListener("queue", () => {
      updateMotorDebugUi();
    });

    state.serial.addEventListener("line", (event) => {
      const line = event.detail ? event.detail.line : "";
      if (!line) {
        return;
      }

      appendSerialConsole("RX", line);
      onMotorDebugRx(line);

      if (line === "STOPPED") {
        setProgramStatus("Emergency stop confirmed");
      } else if (line.startsWith("ERR")) {
        setProgramStatus(`Device error: ${line}`);
      } else if (line === "READY") {
        setProgramStatus("Device ready");
      }
    });
  }

  function wireRunnerEvents() {
    state.runner.addEventListener("status", (event) => {
      const text = event.detail ? event.detail.text : "";
      if (text) {
        setProgramStatus(text);
      }
      updateProgramControlUi();
      updateMotorDebugUi();
    });

    state.runner.addEventListener("paused", () => {
      updateProgramControlUi();
      updateMotorDebugUi();
    });

    state.runner.addEventListener("running", (event) => {
      const running = Boolean(event.detail && event.detail.running);
      if (running) {
        state.programLastError = "";
        clearPendingManualSends();
        clearManualSessionState();
        setControlOwner(CONTROL_OWNER.PROGRAM);
      } else {
        clearManualSessionState();
        setControlOwner(CONTROL_OWNER.IDLE);
      }

      updateProgramControlUi();
      updateMotorDebugUi();
    });

    state.runner.addEventListener("error", (event) => {
      const error = event.detail ? event.detail.error : null;
      if (error) {
        state.programLastError = error.message || String(error);
        setProgramStatus(`Runner error: ${error.message}`);
      }
      clearManualSessionState();
      setControlOwner(CONTROL_OWNER.IDLE);
      updateProgramControlUi();
      updateMotorDebugUi();
    });
    updateProgramControlUi();
    updateMotorDebugUi();
  }

  function onPreviewAnglesChange(nextAngles, meta = {}) {
    if (state.controlOwner === CONTROL_OWNER.PROGRAM || state.runner.isRunning()) {
      showProgramLockHint();
      return;
    }

    if (state.manualControl.activeServo !== null) {
      return;
    }

    applyAngles(nextAngles, { syncSliders: true, source: "preview" });

    if (!state.serial.isConnected() || !state.motorsEnabled) {
      return;
    }

    const changed = Array.isArray(meta.changedIndices) && meta.changedIndices.length > 0
      ? meta.changedIndices
      : [0, 1, 2, 3, 4, 5];

    for (const servo of changed) {
      scheduleManualSend(servo, state.angles[servo], null);
    }
  }

  function onPreviewDragStateChange(isDragging) {
    if (!ui.armPreview) {
      return;
    }
    ui.armPreview.classList.toggle("is-dragging", Boolean(isDragging));
  }

  async function triggerEmergencyStop(source = "ui") {
    const replayingTeach = state.teach.phase === TEACH_PHASE.REPLAYING;
    if (NS.VirtualLeaderUI && typeof NS.VirtualLeaderUI.retireForEmergencyStop === "function") {
      NS.VirtualLeaderUI.retireForEmergencyStop(source);
    }
    state.runner.stop();
    if (NS.RobotRuntime) {
      NS.RobotRuntime.stop();
    }
    clearPendingManualSends();
    clearManualSessionState();
    if (replayingTeach) {
      state.teach.replayStopRequested = true;
    } else {
      setControlOwner(CONTROL_OWNER.IDLE);
    }
    let so101StopConfirmed = false;
    try {
      if (!isArduinoActive() && activeRobotId() === "so101_follower" && NS.RobotRuntime && NS.RobotRuntime.stopHardware) {
        const stopResult = await NS.RobotRuntime.stopHardware();
        const confirmation = stopResult && stopResult.stopConfirmation;
        so101StopConfirmed = !confirmation || confirmation.hardwareRequired !== true || confirmation.hardwareConfirmed === true;
        if (!so101StopConfirmed) {
          throw new Error("SO-101 hardware STOP was not confirmed.");
        }
        applyAngles(NS.RobotRuntime.getJointArray(), { syncSliders: true, source: "bridge-stop" });
        syncBridgeUx();
      }
      if (state.serial.isConnected()) {
        await state.serial.emergencyStop();
      }
      await setMotorsEnabled(false, { sendCommand: false, showStatus: false });
      if (replayingTeach) {
        setProgramStatus("Emergency stop triggered. Stopping teach replay...");
        updateTeachControlsUi();
        updateProgramControlUi();
      } else {
        const controllerSource = source === "gamepad" || source === "leader_fallback";
        setProgramStatus(`Emergency stop triggered${controllerSource ? " by controller" : ""}`);
      }
    } catch (error) {
      if (activeRobotId() === "so101_follower" && !so101StopConfirmed) {
        const stopDetail = String(error.message || "bridge unavailable").trim().replace(/[.\s]+$/, "");
        const message = `STOP could not be confirmed: ${stopDetail}. Hardware commands are blocked locally; verify the arm is stationary before reconnecting.`;
        blockSo101BridgeCommands(message, { lastError: error.message || "STOP failed." });
        setProgramStatus(message);
      } else {
        setProgramStatus(`Emergency stop failed: ${error.message}`);
      }
    }
  }

  function wireButtons() {
    ui.btnConnect.addEventListener("click", async () => {
      await handleConnectToggle();
    });

    ui.btnHome.addEventListener("click", async () => {
      if (!isArduinoActive()) {
        if (activeRobotId() === "so101_follower" && NS.RobotRuntime && NS.RobotRuntime.isBridgeArmed && NS.RobotRuntime.isBridgeArmed()) {
          if (state.bridgeUi.homePending) {
            return;
          }
          const label = ui.btnHome.querySelector("span");
          state.bridgeUi.homePending = true;
          ui.btnHome.setAttribute("aria-busy", "true");
          if (label) label.textContent = "Moving…";
          setBridgeStatus("Moving to Compact Home through bounded servo steps…", "warning");
          setProgramStatus("Moving to Compact Home…");
          updateManualControlLockUi();
          updateProgramControlUi();
          try {
            const result = await applyManualRobotCommand({ type: "home", robotId: "so101_follower" });
            const runtimeState = result.state || (NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null);
            const homeControl = runtimeState && runtimeState.homeControl ? runtimeState.homeControl : {};
            const phase = String(homeControl.phase || (result.ok ? "reached" : "error"));
            if (phase === "reached") {
              setBridgeStatus("Compact Home reached.", "ready");
              setProgramStatus("SO-101 Compact Home reached");
            } else if (phase === "lagging") {
              setBridgeStatus("Home lagging: one or more joints remain outside tolerance.", "warning");
              setProgramStatus("SO-101 Home lagging");
            } else if (phase === "cancelled") {
              setBridgeStatus("Home cancelled. Motion remains disarmed.", "warning");
              setProgramStatus("SO-101 Home cancelled");
            } else {
              const detail = homeControl.error || (result.error && result.error.message) || "Home failed.";
              setBridgeStatus(`Home failed: ${detail}`, "error");
              setProgramStatus(`SO-101 Home failed: ${detail}`);
            }
          } finally {
            state.bridgeUi.homePending = false;
            ui.btnHome.removeAttribute("aria-busy");
            if (label) label.textContent = "Move Arm Home";
            updateManualControlLockUi();
            updateProgramControlUi();
          }
          return;
        }
        if (NS.RobotRuntime) {
          NS.RobotRuntime.home();
          applyAngles(NS.RobotRuntime.getJointArray(), { syncSliders: true, source: "home" });
        }
        setProgramStatus(activeRobotId() === "so101_follower"
          ? "SO-101 preview moved to home. Arm motion is not armed."
          : `${activeManifest().shortName || activeManifest().name} moved to home pose`);
        return;
      }
      if (!ensureMotionAllowed()) {
        return;
      }
      try {
        if (state.serial.isConnected()) {
          await state.serial.home();
        }
        applyAngles(HOME_ANGLES, { syncSliders: true, source: "home" });
        setProgramStatus("Moved to home position");
      } catch (error) {
        setProgramStatus(`Home failed: ${error.message}`);
      }
    });

    if (ui.btnResetDefault) {
      ui.btnResetDefault.addEventListener("click", async () => {
        await handleResetToDefaultPosition();
      });
    }

    ui.btnEmergencyStop.addEventListener("click", () => void triggerEmergencyStop("button"));

    ui.btnRun.addEventListener("click", () => {
      void runProgram();
    });

    if (ui.btnPause) {
      ui.btnPause.addEventListener("click", async () => {
        await handleProgramPauseResume();
      });
    }

    ui.btnStop.addEventListener("click", async () => {
      await handleProgramStop();
    });

    ui.btnSave.addEventListener("click", () => {
      if (usesBlockFileWorkflow()) {
        void saveWorkspaceBlocksToFile();
        return;
      }
      openSaveDialog();
    });

    ui.btnLoad.addEventListener("click", () => {
      openLoadDialog();
    });

    if (ui.btnLoadUserBlocks) {
      ui.btnLoadUserBlocks.addEventListener("click", () => {
        void loadWorkspaceBlocksFromFile();
      });
    }

    ui.btnClear.addEventListener("click", () => {
      state.workspace.clear();
      setProgramStatus("Workspace cleared");
    });

    ui.motorsEnabled.addEventListener("change", async (event) => {
      const enabled = Boolean(event.target && event.target.checked);
      await setMotorsEnabled(enabled, { sendCommand: true, showStatus: true });
    });

    if (ui.indexConsoleToggle && ui.indexConsolePanel) {
      ui.indexConsoleToggle.addEventListener("click", () => {
        const expanded = ui.indexConsoleToggle.getAttribute("aria-expanded") === "true";
        setIndexConsoleExpanded(!expanded);
      });
      setIndexConsoleExpanded(true, { force: true });
    }

    if (ui.teachModeEnabled) {
      ui.teachModeEnabled.addEventListener("change", (event) => {
        const enabled = Boolean(event.target && event.target.checked);
        setTeachModeEnabled(enabled);
      });
    }

    if (ui.btnTeachStart) {
      ui.btnTeachStart.addEventListener("click", () => {
        startTeachSession();
      });
    }

    if (ui.btnTeachPause) {
      ui.btnTeachPause.addEventListener("click", () => {
        pauseTeachSession();
      });
    }

    if (ui.btnTeachResume) {
      ui.btnTeachResume.addEventListener("click", () => {
        resumeTeachSession();
      });
    }

    if (ui.btnTeachStop) {
      ui.btnTeachStop.addEventListener("click", () => {
        stopTeachSession();
      });
    }

    if (ui.btnTeachDiscard) {
      ui.btnTeachDiscard.addEventListener("click", () => {
        discardTeachSession();
      });
    }

    if (ui.btnTeachSave) {
      ui.btnTeachSave.addEventListener("click", () => {
        saveTeachSession();
      });
    }

    if (ui.btnTeachReplay) {
      ui.btnTeachReplay.addEventListener("click", () => {
        void replayTeachSession();
      });
    }

    ui.btnConsoleCopy.addEventListener("click", async () => {
      const text = state.serialConsoleLines.join("\n");
      try {
        await navigator.clipboard.writeText(text);
        setProgramStatus("Serial console copied");
      } catch (error) {
        setProgramStatus("Copy failed (clipboard permission)");
      }
    });

    ui.btnConsoleClear.addEventListener("click", () => {
      state.serialConsoleLines = [];
      if (ui.serialConsoleLog) {
        ui.serialConsoleLog.textContent = "";
      }
      setProgramStatus("Serial console cleared");
    });

    if (ui.btnDebugClear) {
      ui.btnDebugClear.addEventListener("click", () => {
        state.debugConsoleLines = [];
        if (ui.debugConsoleLog) {
          ui.debugConsoleLog.textContent = "";
        }
        setProgramStatus("Debug console cleared");
      });
    }

    if (ui.debugTelemetryToggle) {
      ui.debugTelemetryToggle.addEventListener("click", () => {
        setDebugTelemetryExpanded(!state.debugTelemetryExpanded);
      });
    }

    if (ui.saveDialogOk && ui.saveName && ui.saveDialog) {
      ui.saveDialogOk.addEventListener("click", () => {
        const name = ui.saveName.value.trim();
        if (!name) {
          setProgramStatus("Enter a program name");
          ui.saveName.focus();
          return;
        }

        try {
          const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(state.workspace));
          state.storage.saveProgram(name, xml, { source: "blockly", robotId: activeRobotId() });
          ui.saveDialog.close();
          ui.saveName.value = "";
          renderProgramList();
          setProgramStatus(`Saved: ${name}`);
        } catch (error) {
          setProgramStatus(`Save failed: ${error.message}`);
        }
      });
    }

    if (ui.saveDialogCancel && ui.saveDialog) {
      ui.saveDialogCancel.addEventListener("click", () => ui.saveDialog.close());
    }
    if (ui.loadDialogCancel && ui.loadDialog) {
      ui.loadDialogCancel.addEventListener("click", () => ui.loadDialog.close());
    }

    if (ui.scriptDialogCopy && ui.scriptDialogText) {
      ui.scriptDialogCopy.addEventListener("click", async () => {
        const text = ui.scriptDialogText.value || "";
        try {
          await navigator.clipboard.writeText(text);
          setProgramStatus("Script copied");
        } catch (error) {
          setProgramStatus("Copy failed (clipboard permission)");
        }
      });
    }

    if (ui.scriptDialogClose && ui.scriptDialog) {
      ui.scriptDialogClose.addEventListener("click", () => {
        ui.scriptDialog.close();
      });
    }
  }

  function wireSliders() {
    const sliders = document.querySelectorAll(".servo-slider");

    sliders.forEach((slider) => {
      if (slider.dataset.sliderWired === "true") {
        return;
      }
      slider.dataset.sliderWired = "true";
      const servo = Number.parseInt(slider.dataset.servo, 10);
      const jointId = slider.dataset.joint || String(servo);

      slider.addEventListener("pointerdown", (event) => {
        if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
          showProgramLockHint();
          return;
        }
        if (event && Number.isFinite(event.pointerId) && slider.setPointerCapture) {
          try {
            slider.setPointerCapture(event.pointerId);
          } catch (error) {
            // Some browser range controls decline pointer capture; release commits still use change/pointerup.
          }
        }
        state.manualControl.pointerActive = true;
        startManualSession(servo);
      });

      slider.addEventListener("input", (event) => {
        if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
          showProgramLockHint();
          return;
        }

        const token = startManualSession(servo);
        cancelPendingManualSendsExcept(servo);
        const target = event.target;
        const angle = quantizeJointValue(servo, clampAngle(servo, Number.parseFloat(target.value)));
        target.value = String(angle);
        state.angles[servo] = angle;
        updateSliderValue(servo, angle);
        updateSliderFill(target);
        syncActivePreviewFromAngles();
        updateMotorDebugUi();
        scheduleTeachDragCapture();

        if (!isArduinoActive()) {
          if (activeRobotId() === "so101_follower" && NS.RobotRuntime && NS.RobotRuntime.isBridgeArmed && NS.RobotRuntime.isBridgeArmed()) {
            queueBridgeManualTarget(servo, jointId, angle, false);
            setProgramStatus(`Live target: ${getServoName(servo)} ${formatNumericReadout(angle)}`);
          } else {
            if (activeRobotId() === "so101_follower") {
              showArmMotionRequiredHint();
            } else {
              setProgramStatus("Preview updated.");
            }
          }
        } else if (state.serial.isConnected() && !state.runner.isRunning() && state.motorsEnabled) {
          scheduleManualSend(servo, angle, token);
        }

        if (!state.manualControl.pointerActive && !state.manualControl.keyboardActive) {
          scheduleManualSessionRelease(1000);
        }
      });

      slider.addEventListener("change", (event) => {
        if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
          showProgramLockHint();
          return;
        }
        state.manualControl.pointerActive = false;
        state.manualControl.keyboardActive = false;

        if (!isArduinoActive()) {
          commitManualSliderTarget(event.target, servo, jointId);
          return;
        }

        if (!state.serial.isConnected() || state.runner.isRunning()) {
          scheduleManualSessionRelease();
          return;
        }

        if (!ensureMotionAllowed()) {
          scheduleManualSessionRelease();
          return;
        }

        const token = startManualSession(servo);
        cancelPendingManualSendsExcept(servo);
        cancelPendingManualSend(servo);
        const target = event.target;
        const angle = clampAngle(servo, Number.parseInt(target.value, 10));
        state.angles[servo] = angle;
        updateSliderValue(servo, angle);
        updateSliderFill(target);
        syncActivePreviewFromAngles();
        updateMotorDebugUi();
        captureTeachReleaseKeyframe();
        const servoName = getServoName(servo);
        setProgramStatus(`Sending manual move: ${servoName} ${angle} deg`);
        scheduleManualSend(servo, angle, token, { debounceMs: 0, showStatus: true });
        scheduleManualSessionRelease();
      });

      slider.addEventListener("blur", () => {
        const interrupted = state.manualControl.pointerActive || state.manualControl.keyboardActive;
        state.manualControl.pointerActive = false;
        state.manualControl.keyboardActive = false;
        if (interrupted && activeRobotId() === "so101_follower") {
          void clearManualSessionState("focus_lost");
          setProgramStatus("Live control cancelled because the slider lost focus.");
          return;
        }
        scheduleManualSessionRelease();
      });

      slider.addEventListener("pointerup", (event) => {
        state.manualControl.pointerActive = false;
        if (isArduinoActive()) {
          return;
        }
        commitManualSliderTarget(event.currentTarget, servo, jointId);
      });

      slider.addEventListener("pointercancel", () => {
        if (!state.manualControl.pointerActive) {
          return;
        }
        state.manualControl.pointerActive = false;
        if (isArduinoActive()) {
          scheduleManualSessionRelease();
          return;
        }
        void clearManualSessionState("pointer_cancelled");
        setProgramStatus("Live control cancelled after an interrupted pointer gesture.");
      });

      slider.addEventListener("keyup", (event) => {
        if (isArduinoActive()) {
          return;
        }
        const commitKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter", " "];
        if (commitKeys.includes(event.key)) {
          state.manualControl.keyboardActive = false;
          commitManualSliderTarget(event.currentTarget, servo, jointId);
        }
      });

      slider.addEventListener("keydown", (event) => {
        if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
          showProgramLockHint();
          return;
        }
        const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
        if (!keys.includes(event.key)) {
          return;
        }
        state.manualControl.keyboardActive = true;
        event.preventDefault();
        const limits = getManualSliderLimits(servo);
        const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
        const increment = event.shiftKey ? 5 : 1;
        let next = Number.parseFloat(event.currentTarget.value);
        if (event.key === "Home") {
          next = limits[0];
        } else if (event.key === "End") {
          next = limits[1];
        } else {
          next += direction * increment;
        }
        next = quantizeJointValue(servo, clampAngle(servo, next));
        event.currentTarget.value = String(next);
        event.currentTarget.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });

    if (document.documentElement.dataset.manualVisibilityWired !== "true") {
      document.documentElement.dataset.manualVisibilityWired = "true";
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || activeRobotId() !== "so101_follower") {
          return;
        }
        const interactionActive = state.manualControl.activeServo !== null || state.manualControl.streamPending || state.manualControl.streamInFlight;
        if (interactionActive) {
          void clearManualSessionState("page_hidden");
        }
      });
    }
  }

  function commitManualSliderTarget(target, servo, jointId) {
    if (!target) {
      scheduleManualSessionRelease();
      return;
    }
    if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
      showProgramLockHint();
      return;
    }

    startManualSession(servo);
    cancelPendingManualSendsExcept(servo);
    const angle = quantizeJointValue(servo, clampAngle(servo, Number.parseFloat(target.value)));
    state.angles[servo] = angle;
    target.value = String(angle);
    updateSliderValue(servo, angle);
    updateSliderFill(target);
    syncActivePreviewFromAngles();
    updateMotorDebugUi();

    const robotId = activeRobotId();
    const commandJointId = jointId || target.dataset.joint || String(servo);
    const historyKey = `${robotId}:${commandJointId}`;
    const commitKey = `${historyKey}:${angle}`;
    const now = Date.now();
    const lastCommit = state.manualSliderCommitHistory.get(historyKey);
    if (lastCommit && lastCommit.key === commitKey && now - lastCommit.at < MANUAL_SLIDER_COMMIT_DEDUPE_MS) {
      scheduleManualSessionRelease();
      return;
    }
    state.manualSliderCommitHistory.set(historyKey, { key: commitKey, at: now });

    captureTeachReleaseKeyframe();
    if (robotId === "so101_follower") {
      if (NS.RobotRuntime && NS.RobotRuntime.isBridgeArmed && NS.RobotRuntime.isBridgeArmed()) {
        setProgramStatus(`Final live target: ${getServoName(servo)} ${formatNumericReadout(angle)}`);
        queueBridgeManualTarget(servo, commandJointId, angle, true);
      } else {
        showArmMotionRequiredHint();
      }
      scheduleManualSessionRelease();
      return;
    }
    setProgramStatus(robotId === "so101_follower"
      ? `Sending SO-101 target: ${getServoName(servo)} ${formatNumericReadout(angle)}`
      : `${activeManifest().shortName || activeManifest().name}: ${getServoName(servo)} ${formatNumericReadout(angle)}`);
    void applyManualRobotCommand({ type: "move_joint", robotId, joint: commandJointId, value: angle, speed: MANUAL_SEND_SPEED })
      .finally(() => {
        scheduleManualSessionRelease();
      });
  }

  function quantizeJointValue(servo, value) {
    const runtimeState = NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    const joint = activeJoints()[servo];
    const limit = runtimeState && runtimeState.jointLimits && joint ? runtimeState.jointLimits[joint.id] : null;
    const step = Number(limit && limit.step);
    const min = Number(limit && limit.min);
    if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(min)) {
      return Math.round(clampManualSliderValue(servo, value) * 10) / 10;
    }
    const quantized = min + Math.round((Number(value) - min) / step) * step;
    return Math.round(clampManualSliderValue(servo, quantized) * 10000) / 10000;
  }

  function queueBridgeManualTarget(servo, jointId, value, final) {
    if (!NS.RobotRuntime || typeof NS.RobotRuntime.sendManualTarget !== "function") {
      return;
    }
    if (!state.manualControl.streamSessionId) {
      state.manualControl.streamSessionId = `manual-${Date.now()}-${state.manualControl.sessionToken}`;
      state.manualControl.streamSequence = 0;
    }
    state.manualControl.streamSequence += 1;
    state.manualControl.streamPending = {
      sessionId: state.manualControl.streamSessionId,
      sequence: state.manualControl.streamSequence,
      joint: jointId || String(servo),
      value,
      final: Boolean(final),
      servo
    };
    pumpBridgeManualTargets();
  }

  function pumpBridgeManualTargets() {
    clearTimeout(state.manualControl.streamTimer);
    state.manualControl.streamTimer = null;
    if (state.manualControl.streamInFlight || !state.manualControl.streamPending) {
      return;
    }
    const pending = state.manualControl.streamPending;
    const elapsed = performance.now() - state.manualControl.streamLastSentAt;
    const delay = pending.final ? 0 : Math.max(0, (1000 / 30) - elapsed);
    if (delay > 0) {
      state.manualControl.streamTimer = window.setTimeout(pumpBridgeManualTargets, delay);
      return;
    }
    state.manualControl.streamPending = null;
    state.manualControl.streamInFlight = true;
    state.manualControl.streamLastSentAt = performance.now();
    const { servo, ...payload } = pending;
    void NS.RobotRuntime.sendManualTarget(payload)
      .then((runtimeState) => {
        updateManualControlTelemetry(runtimeState);
      })
      .catch((error) => {
        if (error && error.code === "BRIDGE_OFFLINE") {
          blockSo101BridgeCommands(
            "Bridge connection lost during live control. Hardware commands are blocked; test the bridge before reconnecting.",
            { lastError: error.message || "Bridge connection unavailable." }
          );
        } else {
          setBridgeStatus(`Live control stopped: ${error.message}`, "error");
          setProgramStatus(`Live control stopped: ${error.message}`);
        }
        state.manualControl.streamPending = null;
      })
      .finally(() => {
        state.manualControl.streamInFlight = false;
        if (state.manualControl.streamPending) {
          pumpBridgeManualTargets();
        }
      });
  }

  function scheduleBlocklyResize() {
    if (!state.workspace) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (!state.workspace) {
        return;
      }
      Blockly.svgResize(state.workspace);

      window.setTimeout(() => {
        if (!state.workspace) {
          return;
        }
        Blockly.svgResize(state.workspace);
      }, 120);
    });
  }

  function wireKeyboardShortcuts() {
    document.addEventListener("keydown", async (event) => {
      const key = String(event.key || "").toLowerCase();
      const hasCommandModifier = event.ctrlKey || event.metaKey;
      const isTyping = isTypingTarget(event.target);

      if (event.key === "Escape") {
        if (event.repeat) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (event.robobuddyEmergencyStopHandled) {
          return;
        }
        event.robobuddyEmergencyStopHandled = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        void triggerEmergencyStop("keyboard");
        return;
      }

      if (hasOpenDialog()) {
        return;
      }

      if (hasCommandModifier && !event.altKey && !event.shiftKey && key === "b" && !isTyping) {
        event.preventDefault();
        await handleConnectToggle();
        return;
      }

      if (hasCommandModifier && !event.altKey && !event.shiftKey && key === "h" && !isTyping) {
        event.preventDefault();
        if (!ensureMotionAllowed()) {
          return;
        }
        ui.btnHome.click();
        return;
      }

      if (hasCommandModifier && !event.altKey && !event.shiftKey && key === "s" && !isTyping) {
        event.preventDefault();
        if (usesBlockFileWorkflow()) {
          await saveWorkspaceBlocksToFile();
        } else {
          openSaveDialog();
        }
        return;
      }

      if (!isTyping && !event.ctrlKey && !event.metaKey && !event.altKey && key === "p") {
        if (!state.runner.isRunning()) {
          return;
        }
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        await handleProgramPauseResume();
        return;
      }

      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Space" && !isTyping) {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        if (state.runner.isRunning()) {
          await handleProgramStop();
          return;
        }
        if (ui.btnRun && ui.btnRun.disabled) {
          return;
        }
        if (!state.runner.isRunning()) {
          await runProgram();
        }
      }
    }, { capture: true });
  }

  async function handleConnectToggle() {
    if (!isArduinoActive()) {
      const manifest = activeManifest();
      if (manifest && manifest.id === "so101_follower") {
        openWorkbenchDrawer("bridge", { focus: true });
        setProgramStatus("Local bridge setup opened. Test the bridge before selecting a port or arming motion.");
        window.requestAnimationFrame(() => {
          const target = state.bridgeUi.tested ? ui.bridgePortSelect : ui.btnBridgeHealth;
          if (target && !target.disabled) target.focus();
        });
      } else {
        setProgramStatus("LeKiwi is simulation-only in Tier 1.");
      }
      return;
    }

    if (state.serial.isConnected()) {
      const transportLabel = getConnectionTransportLabel();
      let parked = false;
      try {
        parked = await parkBeforeDisconnect();
      } catch (parkError) {
        appendSerialConsole("SYS", `Safe park before disconnect failed: ${parkError.message}`);
      }

      try {
        await state.serial.disconnect();
        setProgramStatus(parked ? `${transportLabel} disconnected (parked pose applied)` : `${transportLabel} disconnected`);
      } catch (error) {
        setProgramStatus(`Disconnect failed: ${error.message}`);
      }
      return;
    }

    ui.statusDot.classList.add("is-connecting");
    ui.statusText.textContent = "Connecting serial device...";

    try {
      setProgramStatus("Requesting serial port (USB/Bluetooth)...");
      await state.serial.connect();
      const transportLabel = getConnectionTransportLabel();
      setProgramStatus(`${transportLabel} connected. Waiting for READY...`);

      try {
        await state.serial.waitForReady(3000);
        setProgramStatus("Device READY received");
      } catch (readyError) {
        setProgramStatus("Connected, but READY not received within 3s");
      }

      await state.serial.attachAll();
      const profileOk = await ensureFirmwareProfileCompatible("connect-profile");
      if (!profileOk) {
        return;
      }

      let synced = false;
      try {
        const positions = await state.serial.queryPositions();
        if (Array.isArray(positions)) {
          synced = await processDevicePositions(positions, "connect-query");
        }
      } catch (queryError) {
        appendSerialConsole("SYS", `Position sync failed: ${queryError.message}`);
      }

      if (!state.motorsEnabled) {
        await state.serial.emergencyStop();
        setProgramStatus(synced ? `${transportLabel} connected (motors disabled)` : `${transportLabel} connected; motors disabled`);
      } else {
        setProgramStatus(synced ? `${transportLabel} connected and synchronized` : `${transportLabel} connected`);
      }

      if (state.pendingDefaultReset) {
        appendSerialConsole("SYS", "Applying queued default reset");
        await handleResetToDefaultPosition({ forceRedrive: true });
      }
    } catch (error) {
      setProgramStatus(`Connect failed: ${error.message}`);
      ui.statusDot.classList.remove("is-connecting");
    }
  }

  async function parkBeforeDisconnect() {
    if (!state.serial || !state.serial.isConnected()) {
      return false;
    }

    if ((state.runner && state.runner.isRunning()) || state.programStopInProgress || state.controlOwner === CONTROL_OWNER.PROGRAM) {
      appendSerialConsole("SYS", "Skipping safe park before disconnect: program control is active");
      return false;
    }

    if (state.teach && state.teach.phase === TEACH_PHASE.REPLAYING) {
      appendSerialConsole("SYS", "Skipping safe park before disconnect: teach replay is active");
      return false;
    }

    if (!state.motorsEnabled) {
      appendSerialConsole("SYS", "Skipping safe park before disconnect: motors disabled");
      return false;
    }

    if (isMotionBlockedByFirmwareMismatch(false)) {
      appendSerialConsole("SYS", "Skipping safe park before disconnect: firmware mismatch active");
      return false;
    }

    clearPendingManualSends();
    clearManualSessionState();
    const targets = DISCONNECT_PARK_ANGLES.slice();

    try {
      setProgramStatus("Moving to safe park pose before disconnect...");
      await state.serial.attachAll();
      for (let servo = 0; servo < targets.length; servo += 1) {
        const angle = clampAngle(servo, targets[servo]);
        await state.serial.moveServo(servo, angle, DISCONNECT_PARK_SPEED);
      }
      applyAngles(targets, { syncSliders: true, source: "disconnect-park" });
      appendSerialConsole("SYS", "Safe park pose reached");
      return true;
    } catch (error) {
      appendSerialConsole("SYS", `Safe park before disconnect failed: ${error.message}`);
      return false;
    }
  }

  async function runProgram() {
    if (state.controlOwner === CONTROL_OWNER.PROGRAM || state.runner.isRunning()) {
      setProgramStatus("Program already running");
      updateProgramControlUi();
      return false;
    }

    if (state.programStopInProgress) {
      setProgramStatus("Program stop in progress. Please wait.");
      setProgramControlHint("Stop command in progress. Try Run again shortly.", "warning");
      updateProgramControlUi();
      return false;
    }

    state.programLastError = "";
    setProgramStatus("Preparing program run...");
    setProgramControlHint("Preparing run...", "active");

    let commands = [];
    try {
      const generated = NS.Generator.generateCommands(state.workspace);
      commands = Array.isArray(generated) ? generated : [];
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setProgramStatus(`Could not prepare program: ${message}`);
      setProgramControlHint("Program contains invalid blocks. Fix and retry.", "error");
      return false;
    }

    if (commands.length === 0) {
      setProgramStatus("No blocks to run");
      setProgramControlHint("Add at least one block before running.", "warning");
      return false;
    }

    if (isArduinoActive() && state.serial.isConnected() && !ensureMotionAllowed()) {
      updateProgramControlUi();
      return false;
    }

    clearPendingManualSends();
    await clearManualSessionState();
    setProgramStatus(`Starting program (${commands.length} steps)...`);
    setProgramControlHint("Starting program...", "active");

    try {
      await state.runner.run(commands, state.workspace);
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setProgramStatus(`Run failed: ${message}`);
      setProgramControlHint("Run failed before start. Check console/device state.", "error");
      return false;
    }
  }

  async function handleProgramPauseResume() {
    if (!state.runner || !state.runner.isRunning() || state.programStopInProgress) {
      return;
    }

    const paused = typeof state.runner.isPaused === "function" ? state.runner.isPaused() : false;
    if (paused) {
      setProgramStatus("Resuming program...");
      setProgramControlHint("Resuming program...", "active");
      await state.runner.resume();
    } else {
      setProgramStatus("Pausing program...");
      setProgramControlHint("Pausing program...", "warning");
      await state.runner.pause();
    }
    updateProgramControlUi();
  }

  async function handleProgramStop() {
    if (!state.runner.isRunning() || state.programStopInProgress) {
      return;
    }

    state.programStopInProgress = true;
    setProgramStatus("Stopping program...");
    updateProgramControlUi();

    try {
      await state.runner.stop({ mode: "immediate" });
      if (!isArduinoActive() && activeRobotId() === "so101_follower" && NS.RobotRuntime && NS.RobotRuntime.stopHardware) {
        await NS.RobotRuntime.stopHardware();
        applyAngles(NS.RobotRuntime.getJointArray(), { syncSliders: true, source: "program-stop" });
        syncBridgeUx();
      }
      await waitForRunnerIdle(1800);

      if (!state.serial.isConnected()) {
        state.programLastError = "";
        setProgramStatus("Program stopped");
        return;
      }

      if (!state.motorsEnabled) {
        state.programLastError = "";
        setProgramStatus("Program stopped");
        return;
      }

      await state.serial.attachAll();
      const profileOk = await ensureFirmwareProfileCompatible("post-stop-profile");
      if (!profileOk) {
        return;
      }

      let synced = false;
      try {
        const positions = await state.serial.queryPositions();
        if (Array.isArray(positions)) {
          synced = await processDevicePositions(positions, "post-stop-query");
        }
      } catch (error) {
        appendSerialConsole("SYS", `Stop sync failed: ${error.message}`);
      }

      if (state.firmwareMismatch) {
        return;
      }

      setProgramStatus(
        synced
          ? "Program stopped; motors reattached"
          : "Program stopped; motors reattached (position sync pending)"
      );
      state.programLastError = "";
    } catch (error) {
      setProgramStatus(`Stop failed: ${error.message}`);
    } finally {
      state.programStopInProgress = false;
      updateProgramControlUi();
    }
  }

  async function handleResetToDefaultPosition(options = {}) {
    const forceRedrive = options.forceRedrive === true;

    if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
      showProgramLockHint();
      return;
    }

    if (!isArduinoActive()) {
      if (NS.RobotRuntime) {
        NS.RobotRuntime.home();
        applyAngles(NS.RobotRuntime.getJointArray(), { syncSliders: true, source: "default-reset" });
      }
      setProgramStatus(`${activeManifest().shortName || activeManifest().name} reset to home pose`);
      return;
    }

    if (!state.serial.isConnected()) {
      applyAngles(DEFAULT_RESET_ANGLES, { syncSliders: true, source: "default-reset-queued" });
      state.pendingDefaultReset = true;
      setProgramStatus("Default reset queued. Connect to apply on hardware.");
      return;
    }

    state.pendingDefaultReset = false;
    if (isMotionBlockedByFirmwareMismatch(true)) {
      return;
    }

    clearPendingManualSends();
    clearManualSessionState();

    const targets = DEFAULT_RESET_ANGLES.slice();
    try {
      setProgramStatus("Resetting to default position...");
      if (state.serial.isConnected()) {
        if (!state.motorsEnabled) {
          setProgramStatus("Enabling motors for default reset...");
          await setMotorsEnabled(true, { sendCommand: true, showStatus: false });
          if (!state.motorsEnabled) {
            setProgramStatus("Default reset blocked: motors could not be enabled");
            return;
          }
        } else {
          await state.serial.attachAll();
        }

        for (let servo = 0; servo < targets.length; servo += 1) {
          const angle = clampAngle(servo, targets[servo]);
          if (forceRedrive) {
            const nudge = clampAngle(servo, angle + DEFAULT_RESET_NUDGE_DEG);
            if (nudge !== angle) {
              await state.serial.moveServo(servo, nudge, DEFAULT_RESET_SPEED);
            }
          }
          await state.serial.moveServo(servo, angle, DEFAULT_RESET_SPEED);
        }
      }

      applyAngles(targets, { syncSliders: true, source: "default-reset" });
      setProgramStatus("Moved to default position (90 deg)");
    } catch (error) {
      setProgramStatus(`Default reset failed: ${error.message}`);
    }
  }

  function buildTeachSession() {
    const startedAtMs = Date.now();
    const sessionId = `teach-${state.teach.nextSessionId}`;
    state.teach.nextSessionId += 1;
    return {
      id: sessionId,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: null,
      startedAtMs,
      frames: []
    };
  }

  function cloneTeachFrame(frame) {
    return {
      tMs: frame.tMs,
      angles: frame.angles.slice(),
      source: frame.source,
      speedHint: frame.speedHint,
      easingHint: frame.easingHint
    };
  }

  function anglesEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  function normalizeTeachFrames(frames) {
    const prepared = (Array.isArray(frames) ? frames : [])
      .map((frame, index) => {
        if (!frame || !Array.isArray(frame.angles)) {
          return null;
        }

        const rawT = Number.isFinite(frame.tMs) ? Number(frame.tMs) : 0;
        const safeAngles = [];
        for (let servo = 0; servo < 6; servo += 1) {
          const rawAngle = Number(frame.angles[servo]);
          const fallback = HOME_ANGLES[servo];
          const value = Number.isFinite(rawAngle) ? rawAngle : fallback;
          safeAngles.push(clampAngle(servo, value));
        }
        return {
          idx: index,
          tMs: Math.max(0, Math.round(rawT)),
          angles: safeAngles,
          source: typeof frame.source === "string" && frame.source ? frame.source : "unknown",
          speedHint: Number.isFinite(frame.speedHint) ? Math.min(100, Math.max(1, Number(frame.speedHint))) : null,
          easingHint: typeof frame.easingHint === "string" ? frame.easingHint : null
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.tMs === b.tMs ? a.idx - b.idx : a.tMs - b.tMs));

    if (prepared.length === 0) {
      return {
        frames: [],
        droppedDuplicates: 0,
        durationMs: 0
      };
    }

    const baseT = prepared[0].tMs;
    const normalized = [];
    let droppedDuplicates = 0;

    for (const frame of prepared) {
      const normalizedT = Math.max(0, frame.tMs - baseT);
      let targetT = normalizedT;

      if (normalized.length > 0) {
        const previous = normalized[normalized.length - 1];
        if (anglesEqual(previous.angles, frame.angles)) {
          droppedDuplicates += 1;
          continue;
        }
        targetT = Math.max(targetT, previous.tMs + TEACH_IR_MIN_STEP_MS);
      } else {
        targetT = 0;
      }

      const previous = normalized.length > 0 ? normalized[normalized.length - 1] : null;
      normalized.push({
        tMs: targetT,
        dtMs: previous ? targetT - previous.tMs : 0,
        angles: frame.angles,
        source: frame.source,
        speedHint: frame.speedHint,
        easingHint: frame.easingHint
      });
    }

    const durationMs = normalized.length > 0 ? normalized[normalized.length - 1].tMs : 0;
    return {
      frames: normalized,
      droppedDuplicates,
      durationMs
    };
  }

  function buildTeachMotionIr(session) {
    const normalized = normalizeTeachFrames(session ? session.frames : []);
    const irFrames = normalized.frames.map((frame, index) => ({
      index,
      tMs: frame.tMs,
      dtMs: frame.dtMs,
      angles: frame.angles.slice(),
      source: frame.source,
      speedHint: frame.speedHint,
      easingHint: frame.easingHint
    }));

    return {
      schema: "motion-ir.v1",
      source: "teach",
      sessionId: session && session.id ? session.id : "teach-session",
      generatedAt: new Date().toISOString(),
      durationMs: normalized.durationMs,
      minStepMs: TEACH_IR_MIN_STEP_MS,
      inputFrameCount: Array.isArray(session && session.frames) ? session.frames.length : 0,
      outputFrameCount: irFrames.length,
      droppedDuplicateFrames: normalized.droppedDuplicates,
      frames: irFrames
    };
  }

  function createBlocklyFieldBlock(doc, type, fields) {
    const block = doc.createElement("block");
    block.setAttribute("type", type);
    for (const [name, value] of Object.entries(fields)) {
      const field = doc.createElement("field");
      field.setAttribute("name", name);
      field.textContent = String(value);
      block.appendChild(field);
    }
    return block;
  }

  function formatWaitSeconds(seconds) {
    const rounded = Math.round(seconds * 100) / 100;
    return rounded.toFixed(2).replace(/\.?0+$/, "");
  }

  function buildTeachBlocklyXml(motionIr) {
    const frames = Array.isArray(motionIr && motionIr.frames) ? motionIr.frames : [];
    const doc = document.implementation.createDocument("https://developers.google.com/blockly/xml", "xml", null);
    const xmlRoot = doc.documentElement;

    let headBlock = null;
    let tailBlock = null;
    const appendBlock = (block) => {
      if (!headBlock) {
        block.setAttribute("x", "20");
        block.setAttribute("y", "24");
        xmlRoot.appendChild(block);
        headBlock = block;
        tailBlock = block;
        return;
      }

      const next = doc.createElement("next");
      next.appendChild(block);
      tailBlock.appendChild(next);
      tailBlock = block;
    };

    const appendWaitBlocks = (deltaMs) => {
      let remainingMs = Math.max(0, Math.round(Number(deltaMs) || 0));
      while (remainingMs > 0) {
        const chunkMs = Math.min(10000, remainingMs);
        const seconds = Math.max(0.1, chunkMs / 1000);
        appendBlock(createBlocklyFieldBlock(doc, "wait_seconds", {
          SECONDS: formatWaitSeconds(seconds)
        }));
        remainingMs -= chunkMs;
      }
    };

    let pendingWaitMs = 0;
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index] || {};
      if (index > 0) {
        pendingWaitMs += Math.max(0, Math.round(Number(frame.dtMs) || 0));
        if (pendingWaitMs >= 100) {
          appendWaitBlocks(pendingWaitMs);
          pendingWaitMs = 0;
        }
      }

      const safeAngles = [];
      for (let servo = 0; servo < 6; servo += 1) {
        const raw = Number(frame.angles && frame.angles[servo]);
        const fallback = HOME_ANGLES[servo];
        const value = Number.isFinite(raw) ? raw : fallback;
        safeAngles.push(clampAngle(servo, value));
      }
      const speed = Number.isFinite(frame.speedHint)
        ? Math.min(100, Math.max(1, Math.round(Number(frame.speedHint))))
        : MANUAL_SEND_SPEED;

      appendBlock(createBlocklyFieldBlock(doc, "move_arm", {
        A0: safeAngles[0],
        A1: safeAngles[1],
        A2: safeAngles[2],
        A3: safeAngles[3],
        A4: safeAngles[4],
        A5: safeAngles[5],
        SPEED: speed
      }));
    }

    return new XMLSerializer().serializeToString(xmlRoot);
  }

  function buildTeachScriptExport(session, motionIr) {
    const ir = motionIr && typeof motionIr === "object" ? motionIr : buildTeachMotionIr(session);
    const frames = Array.isArray(ir.frames) ? ir.frames : [];
    const lines = [];
    lines.push("// RoboBuddy teach export");
    lines.push("const teachMotion = {");
    lines.push(`  schema: ${JSON.stringify(TEACH_SCRIPT_SCHEMA)},`);
    lines.push(`  motionIrSchema: ${JSON.stringify(ir.schema || "motion-ir.v1")},`);
    lines.push(`  source: "teach",`);
    lines.push(`  sessionId: ${JSON.stringify(session && session.id ? session.id : "teach-session")},`);
    lines.push(`  generatedAt: ${JSON.stringify(ir.generatedAt || new Date().toISOString())},`);
    lines.push(`  durationMs: ${Math.max(0, Math.round(Number(ir.durationMs) || 0))},`);
    lines.push("  keyframes: [");
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index] || {};
      const safeAngles = [];
      for (let servo = 0; servo < 6; servo += 1) {
        const raw = Number(frame.angles && frame.angles[servo]);
        const fallback = HOME_ANGLES[servo];
        const value = Number.isFinite(raw) ? raw : fallback;
        safeAngles.push(clampAngle(servo, value));
      }
      const speed = Number.isFinite(frame.speedHint)
        ? Math.min(100, Math.max(1, Math.round(Number(frame.speedHint))))
        : MANUAL_SEND_SPEED;
      const easing = typeof frame.easingHint === "string" && frame.easingHint ? frame.easingHint : "linear";
      const comma = index < frames.length - 1 ? "," : "";
      lines.push(
        `    { tMs: ${Math.max(0, Math.round(Number(frame.tMs) || 0))}, ` +
        `dtMs: ${Math.max(0, Math.round(Number(frame.dtMs) || 0))}, ` +
        `angles: [${safeAngles.join(", ")}], speed: ${speed}, easing: ${JSON.stringify(easing)} }${comma}`
      );
    }
    lines.push("  ]");
    lines.push("};");
    lines.push("");
    lines.push("// Example replay loop:");
    lines.push("// for (const frame of teachMotion.keyframes) {");
    lines.push("//   await arm.moveArm(frame.angles, { speed: frame.speed, atMs: frame.tMs, easing: frame.easing });");
    lines.push("// }");
    return lines.join("\n");
  }

  function buildTeachProgramName(sessionId) {
    const rawSessionId = String(sessionId || "session").trim();
    const normalized = rawSessionId
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    const suffix = normalized || "session";
    const prefix = `${TEACH_PROGRAM_NAME_PREFIX} `;
    const maxSuffixLength = Math.max(1, MAX_PROGRAM_NAME_LENGTH - prefix.length);
    return `${prefix}${suffix.slice(0, maxSuffixLength)}`;
  }

  function buildUniqueProgramName(baseName) {
    const normalizedBase = String(baseName || "Program").trim().slice(0, MAX_PROGRAM_NAME_LENGTH) || "Program";
    let candidate = normalizedBase;
    let counter = 2;
    while (state.storage.getProgram(candidate)) {
      const suffix = ` (${counter})`;
      const maxBaseLength = Math.max(1, MAX_PROGRAM_NAME_LENGTH - suffix.length);
      candidate = `${normalizedBase.slice(0, maxBaseLength)}${suffix}`;
      counter += 1;
    }
    return candidate;
  }

  function exportTeachSessionProgram(session, motionIr) {
    const ir = motionIr && typeof motionIr === "object" ? motionIr : buildTeachMotionIr(session);
    const baseProgramName = buildTeachProgramName(session && session.id ? session.id : "session");
    const programName = buildUniqueProgramName(baseProgramName);
    const blockXml = buildTeachBlocklyXml(ir);
    const scriptText = buildTeachScriptExport(session, ir);
    const teachMeta = {
      id: session && session.id ? session.id : "teach-session",
      startedAt: session && session.startedAt ? session.startedAt : null,
      endedAt: session && session.endedAt ? session.endedAt : null,
      savedAt: session && session.savedAt ? session.savedAt : new Date().toISOString(),
      rawFrameCount: Array.isArray(session && session.frames) ? session.frames.length : 0,
      irFrameCount: Number.isFinite(ir.outputFrameCount) ? Number(ir.outputFrameCount) : 0,
      irDurationMs: Number.isFinite(ir.durationMs) ? Number(ir.durationMs) : 0
    };

    state.storage.saveProgram(programName, {
      blockXml,
      scriptText,
      motionIr: ir,
      teachMeta,
      robotId: "arduino_arm",
      source: "teach"
    });
    return programName;
  }

  function clearTeachCaptureTimer() {
    if (state.teach.captureTimer !== null) {
      clearTimeout(state.teach.captureTimer);
      state.teach.captureTimer = null;
    }
  }

  function scheduleTeachDragCapture() {
    if (!state.teach.enabled || state.teach.phase !== TEACH_PHASE.RECORDING || !state.teach.currentSession) {
      return;
    }

    clearTeachCaptureTimer();
    state.teach.captureTimer = window.setTimeout(() => {
      state.teach.captureTimer = null;
      const captured = recordTeachSnapshot("slider-drag", { thresholdDeg: TEACH_CAPTURE_THRESHOLD_DEG });
      if (captured) {
        updateTeachControlsUi();
      }
    }, TEACH_CAPTURE_DEBOUNCE_MS);
  }

  function captureTeachReleaseKeyframe() {
    if (!state.teach.enabled || state.teach.phase !== TEACH_PHASE.RECORDING || !state.teach.currentSession) {
      return;
    }

    clearTeachCaptureTimer();
    const captured = recordTeachSnapshot("slider-release", { force: true });
    if (captured) {
      updateTeachControlsUi();
    }
  }

  function recordTeachSnapshot(source, options = {}) {
    const session = state.teach.currentSession;
    if (!session) {
      return false;
    }

    const force = options.force === true;
    const thresholdDeg = Number.isFinite(options.thresholdDeg) ? Math.max(0, Number(options.thresholdDeg)) : 0;
    const now = Date.now();
    const startedAtMs = Number.isFinite(session.startedAtMs) ? session.startedAtMs : now;
    const tMs = Math.max(0, now - startedAtMs);
    const angles = state.angles.slice();
    const previous = session.frames.length > 0 ? session.frames[session.frames.length - 1] : null;
    if (previous) {
      const maxDelta = previous.angles.reduce((acc, value, index) => Math.max(acc, Math.abs(value - angles[index])), 0);
      const sameAsPrevious = maxDelta === 0;
      if (sameAsPrevious && source !== "stop" && !force) {
        return false;
      }
      if (!force && thresholdDeg > 0 && maxDelta < thresholdDeg) {
        return false;
      }
    }

    session.frames.push({
      tMs,
      angles,
      source,
      speedHint: null,
      easingHint: null
    });
    if (source !== "slider-drag") {
      appendDebugConsole(`Teach keyframe captured: ${source} @${tMs}ms`);
    }
    return true;
  }

  function setTeachStatus(text, tone = "ready") {
    if (!ui.teachStatusText) {
      return;
    }
    ui.teachStatusText.textContent = text;
    ui.teachStatusText.dataset.tone = tone;
  }

  function isTeachSessionActive() {
    return (
      state.teach.phase === TEACH_PHASE.RECORDING ||
      state.teach.phase === TEACH_PHASE.PAUSED ||
      state.teach.phase === TEACH_PHASE.REPLAYING
    );
  }

  function getReplayTeachSession() {
    if (state.teach.currentSession && state.teach.phase === TEACH_PHASE.STOPPED) {
      return state.teach.currentSession;
    }
    if (Array.isArray(state.teach.savedSessions) && state.teach.savedSessions.length > 0) {
      return state.teach.savedSessions[0];
    }
    return null;
  }

  function updateTeachControlsUi() {
    const locked = state.controlOwner === CONTROL_OWNER.PROGRAM;
    const enabled = Boolean(state.teach.enabled);
    const phase = state.teach.phase;
    const session = state.teach.currentSession;
    const hasSession = Boolean(session);
    const replaySession = getReplayTeachSession();
    const canStart = enabled && (phase === TEACH_PHASE.IDLE || (phase === TEACH_PHASE.STOPPED && !hasSession));
    const isReplaying = phase === TEACH_PHASE.REPLAYING;

    if (ui.teachControls) {
      ui.teachControls.classList.toggle("is-active", enabled || phase !== TEACH_PHASE.OFF);
    }

    if (ui.teachModeEnabled) {
      ui.teachModeEnabled.checked = enabled;
      ui.teachModeEnabled.disabled = locked;
    }
    if (ui.btnTeachStart) {
      ui.btnTeachStart.disabled = locked || !canStart;
    }
    if (ui.btnTeachPause) {
      ui.btnTeachPause.disabled = locked || phase !== TEACH_PHASE.RECORDING;
    }
    if (ui.btnTeachResume) {
      ui.btnTeachResume.disabled = locked || phase !== TEACH_PHASE.PAUSED;
    }
    if (ui.btnTeachStop) {
      ui.btnTeachStop.disabled = (locked && !isReplaying) || (phase !== TEACH_PHASE.RECORDING && phase !== TEACH_PHASE.PAUSED && phase !== TEACH_PHASE.REPLAYING);
    }
    if (ui.btnTeachDiscard) {
      ui.btnTeachDiscard.disabled = locked || !hasSession || isReplaying;
    }
    if (ui.btnTeachSave) {
      ui.btnTeachSave.disabled = locked || !hasSession || phase !== TEACH_PHASE.STOPPED || isReplaying;
    }
    if (ui.btnTeachReplay) {
      ui.btnTeachReplay.disabled = locked || !enabled || !replaySession || isReplaying;
    }

    if (locked && !isReplaying) {
      setTeachStatus("Teach controls are locked while a program is running.", "warning");
      return;
    }

    if (!enabled) {
      setTeachStatus("Teach mode off. Enable Teach Mode to begin.", "ready");
      return;
    }

    if (isReplaying) {
      setTeachStatus("Replaying teach session...", "active");
      return;
    }

    if (!hasSession) {
      setTeachStatus("Teach mode ready. Press Start to record a session.", "ready");
      return;
    }

    const frameCount = session.frames.length;
    switch (phase) {
      case TEACH_PHASE.RECORDING:
        setTeachStatus(`Recording teach session (${frameCount} keyframes).`, "active");
        break;
      case TEACH_PHASE.PAUSED:
        setTeachStatus(`Teach session paused (${frameCount} keyframes).`, "warning");
        break;
      case TEACH_PHASE.STOPPED:
        setTeachStatus(`Teach session stopped (${frameCount} keyframes). Save or discard.`, "warning");
        break;
      default:
        setTeachStatus("Teach mode ready. Press Start to record a session.", "ready");
        break;
    }
  }

  function setTeachModeEnabled(enabled) {
    const requested = Boolean(enabled);
    if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
      showProgramLockHint();
      updateTeachControlsUi();
      return;
    }

    if (state.teach.enabled === requested) {
      updateTeachControlsUi();
      return;
    }

    state.teach.enabled = requested;
    if (!state.teach.enabled) {
      clearTeachCaptureTimer();
      if (state.teach.phase === TEACH_PHASE.REPLAYING) {
        state.teach.replayStopRequested = true;
        setProgramStatus("Teach mode disabled. Stopping teach replay...");
      } else if (isTeachSessionActive()) {
        stopTeachSession({ silentStatus: true });
        setProgramStatus("Teach mode disabled. Active session stopped.");
      } else {
        setProgramStatus("Teach mode disabled");
      }
      state.teach.phase = state.teach.currentSession ? TEACH_PHASE.STOPPED : TEACH_PHASE.OFF;
    } else {
      state.teach.phase = state.teach.currentSession ? TEACH_PHASE.STOPPED : TEACH_PHASE.IDLE;
      if (state.teach.currentSession) {
        setProgramStatus("Teach mode enabled. Unsaved session available.");
      } else {
        setProgramStatus("Teach mode enabled. Press Start to record.");
      }
    }

    updateTeachControlsUi();
    updateProgramControlUi();
  }

  function startTeachSession() {
    if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
      showProgramLockHint();
      return;
    }

    if (!state.teach.enabled) {
      setProgramStatus("Enable Teach Mode before starting a teach session.");
      updateTeachControlsUi();
      return;
    }

    if (state.teach.phase === TEACH_PHASE.REPLAYING) {
      setProgramStatus("Teach replay is running. Stop replay before starting a new session.");
      updateTeachControlsUi();
      return;
    }

    if (isTeachSessionActive()) {
      setProgramStatus("Teach session is already recording.");
      updateTeachControlsUi();
      return;
    }

    if (state.teach.currentSession && state.teach.phase === TEACH_PHASE.STOPPED) {
      setProgramStatus("Save or discard the current teach session before starting a new one.");
      updateTeachControlsUi();
      return;
    }

    clearTeachCaptureTimer();
    state.teach.currentSession = buildTeachSession();
    state.teach.phase = TEACH_PHASE.RECORDING;
    recordTeachSnapshot("start");
    setProgramStatus("Teach recording started");
    appendDebugConsole(`Teach session started: ${state.teach.currentSession.id}`);
    updateTeachControlsUi();
    updateProgramControlUi();
  }

  function pauseTeachSession() {
    if (state.teach.phase !== TEACH_PHASE.RECORDING) {
      setProgramStatus("Teach pause unavailable. Start a teach session first.");
      updateTeachControlsUi();
      return;
    }

    state.teach.phase = TEACH_PHASE.PAUSED;
    recordTeachSnapshot("pause");
    setProgramStatus("Teach recording paused");
    updateTeachControlsUi();
    updateProgramControlUi();
  }

  function resumeTeachSession() {
    if (state.teach.phase !== TEACH_PHASE.PAUSED) {
      setProgramStatus("Teach resume unavailable. Pause a teach session first.");
      updateTeachControlsUi();
      return;
    }

    state.teach.phase = TEACH_PHASE.RECORDING;
    recordTeachSnapshot("resume");
    setProgramStatus("Teach recording resumed");
    updateTeachControlsUi();
    updateProgramControlUi();
  }

  function stopTeachSession(options = {}) {
    const silentStatus = options.silentStatus === true;
    if (state.teach.phase === TEACH_PHASE.REPLAYING) {
      state.teach.replayStopRequested = true;
      if (!silentStatus) {
        setProgramStatus("Stopping teach replay...");
      }
      updateTeachControlsUi();
      updateProgramControlUi();
      return;
    }

    if (state.teach.phase !== TEACH_PHASE.RECORDING && state.teach.phase !== TEACH_PHASE.PAUSED) {
      if (!silentStatus) {
        setProgramStatus("Teach stop unavailable. Start a teach session first.");
      }
      updateTeachControlsUi();
      return;
    }

    clearTeachCaptureTimer();
    recordTeachSnapshot("stop");
    if (state.teach.currentSession && !state.teach.currentSession.endedAt) {
      state.teach.currentSession.endedAt = new Date().toISOString();
    }
    state.teach.phase = TEACH_PHASE.STOPPED;
    if (!silentStatus) {
      const keyframes = state.teach.currentSession ? state.teach.currentSession.frames.length : 0;
      setProgramStatus(`Teach recording stopped (${keyframes} keyframes). Save or discard.`);
    }
    updateTeachControlsUi();
    updateProgramControlUi();
  }

  function discardTeachSession() {
    if (!state.teach.currentSession) {
      setProgramStatus("No teach session to discard.");
      updateTeachControlsUi();
      return;
    }

    clearTeachCaptureTimer();
    const discardedId = state.teach.currentSession.id;
    state.teach.currentSession = null;
    state.teach.phase = state.teach.enabled ? TEACH_PHASE.IDLE : TEACH_PHASE.OFF;
    setProgramStatus(`Teach session discarded: ${discardedId}`);
    appendDebugConsole(`Teach session discarded: ${discardedId}`);
    updateTeachControlsUi();
    updateProgramControlUi();
  }

  function saveTeachSession() {
    if (!state.teach.currentSession || state.teach.phase !== TEACH_PHASE.STOPPED) {
      setProgramStatus("Stop teach recording before saving.");
      updateTeachControlsUi();
      return;
    }

    clearTeachCaptureTimer();
    const session = state.teach.currentSession;
    const motionIr = buildTeachMotionIr(session);
    const savedSession = {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt || new Date().toISOString(),
      savedAt: new Date().toISOString(),
      frames: session.frames.map(cloneTeachFrame),
      motionIr
    };

    let exportedProgramName = "";
    let exportError = null;
    try {
      exportedProgramName = exportTeachSessionProgram(savedSession, motionIr);
      savedSession.exportProgramName = exportedProgramName;
    } catch (error) {
      exportError = error;
    }

    state.teach.savedSessions.unshift(savedSession);
    while (state.teach.savedSessions.length > 30) {
      state.teach.savedSessions.pop();
    }

    state.teach.currentSession = null;
    state.teach.phase = state.teach.enabled ? TEACH_PHASE.IDLE : TEACH_PHASE.OFF;
    const exportStatusSuffix = exportedProgramName
      ? ` | Exported: ${exportedProgramName}`
      : (exportError ? " | Export failed (see debug)" : "");
    setProgramStatus(
      `Teach session saved: ${savedSession.id} ` +
      `(${savedSession.frames.length} raw / ${motionIr.outputFrameCount} IR keyframes)` +
      exportStatusSuffix
    );

    if (exportError) {
      appendDebugConsole(`Teach export failed for ${savedSession.id}: ${exportError.message || exportError}`);
    }

    appendDebugConsole(
      `Teach session saved: ${savedSession.id} (` +
      `${savedSession.frames.length} raw, ${motionIr.outputFrameCount} IR, ` +
      `${motionIr.durationMs}ms, deduped ${motionIr.droppedDuplicateFrames}` +
      `${exportedProgramName ? `, exported ${exportedProgramName}` : ""}` +
      `${exportError ? ", export failed" : ""})`
    );
    if (ui.loadDialog && ui.loadDialog.open) {
      renderProgramList();
    }
    updateTeachControlsUi();
    updateProgramControlUi();
  }

  async function replayTeachSession() {
    if (state.controlOwner === CONTROL_OWNER.PROGRAM || state.runner.isRunning()) {
      showProgramLockHint();
      updateTeachControlsUi();
      return;
    }

    if (!state.teach.enabled) {
      setProgramStatus("Enable Teach Mode before replaying a teach session.");
      updateTeachControlsUi();
      return;
    }

    const replaySource = getReplayTeachSession();
    if (!replaySource || !Array.isArray(replaySource.frames) || replaySource.frames.length === 0) {
      setProgramStatus("No teach session available to replay.");
      updateTeachControlsUi();
      return;
    }

    if (state.serial.isConnected() && !ensureMotionAllowed()) {
      updateTeachControlsUi();
      return;
    }

    const frames = replaySource.frames
      .filter((frame) => frame && Array.isArray(frame.angles))
      .map((frame) => ({
        tMs: Number.isFinite(frame.tMs) ? Number(frame.tMs) : 0,
        angles: frame.angles.slice(0, 6).map((value, index) => clampAngle(index, value))
      }))
      .sort((a, b) => a.tMs - b.tMs);

    if (frames.length === 0) {
      setProgramStatus("Teach session contains no replayable keyframes.");
      updateTeachControlsUi();
      return;
    }

    clearPendingManualSends();
    await clearManualSessionState();

    state.teach.replayStopRequested = false;
    state.teach.replayToken += 1;
    const replayToken = state.teach.replayToken;
    state.teach.phase = TEACH_PHASE.REPLAYING;
    setControlOwner(CONTROL_OWNER.PROGRAM);

    const replayId = replaySource.id || "teach-session";
    setProgramStatus(`Replaying teach session: ${replayId}`);
    appendDebugConsole(`Teach replay started: ${replayId}`);
    updateTeachControlsUi();
    updateProgramControlUi();

    let cancelled = false;
    let cancelReason = "";
    let replayError = null;

    try {
      const firstT = frames.length > 0 ? Math.max(0, frames[0].tMs) : 0;
      const replayStart = performance.now();
      let previousAngles = null;
      const getReplayStopReason = () => {
        if (state.teach.replayToken !== replayToken) {
          return "session-changed";
        }
        if (state.serial.isConnected() && !state.motorsEnabled) {
          return "motors-disabled";
        }
        if (state.teach.replayStopRequested) {
          return "stop-requested";
        }
        return "";
      };

      for (const frame of frames) {
        const frameStopReason = getReplayStopReason();
        if (frameStopReason) {
          cancelled = true;
          cancelReason = frameStopReason;
          break;
        }

        const targetOffsetMs = Math.max(0, frame.tMs - firstT);
        while (performance.now() - replayStart < targetOffsetMs) {
          const remaining = targetOffsetMs - (performance.now() - replayStart);
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(24, Math.max(4, remaining))));
          const waitStopReason = getReplayStopReason();
          if (waitStopReason) {
            cancelled = true;
            cancelReason = waitStopReason;
            break;
          }
        }
        if (cancelled) {
          break;
        }

        const targetAngles = frame.angles.slice();
        applyAngles(targetAngles, { syncSliders: true, source: "teach-replay" });

        if (state.serial.isConnected()) {
          for (let servo = 0; servo < 6; servo += 1) {
            const servoStopReason = getReplayStopReason();
            if (servoStopReason) {
              cancelled = true;
              cancelReason = servoStopReason;
              break;
            }

            const previous = previousAngles ? previousAngles[servo] : null;
            if (previous !== null && previous === targetAngles[servo]) {
              continue;
            }
            await state.serial.moveServo(servo, targetAngles[servo], MANUAL_SEND_SPEED);
          }
        }

        previousAngles = targetAngles.slice();
      }
    } catch (error) {
      replayError = error;
    } finally {
      const nextPhase = state.teach.enabled
        ? (state.teach.currentSession ? TEACH_PHASE.STOPPED : TEACH_PHASE.IDLE)
        : TEACH_PHASE.OFF;

      if (state.teach.replayToken === replayToken) {
        state.teach.phase = nextPhase;
      }
      state.teach.replayStopRequested = false;

      if (state.controlOwner === CONTROL_OWNER.PROGRAM && !state.runner.isRunning()) {
        setControlOwner(CONTROL_OWNER.IDLE);
      } else {
        updateTeachControlsUi();
        updateProgramControlUi();
      }
    }

    if (replayError) {
      setProgramStatus(`Teach replay failed: ${replayError.message}`);
      appendDebugConsole(`Teach replay failed: ${replayError.message}`);
      return;
    }

    if (cancelled) {
      const stopReasonText = {
        "session-changed": "session changed",
        "motors-disabled": "motors disabled",
        "stop-requested": "stop requested"
      };
      const reasonLabel = stopReasonText[cancelReason] || cancelReason;
      const reasonSuffix = reasonLabel ? ` (${reasonLabel})` : "";
      setProgramStatus(`Teach replay stopped: ${replayId}${reasonSuffix}`);
      appendDebugConsole(`Teach replay stopped: ${replayId}${reasonSuffix}`);
      return;
    }

    setProgramStatus(`Teach replay complete: ${replayId}`);
    appendDebugConsole(`Teach replay complete: ${replayId}`);
  }

  function scheduleManualSend(servo, angle, token = null, options = {}) {
    if (!isArduinoActive()) {
      return;
    }
    if (!state.motorsEnabled) {
      return;
    }

    const debounceMs = Number.isInteger(options.debounceMs) ? Math.max(0, options.debounceMs) : MANUAL_SEND_DEBOUNCE_MS;
    const showStatus = Boolean(options.showStatus);
    const existing = state.sliderTimers.get(servo);
    if (existing) {
      clearTimeout(existing);
    }

    if (debounceMs === 0) {
      state.sliderTimers.delete(servo);
      queueManualMove(servo, angle, token, { showStatus });
      return;
    }

    const timer = window.setTimeout(() => {
      state.sliderTimers.delete(servo);
      queueManualMove(servo, angle, token, { showStatus });
    }, debounceMs);

    state.sliderTimers.set(servo, timer);
  }

  function queueManualMove(servo, angle, token = null, options = {}) {
    if (!isArduinoActive()) {
      return;
    }
    state.manualQueuedTargets.set(servo, { angle, token, showStatus: Boolean(options.showStatus) });
    void flushManualQueue(servo);
  }

  async function flushManualQueue(servo) {
    if (state.manualInFlight.has(servo)) {
      return;
    }

    state.manualInFlight.add(servo);
    try {
      while (state.manualQueuedTargets.has(servo)) {
        const queued = state.manualQueuedTargets.get(servo);
        state.manualQueuedTargets.delete(servo);
        if (!queued) {
          continue;
        }

        const { angle, token, showStatus } = queued;
        if (token !== null && !isManualSessionCurrent(servo, token)) {
          continue;
        }
        if (!state.motorsEnabled) {
          continue;
        }
        if (isMotionBlockedByFirmwareMismatch(false)) {
          continue;
        }
        if (!state.serial.isConnected() || state.runner.isRunning() || state.controlOwner === CONTROL_OWNER.PROGRAM) {
          continue;
        }

        try {
          await state.serial.moveServo(servo, angle, MANUAL_SEND_SPEED);
          if (showStatus) {
            const servoName = getServoName(servo);
            setProgramStatus(`Manual move applied: ${servoName} ${angle} deg`);
          }
        } catch (error) {
          const servoName = getServoName(servo);
          setProgramStatus(`Move failed (${servoName}): ${error.message}`);
        }
      }
    } finally {
      state.manualInFlight.delete(servo);
      if (state.manualQueuedTargets.has(servo)) {
        void flushManualQueue(servo);
      }
    }
  }

  function clearPendingManualSends() {
    for (const timer of state.sliderTimers.values()) {
      clearTimeout(timer);
    }
    state.sliderTimers.clear();
    state.manualQueuedTargets.clear();
    clearTimeout(state.manualControl.streamTimer);
    state.manualControl.streamTimer = null;
    state.manualControl.streamPending = null;
  }

  function cancelPendingManualSend(servo) {
    const existing = state.sliderTimers.get(servo);
    if (!existing) {
      state.manualQueuedTargets.delete(servo);
      return;
    }
    clearTimeout(existing);
    state.sliderTimers.delete(servo);
    state.manualQueuedTargets.delete(servo);
  }

  function cancelPendingManualSendsExcept(activeServo) {
    for (const [servo, timer] of state.sliderTimers.entries()) {
      if (servo === activeServo) {
        continue;
      }
      clearTimeout(timer);
      state.sliderTimers.delete(servo);
    }

    for (const servo of Array.from(state.manualQueuedTargets.keys())) {
      if (servo !== activeServo) {
        state.manualQueuedTargets.delete(servo);
      }
    }
    if (state.manualControl.streamPending && state.manualControl.streamPending.servo !== activeServo) {
      state.manualControl.streamPending = null;
    }
  }

  function startManualSession(servo) {
    clearTimeout(state.manualControl.releaseTimer);
    state.manualControl.releaseTimer = null;
    const startsNewSession = state.manualControl.activeServo !== servo;
    if (startsNewSession && state.manualControl.activeServo !== null) {
      state.manualControl.streamPending = null;
    }
    state.manualControl.activeServo = servo;
    if (startsNewSession) {
      state.manualControl.sessionToken += 1;
      state.manualControl.streamSessionId = `manual-${Date.now()}-${state.manualControl.sessionToken}`;
      state.manualControl.streamSequence = 0;
    }
    if (state.controlOwner !== CONTROL_OWNER.PROGRAM) {
      setControlOwner(CONTROL_OWNER.MANUAL);
    }
    return state.manualControl.sessionToken;
  }

  function scheduleManualSessionRelease(delayMs = MANUAL_SESSION_RELEASE_MS) {
    clearTimeout(state.manualControl.releaseTimer);
    state.manualControl.releaseTimer = window.setTimeout(() => {
      state.manualControl.releaseTimer = null;
      if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
        return;
      }
      if (state.manualControl.pointerActive || state.manualControl.keyboardActive) {
        return;
      }
      state.manualControl.activeServo = null;
      state.manualControl.streamSessionId = "";
      if (!state.runner.isRunning()) {
        setControlOwner(CONTROL_OWNER.IDLE);
      }
    }, delayMs);
  }

  function clearManualSessionState(reason = "cancelled", options = {}) {
    const cancelledSessionId = state.manualControl.streamSessionId;
    const cancelledSequence = state.manualControl.streamSequence;
    const hadBridgeSession = activeRobotId() === "so101_follower" && (
      state.manualControl.activeServo !== null ||
      state.manualControl.streamPending ||
      state.manualControl.streamInFlight
    );
    clearTimeout(state.manualControl.releaseTimer);
    state.manualControl.releaseTimer = null;
    state.manualControl.activeServo = null;
    state.manualControl.sessionToken += 1;
    state.manualControl.streamSessionId = "";
    state.manualControl.streamSequence = 0;
    state.manualControl.streamPending = null;
    state.manualControl.pointerActive = false;
    state.manualControl.keyboardActive = false;
    clearTimeout(state.manualControl.streamTimer);
    state.manualControl.streamTimer = null;
    if (options.sendCancel !== false && hadBridgeSession && NS.RobotRuntime && typeof NS.RobotRuntime.cancelManualTarget === "function") {
      return NS.RobotRuntime.cancelManualTarget(reason, cancelledSessionId, cancelledSequence).catch(() => {});
    }
    return Promise.resolve();
  }

  function isManualSessionCurrent(servo, token) {
    if (state.manualControl.sessionToken !== token) {
      return false;
    }
    if (state.manualControl.activeServo === null) {
      return true;
    }
    return state.manualControl.activeServo === servo;
  }

  async function setMotorsEnabled(enabled, options = {}) {
    if (!isArduinoActive()) {
      state.motorsEnabled = false;
      syncMotorsToggleUi();
      if (options.showStatus !== false) {
        setProgramStatus("Motors toggle is only available for the Arduino arm in Tier 1.");
      }
      return false;
    }
    const sendCommand = options.sendCommand !== false;
    const showStatus = options.showStatus !== false;
    const requestedEnabled = Boolean(enabled);
    const replayingTeach = state.teach.phase === TEACH_PHASE.REPLAYING;

    if (requestedEnabled && state.firmwareMismatch) {
      state.motorsEnabled = false;
      localStorage.setItem(MOTORS_STORAGE_KEY, "0");
      syncMotorsToggleUi();
      updateMotorDebugUi();
      if (showStatus && state.firmwareMismatch.message) {
        setProgramStatus(state.firmwareMismatch.message);
      }
      appendSerialConsole("SYS", "Motors remain disabled (firmware mismatch)");
      return;
    }

    state.motorsEnabled = requestedEnabled;
    localStorage.setItem(MOTORS_STORAGE_KEY, state.motorsEnabled ? "1" : "0");
    syncMotorsToggleUi();
    updateMotorDebugUi();

    if (!state.motorsEnabled) {
      if (state.teach.phase === TEACH_PHASE.REPLAYING) {
        state.teach.replayStopRequested = true;
      }
      state.runner.stop();
      clearPendingManualSends();
      clearManualSessionState();
      if (state.controlOwner !== CONTROL_OWNER.PROGRAM) {
        setControlOwner(CONTROL_OWNER.IDLE);
      }
    }

    if (sendCommand && state.serial.isConnected()) {
      try {
        if (state.motorsEnabled) {
          await state.serial.attachAll();
        } else {
          await state.serial.emergencyStop();
        }
      } catch (error) {
        setProgramStatus(`Motor toggle failed: ${error.message}`);
      }
    }

    if (showStatus) {
      if (!(replayingTeach && !state.motorsEnabled)) {
        setProgramStatus(state.motorsEnabled ? "Motors enabled" : "Motors disabled");
      }
    }

    appendSerialConsole("SYS", state.motorsEnabled ? "Motors enabled" : "Motors disabled");
  }

  function setControlOwner(owner) {
    if (state.controlOwner === owner) {
      return;
    }
    state.controlOwner = owner;
    updateManualControlLockUi();
    updateProgramControlUi();
    updateMotorDebugUi();
  }

  function updateManualControlLockUi() {
    const locked = state.controlOwner === CONTROL_OWNER.PROGRAM;
    const bridgeTransition = activeRobotId() === "so101_follower" && (state.bridgeUi.connecting || state.bridgeUi.armPending);
    const runtimeState = NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    const homeMoving = Boolean(
      activeRobotId() === "so101_follower" &&
      (state.bridgeUi.homePending || (runtimeState && runtimeState.homeControl && runtimeState.homeControl.phase === "moving"))
    );
    const interactionLocked = locked || bridgeTransition || homeMoving;
    const homeBlocked = Boolean(
      activeRobotId() === "so101_follower" &&
      runtimeState && runtimeState.connection && runtimeState.connection.connected &&
      runtimeState.connection.homeCompatible === false
    );
    const sliders = document.querySelectorAll(".servo-slider");
    sliders.forEach((slider) => {
      slider.disabled = interactionLocked;
    });

    if (ui.motorsEnabled) {
      ui.motorsEnabled.disabled = !isArduinoActive();
    }

    if (ui.btnResetDefault) {
      ui.btnResetDefault.disabled = interactionLocked;
    }
    if (ui.btnHome) {
      ui.btnHome.disabled = interactionLocked || homeBlocked;
      let homeHint;
      if (homeBlocked) {
        const errors = runtimeState.connection.homeLimitErrors || [];
        homeHint = `Arm home unavailable: ${errors.join(", ") || "pose exceeds safe limits"}`;
      } else {
        homeHint = "Move arm to home position (Ctrl+H)";
      }
      ui.btnHome.title = homeHint;
      ui.btnHome.dataset.hint = homeHint;
    }

    if (ui.manualControlsCard) {
      ui.manualControlsCard.classList.toggle("is-locked", interactionLocked);
      if (interactionLocked) {
        ui.manualControlsCard.setAttribute("aria-disabled", "true");
      } else {
        ui.manualControlsCard.removeAttribute("aria-disabled");
      }
    }

    if (state.preview) {
      state.preview.setInteractive(!locked && !state.runner.isRunning());
    }

    updateTeachControlsUi();
  }

  function showProgramLockHint() {
    const now = Date.now();
    if (now - state.manualControl.lockHintAt < 800) {
      return;
    }
    state.manualControl.lockHintAt = now;
    setProgramStatus("Program is active. Pause or Stop to return to manual control.");
  }

  function syncMotorsToggleUi() {
    if (ui.motorsEnabled) {
      ui.motorsEnabled.checked = state.motorsEnabled;
    }
    updateProgramControlUi();
  }

  function setIndexConsoleExpanded(expanded, options = {}) {
    if (!ui.indexConsoleToggle || !ui.indexConsolePanel) {
      return;
    }
    if (!expanded && state.drawerPinnedLeader && !options.force) {
      setProgramStatus("Leader details remain open while the controller requires attention.");
      openWorkbenchDrawer("leader");
      return;
    }
    const nextExpanded = Boolean(expanded);
    ui.indexConsoleToggle.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
    ui.indexConsoleToggle.setAttribute("aria-label", nextExpanded ? "Hide Bridge and Consoles" : "Show Bridge and Consoles");
    ui.indexConsoleToggle.title = nextExpanded ? "Hide Bridge and Consoles" : "Show Bridge and Consoles";
    ui.indexConsoleToggle.dataset.hint = nextExpanded ? "Hide Bridge and Consoles" : "Show Bridge and Consoles";
    ui.indexConsolePanel.hidden = !nextExpanded;
    document.body.classList.toggle("is-workbench-drawer-open", nextExpanded);
    scheduleWorkbenchLayoutRefresh();
  }

  function syncActivePreviewFromAngles() {
    if (isArduinoActive()) {
      if (state.preview) {
        state.preview.setAngles(state.angles);
      }
      return;
    }
    if (NS.RobotRuntime) {
      NS.RobotRuntime.updateJointsFromArray(state.angles);
      NS.RobotRuntime.render(ui.robotSimPreview);
    }
  }

  function readMotorsEnabled() {
    const raw = localStorage.getItem(MOTORS_STORAGE_KEY);
    if (raw === null) {
      return false;
    }
    return raw === "1" || raw === "true";
  }

  function readDebugTelemetryExpanded() {
    const raw = localStorage.getItem(DEBUG_TELEMETRY_EXPANDED_STORAGE_KEY);
    if (raw === null) {
      return false;
    }
    return raw === "1" || raw === "true";
  }

  function setDebugTelemetryExpanded(expanded, options = {}) {
    state.debugTelemetryExpanded = Boolean(expanded);
    if (ui.debugTelemetryToggle) {
      ui.debugTelemetryToggle.setAttribute("aria-expanded", state.debugTelemetryExpanded ? "true" : "false");
      const label = ui.debugTelemetryToggle.querySelector(".console-debug__toggle-label");
      if (label) {
        label.textContent = state.debugTelemetryExpanded ? "Hide telemetry" : "Show telemetry";
      }
    }
    if (ui.debugTelemetryDetails) {
      ui.debugTelemetryDetails.hidden = !state.debugTelemetryExpanded;
    }
    if (options.persist !== false) {
      localStorage.setItem(DEBUG_TELEMETRY_EXPANDED_STORAGE_KEY, state.debugTelemetryExpanded ? "1" : "0");
    }
  }

  function ensureMotionAllowed() {
    if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
      showProgramLockHint();
      return false;
    }
    if (isMotionBlockedByFirmwareMismatch(true)) {
      return false;
    }
    if (state.motorsEnabled) {
      return true;
    }
    setProgramStatus("Motors are disabled. Enable \"Motors Enabled\" first.");
    return false;
  }

  function getExpectedGripperRange() {
    const limits = JOINT_LIMITS[GRIPPER_SERVO] || [25, 130];
    return [limits[0], limits[1]];
  }

  function buildFirmwareMismatchMessage(reason) {
    return `Firmware mismatch detected (${reason}). Reflash required.`;
  }

  function isMotionBlockedByFirmwareMismatch(showStatus = false) {
    if (!state.firmwareMismatch) {
      return false;
    }
    if (showStatus && state.firmwareMismatch.message) {
      setProgramStatus(state.firmwareMismatch.message);
    }
    return true;
  }

  async function processDevicePositions(positions, source = "device") {
    if (!isArduinoActive()) {
      return false;
    }
    if (!Array.isArray(positions) || positions.length < 6) {
      return false;
    }

    if (state.firmwareMismatch) {
      return false;
    }

    applyAngles(positions, { syncSliders: true, source });
    updateMotorDebugUi();
    return true;
  }

  async function ensureFirmwareProfileCompatible(source = "device") {
    if (!isArduinoActive()) {
      return true;
    }
    if (!state.serial.isConnected()) {
      return false;
    }

    let profile = null;
    try {
      profile = await state.serial.getFirmwareProfile();
    } catch (error) {
      const reason = `profile query failed: ${error.message}`;
      await activateFirmwareMismatch({
        signature: `query-fail:${error.message}`,
        source,
        message: buildFirmwareMismatchMessage(reason),
        note: `Firmware profile query failed (${source}): ${error.message}`
      });
      return false;
    }

    const profileId = String(profile.id || "").trim();
    const [min, max] = getExpectedGripperRange();
    const profileMin = Number.parseInt(profile.gripperMin, 10);
    const profileMax = Number.parseInt(profile.gripperMax, 10);

    const issues = [];
    if (!profileId) {
      issues.push("missing profile id");
    } else if (profileId !== EXPECTED_FIRMWARE_PROFILE_ID) {
      issues.push(`profile ${profileId} (expected ${EXPECTED_FIRMWARE_PROFILE_ID})`);
    }
    if (!Number.isInteger(profileMin) || !Number.isInteger(profileMax)) {
      issues.push("missing gripper limits");
    } else if (profileMin !== min || profileMax !== max) {
      issues.push(`gripper ${profileMin}..${profileMax} (expected ${min}..${max})`);
    }

    if (issues.length > 0) {
      const reason = issues.join("; ");
      await activateFirmwareMismatch({
        signature: `profile:${profile.rawLine || reason}`,
        source,
        message: buildFirmwareMismatchMessage(reason),
        note: `Firmware profile mismatch (${source}): ${reason}`
      });
      return false;
    }

    if (state.firmwareMismatch) {
      state.firmwareMismatch = null;
      state.motorDebug.note = "";
      appendDebugConsole(`Firmware profile verified (${source}): ${profileId}, gripper ${profileMin}..${profileMax}`);
      if (ui.programStatus && /Firmware mismatch detected/i.test(ui.programStatus.textContent || "")) {
        setProgramStatus("Firmware profile verified");
      }
      updateMotorDebugUi();
      updateProgramControlUi();
    }

    return true;
  }

  async function activateFirmwareMismatch(details) {
    const signature = String(details.signature || "unknown-mismatch");
    const message = String(details.message || "Firmware mismatch detected. Reflash required.");
    const source = String(details.source || "device");
    const note = String(details.note || message);

    const isNewMismatch = !state.firmwareMismatch || state.firmwareMismatch.signature !== signature;
    const shouldStopNow = state.serial.isConnected() && (isNewMismatch || state.motorsEnabled);

    state.firmwareMismatch = {
      signature,
      message,
      source,
      note
    };
    state.motorDebug.note = note;
    updateMotorDebugUi();

    if (isNewMismatch) {
      appendDebugConsole(`Firmware mismatch (${source}): ${note}`);
      appendSerialConsole("SYS", message);
    }

    if (state.motorsEnabled) {
      await setMotorsEnabled(false, { sendCommand: false, showStatus: false });
    } else {
      syncMotorsToggleUi();
    }

    if (shouldStopNow) {
      try {
        await state.serial.emergencyStop({ immediate: true });
      } catch (error) {
        appendDebugConsole(`Mismatch guard stop failed: ${error.message}`);
      }
    }

    setProgramStatus(message);
    updateProgramControlUi();
    return false;
  }

  function appendSerialConsole(kind, text) {
    if (!ui.serialConsoleLog) {
      return;
    }

    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    state.serialConsoleLines.push(`[${timestamp}] ${kind}: ${text}`);

    while (state.serialConsoleLines.length > CONSOLE_MAX_LINES) {
      state.serialConsoleLines.shift();
    }

    ui.serialConsoleLog.textContent = state.serialConsoleLines.join("\n");
    ui.serialConsoleLog.scrollTop = ui.serialConsoleLog.scrollHeight;
  }

  function applyAngles(nextAngles, options = {}) {
    const joints = activeJoints();
    const count = Math.max(joints.length, 1);
    const fallback = getActiveHomeAngles();
    state.angles = [];
    for (let index = 0; index < count; index += 1) {
      const raw = Array.isArray(nextAngles) && index < nextAngles.length ? nextAngles[index] : fallback[index];
      state.angles.push(clampAngle(index, raw));
    }

    if (options.syncSliders) {
      for (let servo = 0; servo < state.angles.length; servo += 1) {
        const slider = document.getElementById(`slider${servo}`);
        const manualAngle = clampManualSliderValue(servo, state.angles[servo]);
        if (slider) {
          slider.value = String(manualAngle);
          updateSliderFill(slider);
        }
        updateSliderValue(servo, manualAngle);
      }
    }

    if (isArduinoActive() && state.preview) {
      state.preview.setAngles(state.angles);
    } else if (NS.RobotRuntime) {
      NS.RobotRuntime.updateJointsFromArray(state.angles);
      NS.RobotRuntime.render(ui.robotSimPreview);
    }

    updateMotorDebugUi();
  }

  function syncSliderLimitsFromJointLimits() {
    const limitsList = getActiveJointLimits();
    const runtimeState = NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    const runtimeLimits = runtimeState && runtimeState.jointLimits ? runtimeState.jointLimits : {};
    for (let servo = 0; servo < activeJoints().length; servo += 1) {
      const slider = document.getElementById(`slider${servo}`);
      if (!slider) {
        continue;
      }

      const joint = activeJoints()[servo] || {};
      const baseLimits = limitsList[servo] || [0, 180];
      const limits = getManualJointLimits(joint, baseLimits);
      const min = Number(limits[0]);
      const max = Number(limits[1]);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        continue;
      }

      slider.min = String(min);
      slider.max = String(max);
      const runtimeLimit = runtimeLimits[joint.id];
      const step = Number(runtimeLimit && runtimeLimit.step);
      const hasManualOverride = Math.abs(min - Number(baseLimits[0])) > 0.001 || Math.abs(max - Number(baseLimits[1])) > 0.001;
      slider.step = hasManualOverride
        ? "any"
        : String(Number.isFinite(step) && step > 0 ? step : (Number(joint.step) || 1));
      slider.setAttribute("aria-valuemin", String(min));
      slider.setAttribute("aria-valuemax", String(max));

      const nextAngle = quantizeJointValue(servo, clampAngle(servo, Number.parseFloat(slider.value)));
      slider.value = String(nextAngle);
      updateSliderValue(servo, nextAngle);
      updateSliderFill(slider);
      const rangeEl = document.getElementById(`range${servo}`);
      if (rangeEl) {
        const minEl = rangeEl.querySelector("[data-range-min]");
        const maxEl = rangeEl.querySelector("[data-range-max]");
        const safeGripper = activeRobotId() === "so101_follower" && joint.type === "gripper" && runtimeLimit;
        if (minEl) minEl.textContent = safeGripper ? `${formatNumericReadout(min)}% · safe open side` : formatJointReadout(joint, min);
        if (maxEl) maxEl.textContent = safeGripper ? `${formatNumericReadout(max)}% · safe closed side` : formatJointReadout(joint, max);
        rangeEl.title = `Allowed range: ${formatJointRange(joint, min, max)}`;
      }
    }
  }

  function updateSliderValue(servo, angle) {
    const slider = document.getElementById(`slider${servo}`);
    const valueEl = document.getElementById(`val${servo}`);
    if (valueEl) {
      const limits = getManualSliderLimits(servo);
      const joint = activeJoints()[servo] || {};
      const min = Number(limits[0]);
      const max = Number(limits[1]);
      const displayAngle = clampManualSliderValue(servo, angle);
      let pct = 0;
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        pct = Math.round(((displayAngle - min) / (max - min)) * 100);
      }
      pct = Math.min(100, Math.max(0, pct));
      valueEl.textContent = formatJointReadout(joint, displayAngle);
      valueEl.title = `Range ${min}..${max} ${joint.unit || "deg"}`;
      if (slider) {
        slider.setAttribute("aria-valuenow", String(displayAngle));
        slider.setAttribute("aria-valuetext", formatJointAriaValue(joint, displayAngle, pct));
      }
    }
  }

  function updateSliderFill(slider) {
    const min = Number(slider.min);
    const max = Number(slider.max);
    const val = Number(slider.value);
    const pct = ((val - min) / (max - min)) * 100;
    slider.style.setProperty("--fill-pct", pct + "%");
  }

  function updateStatusIcon(iconName, isRunning, isError, isWarning = false) {
    const currentIcon = document.getElementById("programStatusIcon") || ui.programStatusIcon;
    if (!currentIcon) {
      return;
    }
    const iconHost = document.createElement("i");
    iconHost.id = "programStatusIcon";
    iconHost.className = "bottombar__status-icon";
    iconHost.setAttribute("data-lucide", iconName);
    iconHost.classList.toggle("is-running", Boolean(isRunning));
    iconHost.classList.toggle("is-error", Boolean(isError));
    iconHost.classList.toggle("is-warning", Boolean(isWarning));
    currentIcon.replaceWith(iconHost);
    ui.programStatusIcon = iconHost;
    if (window.lucide) {
      lucide.createIcons({ nodes: [ui.programStatusIcon] });
      ui.programStatusIcon = document.getElementById("programStatusIcon") || ui.programStatusIcon;
    }
  }

  function setConnectionStatus(connected, text) {
    ui.statusDot.classList.toggle("is-connected", connected);
    ui.statusDot.classList.remove("is-connecting");
    ui.statusText.textContent = text || (connected ? "Connected" : "Disconnected");
    syncExecutionTarget();
  }

  function getConnectionTransportLabel() {
    if (!state.serial || typeof state.serial.getTransportLabel !== "function") {
      return "Serial";
    }
    return state.serial.getTransportLabel();
  }

  function setProgramStatus(text) {
    ui.programStatus.textContent = text;
  }

  function getRunBlockReason() {
    const runtimeState = NS.RobotRuntime && NS.RobotRuntime.getState ? NS.RobotRuntime.getState() : null;
    if (
      activeRobotId() === "so101_follower" &&
      (state.bridgeUi.homePending || (runtimeState && runtimeState.homeControl && runtimeState.homeControl.phase === "moving"))
    ) {
      return {
        tone: "warning",
        text: "Home is moving. Press STOP before starting a program."
      };
    }
    if (state.teach.phase === TEACH_PHASE.REPLAYING) {
      return {
        tone: "warning",
        text: "Teach replay is running. Stop replay before running a program."
      };
    }

    if (state.teach.phase === TEACH_PHASE.RECORDING || state.teach.phase === TEACH_PHASE.PAUSED) {
      return {
        tone: "warning",
        text: "Teach recording is active. Stop or discard teach session before running."
      };
    }

    if (state.firmwareMismatch) {
      return {
        tone: "error",
        text: state.firmwareMismatch.message || "Firmware mismatch detected. Reflash required."
      };
    }

    if (state.serial.isConnected() && !state.motorsEnabled) {
      return {
        tone: "warning",
        text: "Motors are disabled. Enable Motors Enabled to run."
      };
    }

    return null;
  }

  function setProgramControlHint(text, tone = "ready") {
    if (!ui.programControlHint) {
      return;
    }
    ui.programControlHint.textContent = text;
    ui.programControlHint.dataset.tone = tone;
  }

  function syncProgramPauseButton(isRunning, isPaused, isStopping) {
    if (!ui.btnPause) {
      return;
    }

    ui.btnPause.disabled = !isRunning || isStopping;
    const iconName = isPaused ? "play" : "pause";
    const label = isPaused ? "Resume" : "Pause";
    const title = isPaused ? "Resume Program (P)" : "Pause Program (P)";
    ui.btnPause.title = title;

    const labelEl = ui.btnPause.querySelector("span");
    if (labelEl) {
      labelEl.textContent = label;
    }
    const iconEl = ui.btnPause.querySelector("[data-lucide]");
    if (iconEl) {
      iconEl.setAttribute("data-lucide", iconName);
      if (window.lucide) {
        lucide.createIcons({ nodes: [iconEl] });
      }
    }
  }

  function updateProgramControlUi() {
    const runnerRunning = Boolean(state.runner && state.runner.isRunning());
    const runnerPaused = Boolean(runnerRunning && state.runner && typeof state.runner.isPaused === "function" && state.runner.isPaused());
    const stopping = Boolean(state.programStopInProgress);
    const blockReason = !runnerRunning && !stopping ? getRunBlockReason() : null;
    const runBlocked = Boolean(blockReason);

    if (ui.btnRun) {
      ui.btnRun.disabled = runnerRunning || stopping || runBlocked;
    }
    syncProgramPauseButton(runnerRunning, runnerPaused, stopping);
    if (ui.btnStop) {
      ui.btnStop.disabled = !runnerRunning || stopping;
    }

    if (stopping) {
      setProgramControlHint("Stopping program...", "warning");
      updateStatusIcon("loader", true, false, true);
      return;
    }

    if (runnerRunning) {
      if (runnerPaused) {
        setProgramControlHint("Program paused. Resume or Stop is active.", "warning");
        updateStatusIcon("pause", false, false, true);
      } else {
        setProgramControlHint("Program running. Pause or Stop is active.", "active");
        updateStatusIcon("loader", true, false, false);
      }
      return;
    }

    if (runBlocked) {
      setProgramControlHint(blockReason.text, blockReason.tone);
      const isErrorTone = blockReason.tone === "error";
      updateStatusIcon(isErrorTone ? "alert-triangle" : "pause", false, isErrorTone, !isErrorTone);
      return;
    }

    if (state.programLastError) {
      setProgramControlHint("Last run ended with an error. Review status/console and retry.", "error");
      updateStatusIcon("alert-triangle", false, true);
      return;
    }

    if (state.serial.isConnected()) {
      setProgramControlHint("Ready to run.", "ready");
    } else {
      setProgramControlHint("Ready to run (simulation mode while disconnected).", "ready");
    }
    updateStatusIcon("circle-check", false, false);
  }

  function initMotorDebugUi() {
    state.debugTelemetryExpanded = false;
    setDebugTelemetryExpanded(false, { persist: false });
    state.debugConsoleLines = [];
    state.motorDebug.snapshot = "";
    updateMotorDebugUi();
    appendDebugConsole("Debug monitor ready");
  }

  function onMotorDebugTx(command) {
    state.motorDebug.lastTx = command;
    state.motorDebug.note = "";

    if (command === "!") {
      state.motorDebug.pendingMotion = [];
      state.motorDebug.activeServos.clear();
      state.motorDebug.note = "Emergency stop sent";
      appendDebugConsole("TX ! -> emergency stop");
      updateMotorDebugUi();
      return;
    }

    const motion = parseMotionCommand(command);
    if (motion) {
      // Serial commands are serialized; the last transmitted motion command is the one in-flight.
      state.motorDebug.pendingMotion = [motion];
      state.motorDebug.activeServos = new Set(motion.servos);
      state.motorDebug.note = motion.note;
      appendDebugConsole(`TX ${command} -> ${motion.note}`);
      updateMotorDebugUi();
      return;
    }

    if (command === "A") {
      state.motorDebug.note = "Attach all sent";
      appendDebugConsole("TX A -> attach all");
    } else if (command === "F") {
      state.motorDebug.note = "Query firmware profile";
      appendDebugConsole("TX F -> query firmware profile");
    } else if (command === "Q") {
      state.motorDebug.note = "Query positions";
      appendDebugConsole("TX Q -> query positions");
    } else if (command === "P") {
      appendDebugConsole("TX P -> pause");
    } else if (command === "R") {
      appendDebugConsole("TX R -> resume");
    }

    updateMotorDebugUi();
  }

  function onMotorDebugRx(line) {
    state.motorDebug.lastRx = line;

    if (line === "STOPPED") {
      state.motorDebug.pendingMotion = [];
      state.motorDebug.activeServos.clear();
      state.motorDebug.note = "Emergency stop confirmed";
      appendDebugConsole("RX STOPPED -> all motors detached");
      updateMotorDebugUi();
      return;
    }

    if (line === "OK" || line.startsWith("ERR")) {
      const completed = state.motorDebug.pendingMotion.length > 0 ? state.motorDebug.pendingMotion[0] : null;
      if (state.motorDebug.pendingMotion.length > 0) {
        state.motorDebug.pendingMotion.shift();
      }
      if (state.motorDebug.pendingMotion.length > 0) {
        state.motorDebug.activeServos = new Set(state.motorDebug.pendingMotion[0].servos);
        state.motorDebug.note = state.motorDebug.pendingMotion[0].note;
      } else {
        state.motorDebug.activeServos.clear();
      }
      if (line.startsWith("ERR")) {
        state.motorDebug.note = line;
        appendDebugConsole(`RX ${line}`);
      } else if (completed) {
        appendDebugConsole(`RX OK -> completed ${completed.note}`);
      }
      updateMotorDebugUi();
      return;
    }

    if (line.startsWith("P")) {
      state.motorDebug.note = "Position report received";
      appendDebugConsole(`RX ${line}`);
      updateMotorDebugUi();
      return;
    }

    if (line.startsWith("CFG:")) {
      state.motorDebug.note = "Firmware profile received";
      appendDebugConsole(`RX ${line}`);
      updateMotorDebugUi();
    }
  }

  function resetMotorDebugState(note = "") {
    state.motorDebug.pendingMotion = [];
    state.motorDebug.activeServos.clear();
    state.motorDebug.note = note || "";
    if (note) {
      state.motorDebug.lastRx = note;
      appendDebugConsole(`Status: ${note}`);
    }
    updateMotorDebugUi();
  }

  function parseMotionCommand(command) {
    if (command === "H") {
      return {
        servos: [0, 1, 2, 3, 4, 5],
        note: "Home all joints"
      };
    }

    const servoMove = /^S([0-5]):(-?\d+):(\d+)$/.exec(command);
    if (servoMove) {
      const servo = Number.parseInt(servoMove[1], 10);
      const angle = Number.parseInt(servoMove[2], 10);
      const speed = Number.parseInt(servoMove[3], 10);
      return {
        servos: [servo],
        note: `${getServoName(servo)} to ${angle} deg @${speed}`
      };
    }

    const delayMove = /^D:(\d+)$/.exec(command);
    if (delayMove) {
      const delayMs = Number.parseInt(delayMove[1], 10);
      return {
        servos: [],
        note: `Delay ${delayMs} ms`
      };
    }

    if (/^T:/.test(command)) {
      return {
        servos: [],
        note: "Trajectory frame command"
      };
    }

    return null;
  }

  function getSerialQueueSnapshot() {
    if (!state.serial || typeof state.serial.getQueueSnapshot !== "function") {
      return { pending: 0, inFlight: "", lineWaiters: 0 };
    }
    const snapshot = state.serial.getQueueSnapshot();
    return {
      pending: Math.max(0, Number(snapshot.pending) || 0),
      inFlight: typeof snapshot.inFlight === "string" ? snapshot.inFlight : "",
      lineWaiters: Math.max(0, Number(snapshot.lineWaiters) || 0)
    };
  }

  function getMotionModeLabel() {
    if (state.programStopInProgress) {
      return "Program (stopping)";
    }
    if (state.runner && state.runner.isRunning()) {
      const paused = typeof state.runner.isPaused === "function" && state.runner.isPaused();
      return paused ? "Program (paused)" : "Program (running)";
    }
    if (state.teach.phase === TEACH_PHASE.REPLAYING) {
      return "Teach (replay)";
    }
    if (state.teach.phase === TEACH_PHASE.RECORDING) {
      return "Teach (recording)";
    }
    if (state.teach.phase === TEACH_PHASE.PAUSED) {
      return "Teach (paused)";
    }
    if (state.controlOwner === CONTROL_OWNER.MANUAL) {
      return "Manual";
    }
    return "Idle";
  }

  function getProtocolPathLabel() {
    if (!state.serial || !state.serial.isConnected()) {
      return "N/A (disconnected)";
    }
    if (state.firmwareMismatch) {
      return "Blocked (firmware mismatch)";
    }
    return "Legacy (RA1)";
  }

  function describeTrajectoryState(queueSnapshot) {
    const inFlight = queueSnapshot && queueSnapshot.inFlight ? queueSnapshot.inFlight : "";
    if (inFlight.startsWith("T:")) {
      return "Trajectory frame in-flight";
    }
    if (inFlight) {
      return "Legacy step in-flight";
    }
    if (queueSnapshot && queueSnapshot.pending > 0) {
      return "Legacy queue pending";
    }
    if (state.serial && state.serial.isConnected()) {
      return "Legacy idle";
    }
    return "N/A";
  }

  function setDebugTelemetryValue(node, value) {
    if (!node) {
      return;
    }
    const text = value === undefined || value === null || value === "" ? "-" : String(value);
    node.textContent = text;
    node.title = text;
  }

  function updateDebugMotionSummary(activeServos, stateText, limitLine) {
    const queue = getSerialQueueSnapshot();
    const modeLabel = getMotionModeLabel();
    const protocolLabel = getProtocolPathLabel();
    const activeText = activeServos.length > 0 ? activeServos.map((servo) => getServoName(servo)).join(", ") : "None";
    const motionText = state.motorDebug.pendingMotion.length > 0
      ? state.motorDebug.pendingMotion[0].note
      : (state.motorDebug.note || "None");
    const inFlightText = queue.inFlight || "none";
    const txText = state.motorDebug.lastTx || "-";
    const rxText = state.motorDebug.lastRx || "-";
    const trajectoryText = describeTrajectoryState(queue);
    setDebugTelemetryValue(ui.debugChipMode, modeLabel);
    setDebugTelemetryValue(ui.debugChipTrajectory, trajectoryText);
    setDebugTelemetryValue(ui.debugChipQueue, queue.pending);
    setDebugTelemetryValue(ui.debugChipWaiters, queue.lineWaiters);
    setDebugTelemetryValue(ui.debugDetailProtocol, protocolLabel);
    setDebugTelemetryValue(ui.debugDetailInFlight, inFlightText);
    setDebugTelemetryValue(ui.debugDetailMotion, motionText);
    setDebugTelemetryValue(ui.debugDetailState, stateText);
    setDebugTelemetryValue(ui.debugDetailActive, activeText);
    setDebugTelemetryValue(ui.debugDetailLimit, limitLine);
    setDebugTelemetryValue(ui.debugDetailTx, txText);
    setDebugTelemetryValue(ui.debugDetailRx, rxText);
  }

  function getLimitWatchInfo() {
    const nearLimit = [];
    const joints = activeJoints();
    const limitsList = getActiveJointLimits();
    for (let servo = 0; servo < joints.length; servo += 1) {
      const limits = limitsList[servo] || [0, 180];
      const joint = joints[servo] || {};
      const unit = joint.unit === "percent" ? "%" : " deg";
      const angle = state.angles[servo];
      if (!Number.isFinite(angle)) {
        continue;
      }
      if (angle <= limits[0]) {
        nearLimit.push(`${getServoName(servo)} min (${angle}${unit})`);
      } else if (angle >= limits[1]) {
        nearLimit.push(`${getServoName(servo)} max (${angle}${unit})`);
      }
    }

    if (nearLimit.length === 0) {
      return { text: "No joint at hard limit.", alert: false };
    }
    return { text: `Limit watch: ${nearLimit.join(", ")}`, alert: true };
  }

  function appendDebugConsole(text) {
    if (!ui.debugConsoleLog) {
      return;
    }
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    state.debugConsoleLines.push(`[${timestamp}] DEBUG: ${text}`);
    while (state.debugConsoleLines.length > DEBUG_CONSOLE_MAX_LINES) {
      state.debugConsoleLines.shift();
    }
    ui.debugConsoleLog.textContent = state.debugConsoleLines.join("\n");
    ui.debugConsoleLog.scrollTop = ui.debugConsoleLog.scrollHeight;
  }

  function updateMotorDebugUi() {
    const connected = state.serial && state.serial.isConnected();
    const activeServos = Array.from(state.motorDebug.activeServos).sort((a, b) => a - b);

    let stateText = "Idle";
    if (!connected) {
      stateText = "Disconnected";
    } else if (state.motorDebug.lastRx === "STOPPED") {
      stateText = "Stopped";
    } else if (!state.motorsEnabled) {
      stateText = "Motors Off";
    } else if (activeServos.length > 0) {
      stateText = `Active ${activeServos.length}`;
    }

    const limitWatch = getLimitWatchInfo();
    const activeText = activeServos.length > 0 ? activeServos.map((servo) => getServoName(servo)).join(", ") : "None";
    const stateLine = `State: ${stateText} | Active: ${activeText}`;
    const limitLine = limitWatch.alert ? limitWatch.text : "No joint at hard limit";
    const noteLine = state.motorDebug.note ? ` | ${state.motorDebug.note}` : "";
    updateDebugMotionSummary(activeServos, stateText, limitLine);



    const snapshot = `${stateText}|${activeText}|${limitLine}|${state.motorDebug.note}`;
    if (snapshot !== state.motorDebug.snapshot) {
      state.motorDebug.snapshot = snapshot;
      appendDebugConsole(`${stateLine}; ${limitLine}${state.motorDebug.note ? `; ${state.motorDebug.note}` : ""}`);
    }
  }

  function buildBlockDiagramFile(blockXml, source) {
    return {
      schema: BLOCKS_FILE_SCHEMA,
      kind: "block-diagram",
      source,
      app: "RoboBuddy",
      savedAt: new Date().toISOString(),
      payload: {
        blockXml: String(blockXml || "")
      }
    };
  }

  function getBlockDiagramSourcePage() {
    if (document.body && document.body.classList.contains("index-3d-page")) {
      return "index.html";
    }
    return "index.html";
  }

  function usesBlockFileWorkflow() {
    return Boolean(ui.btnLoadUserBlocks);
  }

  function openSaveDialog() {
    if (!ui.saveDialog || !ui.saveName) {
      setProgramStatus("Save dialog unavailable.");
      return;
    }
    if (!ui.saveDialog.open) {
      ui.saveDialog.showModal();
      ui.saveName.focus();
    }
  }

  function openLoadDialog() {
    renderProgramList();
    if (!ui.loadDialog.open) {
      ui.loadDialog.showModal();
    }
  }

  function renderProgramList() {
    ui.programList.innerHTML = "";
    const programs = state.storage.listPrograms();

    if (programs.length === 0) {
      ui.programList.textContent = "No saved programs yet.";
      return;
    }

    for (const program of programs) {
      const row = document.createElement("div");
      row.className = "program-row";

      const iconWrap = document.createElement("span");
      iconWrap.className = "program-row__icon";
      const iconI = document.createElement("i");
      iconI.setAttribute("data-lucide", program.builtIn ? "box" : "file-code");
      iconWrap.appendChild(iconI);
      row.appendChild(iconWrap);

      const meta = document.createElement("div");
      meta.className = "program-row__meta";

      const name = document.createElement("div");
      name.className = "program-row__name";
      name.textContent = program.name;

      if (program.builtIn) {
        const pill = document.createElement("span");
        pill.className = "program-pill";
        pill.textContent = "Example";
        name.appendChild(pill);
      } else if (program.source === "teach") {
        const pill = document.createElement("span");
        pill.className = "program-pill";
        pill.textContent = "Teach";
        name.appendChild(pill);
      }

      const time = document.createElement("div");
      time.className = "program-row__time";
      time.textContent = program.updatedAt || "";

      meta.appendChild(name);
      meta.appendChild(time);

      const actions = document.createElement("div");
      actions.className = "program-row__actions";

      const loadBtn = document.createElement("button");
      loadBtn.className = "btn btn--load";
      const loadIcon = program.source === "teach" ? "puzzle" : "download";
      const loadLabel = program.source === "teach" ? "Load Blocks" : "Load";
      loadBtn.innerHTML = `<i data-lucide="${loadIcon}"></i><span>${loadLabel}</span>`;
      loadBtn.addEventListener("click", () => {
        loadProgram(program.name, { mode: "block" });
      });
      actions.appendChild(loadBtn);

      if (program.hasScript) {
        const scriptBtn = document.createElement("button");
        scriptBtn.className = "btn btn--load";
        scriptBtn.innerHTML = '<i data-lucide="file-text"></i><span>Script</span>';
        scriptBtn.addEventListener("click", () => {
          loadProgram(program.name, { mode: "script" });
        });
        actions.appendChild(scriptBtn);
      }

      if (!program.builtIn) {
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn btn--clear";
        deleteBtn.innerHTML = '<i data-lucide="trash-2"></i><span>Delete</span>';
        deleteBtn.addEventListener("click", () => {
          state.storage.deleteProgram(program.name);
          renderProgramList();
          setProgramStatus(`Deleted: ${program.name}`);
        });
        actions.appendChild(deleteBtn);
      }

      row.appendChild(meta);
      row.appendChild(actions);
      ui.programList.appendChild(row);
    }

    if (window.lucide) {
      lucide.createIcons({ nodes: ui.programList.querySelectorAll("[data-lucide]") });
    }
  }

  function loadProgram(name, options = {}) {
    const program = state.storage.getProgram(name);
    if (!program) {
      setProgramStatus(`Program not found: ${name}`);
      return;
    }

    if (program.robotId && program.robotId !== activeRobotId() && NS.RobotRegistry && NS.RobotRegistry.get(program.robotId)) {
      switchActiveRobot(program.robotId);
    }

    const mode = options.mode === "script" ? "script" : "block";
    if (mode === "script") {
      if (!program.hasScript || typeof program.scriptText !== "string" || program.scriptText.length === 0) {
        setProgramStatus(`Script export not available for: ${name}`);
        return;
      }
      const opened = openProgramScriptDialog(program);
      if (!opened) {
        return;
      }
      if (ui.loadDialog && ui.loadDialog.open) {
        ui.loadDialog.close();
      }
      setProgramStatus(`Opened script: ${name}`);
      return;
    }

    const xmlText = typeof program.blockXml === "string" && program.blockXml ? program.blockXml : program.xml;
    if (!xmlText) {
      setProgramStatus(`Load failed: ${name} has no block workspace export`);
      return;
    }

    try {
      const xml = parseWorkspaceXml(xmlText);
      state.workspace.clear();
      Blockly.Xml.domToWorkspace(xml, state.workspace);
      setProgramStatus(`Loaded: ${name}`);
      if (ui.loadDialog && ui.loadDialog.open) {
        ui.loadDialog.close();
      }
    } catch (error) {
      setProgramStatus(`Load failed: ${error.message}`);
    }
  }

  function openProgramScriptDialog(program) {
    if (!ui.scriptDialog || !ui.scriptDialogText) {
      setProgramStatus("Script dialog unavailable");
      return false;
    }
    if (ui.scriptDialogName) {
      ui.scriptDialogName.textContent = program && program.name ? program.name : "Program";
    }
    ui.scriptDialogText.value = String(program && program.scriptText ? program.scriptText : "");
    if (!ui.scriptDialog.open) {
      ui.scriptDialog.showModal();
    }
    if (window.lucide) {
      lucide.createIcons({ nodes: ui.scriptDialog.querySelectorAll("[data-lucide]") });
    }
    return true;
  }

  function loadInitialWorkspace() {
    if (!isArduinoActive()) {
      return;
    }
    const waveHello = state.storage.getProgram("Wave Hello");
    if (!waveHello) {
      return;
    }

    try {
      const xml = parseWorkspaceXml(waveHello.xml);
      Blockly.Xml.domToWorkspace(xml, state.workspace);
      setProgramStatus("Loaded example: Wave Hello");
    } catch (error) {
      setProgramStatus("Could not load startup example");
    }
  }

  function parseWorkspaceXml(xmlText) {
    if (Blockly.utils && Blockly.utils.xml && typeof Blockly.utils.xml.textToDom === "function") {
      return Blockly.utils.xml.textToDom(xmlText);
    }
    if (Blockly.Xml && typeof Blockly.Xml.textToDom === "function") {
      return Blockly.Xml.textToDom(xmlText);
    }
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    return doc.documentElement;
  }

  function parseBlockDiagramFile(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error("Choose a valid RoboBuddy block diagram JSON file.");
    }

    if (!data || data.schema !== BLOCKS_FILE_SCHEMA || data.kind !== "block-diagram") {
      throw new Error("Unsupported block diagram file.");
    }

    const blockXml = data.payload && data.payload.blockXml;
    if (typeof blockXml !== "string" || !blockXml.trim()) {
      throw new Error("Block diagram file is missing Blockly XML.");
    }

    const xmlDom = parseWorkspaceXml(blockXml);
    if (!xmlDom || String(xmlDom.nodeName || "").toLowerCase() !== "xml") {
      throw new Error("Block diagram XML is invalid.");
    }

    return { blockXml, xmlDom };
  }

  async function saveWorkspaceBlocksToFile() {
    if (!NS.FileWorkflows || typeof NS.FileWorkflows.saveJsonFile !== "function") {
      setProgramStatus("File save is unavailable.");
      return;
    }

    try {
      const blockXml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(state.workspace));
      const payload = buildBlockDiagramFile(blockXml, getBlockDiagramSourcePage());
      const result = await NS.FileWorkflows.saveJsonFile(payload, {
        suggestedName: "block-diagram.robobuddy-blocks.json",
        description: "RoboBuddy block diagrams",
        accept: BLOCKS_FILE_ACCEPT,
        mimeType: "application/json;charset=utf-8"
      });

      if (result.canceled) {
        setProgramStatus("Save canceled.");
        return;
      }
      if (!result.ok) {
        throw result.error || new Error("File save failed.");
      }
      setProgramStatus(`Saved user blocks: ${result.name || "file"}`);
    } catch (error) {
      setProgramStatus(`Save failed: ${error.message}`);
    }
  }

  async function loadWorkspaceBlocksFromFile() {
    if (!NS.FileWorkflows || typeof NS.FileWorkflows.openTextFile !== "function") {
      setProgramStatus("File load is unavailable.");
      return;
    }

    try {
      const result = await NS.FileWorkflows.openTextFile({
        description: "RoboBuddy block diagrams",
        accept: BLOCKS_FILE_ACCEPT,
        mimeType: "application/json",
        maxBytes: JSON_IMPORT_MAX_BYTES
      });

      if (result.canceled) {
        setProgramStatus("Load canceled.");
        return;
      }
      if (!result.ok) {
        throw result.error || new Error("File load failed.");
      }

      const parsed = parseBlockDiagramFile(result.text);
      if (Blockly.Xml.clearWorkspaceAndLoadFromXml) {
        Blockly.Xml.clearWorkspaceAndLoadFromXml(parsed.xmlDom, state.workspace);
      } else {
        state.workspace.clear();
        Blockly.Xml.domToWorkspace(parsed.xmlDom, state.workspace);
      }
      Blockly.svgResize(state.workspace);
      setProgramStatus(`Loaded user blocks: ${result.name || "file"}`);
    } catch (error) {
      setProgramStatus(`Load failed: ${error.message}`);
    }
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

  function clampAngle(servo, angle) {
    const limits = getActiveJointLimits()[servo] || [0, 180];
    const safeAngle = Number.isFinite(angle) ? angle : limits[0];
    return Math.min(limits[1], Math.max(limits[0], safeAngle));
  }

  function isTypingTarget(target) {
    if (!target) {
      return false;
    }
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  function hasOpenDialog() {
    return Boolean(
      (ui.saveDialog && ui.saveDialog.open) ||
      (ui.loadDialog && ui.loadDialog.open) ||
      (ui.scriptDialog && ui.scriptDialog.open)
    );
  }
})();
