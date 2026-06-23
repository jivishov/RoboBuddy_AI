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
  const WORKSPACE_TAB = {
    MANUAL: "manual",
    BLOCK: "block"
  };
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
    manualInFlight: new Set(),
    workspace: null,
    serial: null,
    preview: null,
    storage: null,
    runner: null,
    motorsEnabled: false,
    serialConsoleLines: [],
    activeTab: WORKSPACE_TAB.MANUAL,
    controlOwner: CONTROL_OWNER.IDLE,
    manualControl: {
      activeServo: null,
      sessionToken: 0,
      releaseTimer: null,
      lockHintAt: 0
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
    pendingDefaultReset: false
  };

  const ui = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheUi();
    initMotorDebugUi();

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

    state.serial = new NS.SerialManager({ baudRate: 9600 });
    state.preview = new NS.ArmPreview(ui.armSvg, {
      jointLimits: JOINT_LIMITS,
      onAnglesChange: (angles, meta) => onPreviewAnglesChange(angles, meta),
      onDragStateChange: (isDragging) => onPreviewDragStateChange(isDragging)
    });
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

    wireSerialEvents();
    wireRunnerEvents();
    wireButtons();
    wireSliders();
    wireWorkspaceTabs();
    wireKeyboardShortcuts();

    syncSliderLimitsFromJointLimits();
    loadInitialWorkspace();
    applyAngles(state.angles, { syncSliders: true, source: "init" });

    document.querySelectorAll(".servo-slider").forEach(updateSliderFill);
    syncMotorsToggleUi();
    updateManualControlLockUi();
    updateTeachControlsUi();

    appendSerialConsole("SYS", "RoboBuddy ready");
    appendSerialConsole("SYS", state.motorsEnabled ? "Motors enabled" : "Motors disabled");
    appendSerialConsole("SYS", "Bluetooth tip: pair HC-05 in OS settings, then click Connect and choose the paired serial port.");
    updateMotorDebugUi();

    window.addEventListener("resize", () => {
      if (state.workspace && state.activeTab === WORKSPACE_TAB.BLOCK) {
        Blockly.svgResize(state.workspace);
      }
    });

    if (!state.serial.supportsWebSerial()) {
      ui.btnConnect.disabled = true;
      setConnectionStatus(false, "Web Serial unavailable (use desktop Chrome/Edge)");
    }
  }

  function cacheUi() {
    ui.toolbox = document.getElementById("toolbox");
    ui.workspaceTabs = document.getElementById("workspaceTabs");
    ui.tabBlock = document.getElementById("tabBlock");
    ui.tabManual = document.getElementById("tabManual");
    ui.panelBlock = document.getElementById("panelBlock");
    ui.panelManual = document.getElementById("panelManual");

    ui.armPreview = document.getElementById("armPreview");
    ui.armSvg = document.getElementById("armSvg");

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
      if (btnSpan) {
        btnSpan.textContent = connected ? "Disconnect" : "Connect";
      }
      const btnIcon = ui.btnConnect.querySelector("[data-lucide]");
      if (btnIcon && window.lucide) {
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

  function wireButtons() {
    ui.btnConnect.addEventListener("click", async () => {
      await handleConnectToggle();
    });

    ui.btnHome.addEventListener("click", async () => {
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

    ui.btnEmergencyStop.addEventListener("click", async () => {
      const replayingTeach = state.teach.phase === TEACH_PHASE.REPLAYING;
      state.runner.stop();
      clearPendingManualSends();
      clearManualSessionState();
      if (replayingTeach) {
        state.teach.replayStopRequested = true;
      } else {
        setControlOwner(CONTROL_OWNER.IDLE);
      }
      try {
        if (state.serial.isConnected()) {
          await state.serial.emergencyStop();
        }
        await setMotorsEnabled(false, { sendCommand: false, showStatus: false });
        if (replayingTeach) {
          setProgramStatus("Emergency stop triggered. Stopping teach replay...");
          updateTeachControlsUi();
          updateProgramControlUi();
        } else {
          setProgramStatus("Emergency stop triggered");
        }
      } catch (error) {
        setProgramStatus(`Emergency stop failed: ${error.message}`);
      }
    });

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
          state.storage.saveProgram(name, xml, { source: "blockly" });
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
      const servo = Number.parseInt(slider.dataset.servo, 10);

      slider.addEventListener("pointerdown", () => {
        if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
          showProgramLockHint();
          return;
        }
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
        const angle = clampAngle(servo, Number.parseInt(target.value, 10));
        state.angles[servo] = angle;
        updateSliderValue(servo, angle);
        updateSliderFill(target);
        state.preview.setAngles(state.angles);
        updateMotorDebugUi();
        scheduleTeachDragCapture();

        if (state.serial.isConnected() && !state.runner.isRunning() && state.motorsEnabled) {
          scheduleManualSend(servo, angle, token);
        }

        scheduleManualSessionRelease();
      });

      slider.addEventListener("change", (event) => {
        if (state.controlOwner === CONTROL_OWNER.PROGRAM) {
          showProgramLockHint();
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
        state.preview.setAngles(state.angles);
        updateMotorDebugUi();
        captureTeachReleaseKeyframe();
        const servoName = SERVO_NAMES[servo] || `Servo ${servo}`;
        setProgramStatus(`Sending manual move: ${servoName} ${angle} deg`);
        scheduleManualSend(servo, angle, token, { debounceMs: 0, showStatus: true });
        scheduleManualSessionRelease();
      });

      slider.addEventListener("blur", () => {
        scheduleManualSessionRelease();
      });
    });
  }

  function wireWorkspaceTabs() {
    if (!ui.tabManual || !ui.tabBlock) {
      return;
    }

    const tabByButton = new Map([
      [ui.tabManual, { name: WORKSPACE_TAB.MANUAL, button: ui.tabManual }],
      [ui.tabBlock, { name: WORKSPACE_TAB.BLOCK, button: ui.tabBlock }]
    ]);
    const orderedButtons = ui.workspaceTabs
      ? Array.from(ui.workspaceTabs.querySelectorAll("#tabManual, #tabBlock"))
      : [ui.tabManual, ui.tabBlock];
    const tabs = orderedButtons
      .map((button) => tabByButton.get(button))
      .filter(Boolean);

    tabs.forEach((tab, index) => {
      tab.button.addEventListener("click", () => {
        setActiveTab(tab.name);
      });

      tab.button.addEventListener("keydown", (event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          setActiveTab(tab.name);
          return;
        }

        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          const nextIndex = (index + direction + tabs.length) % tabs.length;
          const nextTab = tabs[nextIndex];
          nextTab.button.focus();
          setActiveTab(nextTab.name);
          return;
        }

        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const targetIndex = event.key === "Home" ? 0 : tabs.length - 1;
          const targetTab = tabs[targetIndex];
          targetTab.button.focus();
          setActiveTab(targetTab.name);
        }
      });
    });

    setActiveTab(readDefaultWorkspaceTab(), { force: true });
  }

  function readDefaultWorkspaceTab() {
    if (!ui.workspaceTabs) {
      return state.activeTab;
    }
    return normalizeWorkspaceTab(ui.workspaceTabs.dataset.defaultTab || state.activeTab);
  }

  function readShortcutWorkspaceTab(slot) {
    if (!ui.workspaceTabs) {
      return slot === "2" ? WORKSPACE_TAB.BLOCK : WORKSPACE_TAB.MANUAL;
    }
    const key = slot === "2" ? "shortcutTab2" : "shortcutTab1";
    const fallback = slot === "2" ? WORKSPACE_TAB.BLOCK : WORKSPACE_TAB.MANUAL;
    return normalizeWorkspaceTab(ui.workspaceTabs.dataset[key] || fallback);
  }

  function normalizeWorkspaceTab(tabName) {
    return tabName === WORKSPACE_TAB.BLOCK ? WORKSPACE_TAB.BLOCK : WORKSPACE_TAB.MANUAL;
  }

  function setActiveTab(tabName, options = {}) {
    const nextTab = normalizeWorkspaceTab(tabName);
    const force = Boolean(options.force);

    if (!force && state.activeTab === nextTab) {
      return;
    }

    state.activeTab = nextTab;

    const manualActive = nextTab === WORKSPACE_TAB.MANUAL;
    const blockActive = nextTab === WORKSPACE_TAB.BLOCK;

    if (ui.tabManual) {
      ui.tabManual.classList.toggle("is-active", manualActive);
      ui.tabManual.setAttribute("aria-selected", manualActive ? "true" : "false");
      ui.tabManual.tabIndex = manualActive ? 0 : -1;
    }

    if (ui.tabBlock) {
      ui.tabBlock.classList.toggle("is-active", blockActive);
      ui.tabBlock.setAttribute("aria-selected", blockActive ? "true" : "false");
      ui.tabBlock.tabIndex = blockActive ? 0 : -1;
    }

    if (ui.panelManual) {
      ui.panelManual.classList.toggle("is-hidden", !manualActive);
      ui.panelManual.hidden = !manualActive;
      ui.panelManual.setAttribute("aria-hidden", manualActive ? "false" : "true");
    }

    if (ui.panelBlock) {
      ui.panelBlock.classList.toggle("is-hidden", !blockActive);
      ui.panelBlock.hidden = !blockActive;
      ui.panelBlock.setAttribute("aria-hidden", blockActive ? "false" : "true");
    }

    if (blockActive) {
      scheduleBlocklyResize();
    }
  }

  function scheduleBlocklyResize() {
    if (!state.workspace) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (!state.workspace || state.activeTab !== WORKSPACE_TAB.BLOCK) {
        return;
      }
      Blockly.svgResize(state.workspace);

      window.setTimeout(() => {
        if (!state.workspace || state.activeTab !== WORKSPACE_TAB.BLOCK) {
          return;
        }
        Blockly.svgResize(state.workspace);
      }, 120);
    });
  }

  function wireKeyboardShortcuts() {
    document.addEventListener("keydown", async (event) => {
      const key = String(event.key || "").toLowerCase();
      if (hasOpenDialog()) {
        return;
      }

      const hasCommandModifier = event.ctrlKey || event.metaKey;
      const isTyping = isTypingTarget(event.target);

      if (hasCommandModifier && !event.altKey && !event.shiftKey && key === "1" && !isTyping) {
        event.preventDefault();
        setActiveTab(readShortcutWorkspaceTab("1"));
        return;
      }

      if (hasCommandModifier && !event.altKey && !event.shiftKey && key === "2" && !isTyping) {
        event.preventDefault();
        setActiveTab(readShortcutWorkspaceTab("2"));
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

      if (event.key === "Escape") {
        if (event.repeat) {
          return;
        }
        event.preventDefault();
        ui.btnEmergencyStop.click();
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
        if (state.activeTab !== WORKSPACE_TAB.BLOCK) {
          return;
        }
        if (ui.btnRun && ui.btnRun.disabled) {
          return;
        }
        if (!state.runner.isRunning()) {
          await runProgram();
        }
      }
    });
  }

  async function handleConnectToggle() {
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

    if (state.serial.isConnected() && !ensureMotionAllowed()) {
      updateProgramControlUi();
      return false;
    }

    clearPendingManualSends();
    clearManualSessionState();
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
    clearManualSessionState();

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
            const servoName = SERVO_NAMES[servo] || `Servo ${servo}`;
            setProgramStatus(`Manual move applied: ${servoName} ${angle} deg`);
          }
        } catch (error) {
          const servoName = SERVO_NAMES[servo] || `Servo ${servo}`;
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
  }

  function startManualSession(servo) {
    clearTimeout(state.manualControl.releaseTimer);
    state.manualControl.releaseTimer = null;
    state.manualControl.activeServo = servo;
    state.manualControl.sessionToken += 1;
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
      state.manualControl.activeServo = null;
      if (!state.runner.isRunning()) {
        setControlOwner(CONTROL_OWNER.IDLE);
      }
    }, delayMs);
  }

  function clearManualSessionState() {
    clearTimeout(state.manualControl.releaseTimer);
    state.manualControl.releaseTimer = null;
    state.manualControl.activeServo = null;
    state.manualControl.sessionToken += 1;
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
    const sliders = document.querySelectorAll(".servo-slider");
    sliders.forEach((slider) => {
      slider.disabled = locked;
    });

    if (ui.motorsEnabled) {
      ui.motorsEnabled.disabled = false;
    }

    if (ui.btnResetDefault) {
      ui.btnResetDefault.disabled = locked;
    }

    if (ui.manualControlsCard) {
      ui.manualControlsCard.classList.toggle("is-locked", locked);
      if (locked) {
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
    state.angles = nextAngles.slice(0, 6).map((value, index) => clampAngle(index, value));

    if (options.syncSliders) {
      for (let servo = 0; servo < 6; servo += 1) {
        const slider = document.getElementById(`slider${servo}`);
        if (slider) {
          slider.value = String(state.angles[servo]);
          updateSliderFill(slider);
        }
        updateSliderValue(servo, state.angles[servo]);
      }
    }

    if (state.preview) {
      state.preview.setAngles(state.angles);
    }

    updateMotorDebugUi();
  }

  function syncSliderLimitsFromJointLimits() {
    for (let servo = 0; servo < 6; servo += 1) {
      const slider = document.getElementById(`slider${servo}`);
      if (!slider) {
        continue;
      }

      const limits = JOINT_LIMITS[servo] || [0, 180];
      const min = Number(limits[0]);
      const max = Number(limits[1]);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        continue;
      }

      slider.min = String(min);
      slider.max = String(max);
      slider.setAttribute("aria-valuemin", String(min));
      slider.setAttribute("aria-valuemax", String(max));

      const nextAngle = clampAngle(servo, Number.parseInt(slider.value, 10));
      slider.value = String(nextAngle);
      updateSliderValue(servo, nextAngle);
      updateSliderFill(slider);
    }
  }

  function updateSliderValue(servo, angle) {
    const slider = document.getElementById(`slider${servo}`);
    const valueEl = document.getElementById(`val${servo}`);
    if (valueEl) {
      const limits = JOINT_LIMITS[servo] || [0, 180];
      const min = Number(limits[0]);
      const max = Number(limits[1]);
      let pct = 0;
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        pct = Math.round(((angle - min) / (max - min)) * 100);
      }
      pct = Math.min(100, Math.max(0, pct));
      valueEl.textContent = `${angle}\u00B0`;
      valueEl.title = `Range ${min}..${max} deg`;
      if (slider) {
        slider.setAttribute("aria-valuenow", String(angle));
        slider.setAttribute("aria-valuetext", `${angle} degrees (${pct}% of range)`);
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
    if (!ui.programStatusIcon || !window.lucide) {
      return;
    }
    ui.programStatusIcon.setAttribute("data-lucide", iconName);
    ui.programStatusIcon.classList.toggle("is-running", Boolean(isRunning));
    ui.programStatusIcon.classList.toggle("is-error", Boolean(isError));
    ui.programStatusIcon.classList.toggle("is-warning", Boolean(isWarning));
    lucide.createIcons({ nodes: [ui.programStatusIcon] });
  }

  function setConnectionStatus(connected, text) {
    ui.statusDot.classList.toggle("is-connected", connected);
    ui.statusDot.classList.remove("is-connecting");
    ui.statusText.textContent = text || (connected ? "Connected" : "Disconnected");
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
        note: `${SERVO_NAMES[servo]} to ${angle} deg @${speed}`
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
    const activeText = activeServos.length > 0 ? activeServos.map((servo) => SERVO_NAMES[servo]).join(", ") : "None";
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
    for (let servo = 0; servo < 6; servo += 1) {
      const limits = JOINT_LIMITS[servo] || [0, 180];
      const angle = state.angles[servo];
      if (!Number.isFinite(angle)) {
        continue;
      }
      if (angle <= limits[0]) {
        nearLimit.push(`${SERVO_NAMES[servo]} min (${angle})`);
      } else if (angle >= limits[1]) {
        nearLimit.push(`${SERVO_NAMES[servo]} max (${angle})`);
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
    const activeText = activeServos.length > 0 ? activeServos.map((servo) => SERVO_NAMES[servo]).join(", ") : "None";
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
      setActiveTab(WORKSPACE_TAB.BLOCK);
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
    const limits = JOINT_LIMITS[servo] || [0, 180];
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
