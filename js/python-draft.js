(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const HOME_ANGLES = [90, 90, 90, 90, 90, 90];
  const JOINT_LIMITS = NS.Generator ? NS.Generator.JOINT_LIMITS : [[20, 130], [15, 165], [0, 180], [0, 180], [0, 180], [25, 130]];
  const JOINT_NAMES = ["Base", "Shoulder", "Elbow", "Wrist Rot", "Wrist Tilt", "Gripper"];
  const MOTORS_STORAGE_KEY = "roboadmin.motorsEnabled.v1";
  const PREVIEW_MODE_STORAGE_KEY = "roboadmin.pythonPreviewMode.v1";
  const OUTPUT_PANEL_COLLAPSED_STORAGE_KEY = "roboadmin.pythonOutputPanelCollapsed.v1";
  const PYTHON_SPLIT_LEFT_STORAGE_KEY = "roboadmin.pythonSplitLeftPercent.v1";
  const PYTHON_SPLIT_RIGHT_STORAGE_KEY = "roboadmin.pythonSplitRightPercent.v1";
  const PYTHON_SPLIT_DEFAULT_LEFT = 40.7;
  const PYTHON_SPLIT_DEFAULT_RIGHT = 77.5;
  const PYTHON_SPLIT_PANEL_MIN_PERCENT = 18;
  const PYTHON_SPLIT_PANEL_MAX_PERCENT = 58;
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

  const state = {
    angles: HOME_ANGLES.slice(),
    poses: {},
    workspace: null,
    serial: null,
    preview2d: null,
    preview3d: null,
    previewSketch2d: null,
    previewMode: "current",
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
    pythonSplitLeftPercent: PYTHON_SPLIT_DEFAULT_LEFT,
    pythonSplitRightPercent: PYTHON_SPLIT_DEFAULT_RIGHT,
    activeSplitter: null,
    resizeQueued: false,
    outputPanelCollapsed: true
  };

  const ui = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheUi();
    setupEditor();
    state.pythonSplitLeftPercent = readStoredPythonSplitLeft(PYTHON_SPLIT_DEFAULT_LEFT);
    state.pythonSplitRightPercent = readStoredPythonSplitRight(PYTHON_SPLIT_DEFAULT_RIGHT);
    state.outputPanelCollapsed = readStoredOutputPanelCollapsed(true);
    applyPythonSplitLayout({ persist: false });
    setOutputPanelCollapsed(state.outputPanelCollapsed, { persist: false, updateState: false });

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
    const ArmPreview2D = previewRegistry.ArmPreview2D || NS.ArmPreview;
    if (typeof ArmPreview2D === "function" && ui.armSvg) {
      state.preview2d = new ArmPreview2D(ui.armSvg, {
        jointLimits: JOINT_LIMITS,
        initialAngles: state.angles
      });
      state.preview2d.setInteractive(false);
    }
    if (typeof previewRegistry.ArmPreview3D === "function" && ui.arm3dFallbackSvg) {
      state.preview3d = new previewRegistry.ArmPreview3D(ui.arm3dFallbackSvg, {
        jointLimits: JOINT_LIMITS,
        initialAngles: state.angles,
        cameraPreset: "compact"
      });
    }
    if (!state.preview3d && typeof NS.ArmPreviewSketch3D === "function" && ui.armSketchSvg) {
      state.previewSketch2d = new NS.ArmPreviewSketch3D(ui.armSketchSvg, {
        jointLimits: JOINT_LIMITS,
        initialAngles: state.angles
      });
      state.previewSketch2d.setInteractive(false);
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
    state.previewMode = readPreviewMode();

    wireSerialEvents();
    wireRunnerEvents();
    wireButtons();
    wireSplitters();
    createPythonWorker();
    loadInitialWorkspace();
    applyAngles(state.angles, { source: "init" });
    syncPreviewModeUi();
    schedulePreviewAvailabilityChecks();
    syncMotorsToggleUi();
    updateRunControls();
    appendOutput("Python runtime loading...");

    window.addEventListener("resize", scheduleLayoutRefresh);

    if (!state.serial.supportsWebSerial()) {
      ui.btnConnect.disabled = true;
      setConnectionStatus(false, "Web Serial unavailable");
    }
  }

  function cacheUi() {
    ui.pythonDraft = document.querySelector(".python-draft");
    ui.statusDot = document.getElementById("statusDot");
    ui.statusText = document.getElementById("statusText");
    ui.programStatus = document.getElementById("programStatus");
    ui.programStatusIcon = document.getElementById("programStatusIcon");
    ui.btnConnect = document.getElementById("btnConnect");
    ui.btnHome = document.getElementById("btnHome");
    ui.btnEmergencyStop = document.getElementById("btnEmergencyStop");
    ui.btnMainPage = document.getElementById("btnMainPage");

    ui.toolbox = document.getElementById("pythonToolbox");
    ui.blocklyDiv = document.getElementById("pythonBlocklyDiv");
    ui.pythonEditor = document.getElementById("pythonEditor");
    ui.pythonRuntimeStatus = document.getElementById("pythonRuntimeStatus");
    ui.effectStatus = document.getElementById("pythonEffectStatus");
    ui.commandSummary = document.getElementById("pythonCommandSummary");
    ui.outputLog = document.getElementById("pythonOutputLog");
    ui.serialLog = document.getElementById("pythonSerialLog");
    ui.armSvg = document.getElementById("pythonArmSvg");
    ui.armSketchSvg = document.getElementById("pythonArmSketchSvg");
    ui.arm3dFallbackSvg = document.getElementById("pythonArm3dFallbackSvg");
    ui.previewCurrentPanel = document.getElementById("pythonPreviewCurrentPanel");
    ui.previewSketchPanel = document.getElementById("pythonPreviewSketchPanel");
    ui.btnPreviewCurrent = document.getElementById("btnPreviewCurrent");
    ui.btnPreviewSketch = document.getElementById("btnPreviewSketch");
    ui.outputPanelToggle = document.getElementById("btnOutputPanelToggle");
    ui.outputPanelBody = document.getElementById("pythonOutputPanelBody");
    ui.leftSplitter = document.querySelector('[data-python-splitter="left"]');
    ui.rightSplitter = document.querySelector('[data-python-splitter="right"]');
    ui.motorsEnabled = document.getElementById("pythonMotorsEnabled");
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
    ui.jointValues = [];
    for (let servo = 0; servo < 6; servo += 1) {
      ui.jointValues.push(document.getElementById(`pythonJointValue${servo}`));
    }
  }

  function setupEditor() {
    if (!window.CodeMirror || !ui.pythonEditor) {
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
  }

  function getPythonEditorValue() {
    return state.editor ? state.editor.getValue() : (ui.pythonEditor.value || "");
  }

  function setPythonEditorValue(code) {
    if (state.editor) {
      state.editor.setValue(code || "");
      window.requestAnimationFrame(() => state.editor.refresh());
      return;
    }
    ui.pythonEditor.value = code || "";
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
      if (angles) {
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
        setStatus(`Runner error: ${error.message || error}`);
      }
      state.controlOwner = CONTROL_OWNER.IDLE;
      updateRunControls();
    });
  }

  function wireButtons() {
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
    });

    if (ui.btnSaveBlocks) {
      ui.btnSaveBlocks.addEventListener("click", () => {
        void saveBlocksToFile();
      });
    }

    if (ui.btnLoadUserBlocks) {
      ui.btnLoadUserBlocks.addEventListener("click", () => {
        void loadBlocksFromFile();
      });
    }

    ui.btnClearWorkspace.addEventListener("click", () => {
      state.workspace.clear();
      state.blockReferenceCommands = null;
      state.lastGeneratedPython = "";
      updateEffectStatus("Build blocks, then convert to Python.", "ready");
      setStatus("Workspace cleared");
    });

    if (ui.btnSavePython) {
      ui.btnSavePython.addEventListener("click", () => {
        void savePythonToFile();
      });
    }

    if (ui.btnLoadPython) {
      ui.btnLoadPython.addEventListener("click", () => {
        void loadPythonFromFile();
      });
    }

    ui.btnCopyPython.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getPythonEditorValue());
        setStatus("Python copied");
      } catch (error) {
        setStatus("Copy failed (clipboard permission)");
      }
    });

    ui.btnClearOutput.addEventListener("click", () => {
      state.outputLines = [];
      ui.outputLog.textContent = "";
      setStatus("Python output cleared");
    });

    if (ui.outputPanelToggle) {
      ui.outputPanelToggle.addEventListener("click", () => {
        setOutputPanelCollapsed(!state.outputPanelCollapsed, { persist: true });
      });
    }

    if (ui.btnPreviewCurrent) {
      ui.btnPreviewCurrent.addEventListener("click", () => setPreviewMode("current"));
    }

    if (ui.btnPreviewSketch) {
      ui.btnPreviewSketch.addEventListener("click", () => setPreviewMode("sketch"));
    }
  }

  function createPythonWorker() {
    if (state.pythonWorker) {
      state.pythonWorker.terminate();
    }

    state.pythonRuntimeReady = false;
    state.pythonWorker = new Worker("js/python-worker.js");
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
        initialAngles: state.angles,
        jointLimits: JOINT_LIMITS,
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
      setPythonEditorValue(emitted.code);
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
    if (state.serial.isConnected() && !ensureMotionAllowed()) {
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
    if (!Array.isArray(rawCommands)) {
      throw new Error("Python did not return a command list.");
    }
    if (rawCommands.length > MAX_PYTHON_COMMANDS) {
      throw new Error(`Python returned too many commands (${rawCommands.length}/${MAX_PYTHON_COMMANDS}).`);
    }

    return rawCommands.map((command, index) => validatePythonCommand(command, index));
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
      return { type };
    });
  }

  async function handleConnectToggle() {
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
    try {
      if (state.serial.isConnected()) {
        await state.serial.emergencyStop();
      }
      await setMotorsEnabled(false, { sendCommand: false });
      setStatus("Emergency stop triggered");
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
    state.angles = nextAngles.slice(0, 6).map((value, index) => clampAngle(index, value));
    if (state.preview2d) {
      state.preview2d.setAngles(state.angles);
    }
    if (state.preview3d) {
      state.preview3d.setAngles(state.angles);
    }
    if (state.previewSketch2d) {
      state.previewSketch2d.setAngles(state.angles);
    }
    for (let servo = 0; servo < 6; servo += 1) {
      const valueEl = ui.jointValues[servo];
      if (valueEl) {
        valueEl.textContent = `${state.angles[servo]} deg`;
      }
    }
  }

  function setPreviewMode(mode) {
    state.previewMode = normalizePreviewMode(mode);
    try {
      localStorage.setItem(previewModeStorageKey(), state.previewMode);
    } catch (error) {
      // Persistence is optional; the visual toggle still works.
    }
    syncPreviewModeUi();
  }

  function syncPreviewModeUi() {
    state.previewMode = normalizePreviewMode(state.previewMode);
    const use3d = state.previewMode === "sketch3d" && is3dPreviewSupported();
    const useLegacySketch = state.previewMode === "sketch" && isLegacySketchPreviewAvailable();
    if (ui.previewSketchPanel) {
      ui.previewSketchPanel.toggleAttribute("hidden", !use3d);
    }
    if (ui.previewCurrentPanel) {
      ui.previewCurrentPanel.toggleAttribute("hidden", Boolean(use3d));
    }
    if (ui.armSvg && !ui.previewCurrentPanel) {
      ui.armSvg.toggleAttribute("hidden", useLegacySketch);
    }
    if (ui.armSketchSvg) {
      ui.armSketchSvg.toggleAttribute("hidden", !useLegacySketch);
    }
    syncPreviewModeButton(ui.btnPreviewSketch, Boolean(use3d || useLegacySketch));
    syncPreviewModeButton(ui.btnPreviewCurrent, !use3d && !useLegacySketch);
    if (ui.btnPreviewSketch) {
      const available = preferredSketchMode() !== "current";
      ui.btnPreviewSketch.disabled = !available;
      ui.btnPreviewSketch.classList.toggle("is-unavailable", !available);
      if (!available) {
        ui.btnPreviewSketch.title = "3D unavailable";
        ui.btnPreviewSketch.dataset.hint = "3D unavailable";
      } else {
        ui.btnPreviewSketch.title = "3D Sketch";
        ui.btnPreviewSketch.dataset.hint = "3D Sketch";
      }
    }
    if (use3d && state.preview3d && typeof state.preview3d.resize === "function") {
      window.requestAnimationFrame(() => state.preview3d.resize());
    }
  }

  function syncPreviewModeButton(button, active) {
    if (!button) {
      return;
    }
    button.classList.toggle("is-active", Boolean(active));
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }

  function is3dPreviewAvailable() {
    return Boolean(state.preview3d && state.preview3d.ready && !state.preview3d.fallback);
  }

  function is3dPreviewSupported() {
    return Boolean(state.preview3d && !state.preview3d.fallback);
  }

  function isLegacySketchPreviewAvailable() {
    return Boolean(state.previewSketch2d);
  }

  function preferredSketchMode() {
    if (is3dPreviewSupported()) {
      return "sketch3d";
    }
    if (isLegacySketchPreviewAvailable()) {
      return "sketch";
    }
    return "current";
  }

  function schedulePreviewAvailabilityChecks() {
    [0, 1200, 3600].forEach((delay) => {
      window.setTimeout(() => {
        if (state.previewMode === "sketch3d" && !is3dPreviewSupported()) {
          state.previewMode = "current";
          try {
            localStorage.setItem(previewModeStorageKey(), state.previewMode);
          } catch (error) {
            // Persistence is optional; the fallback still applies.
          }
        }
        syncPreviewModeUi();
      }, delay);
    });
  }

  function normalizePreviewMode(mode) {
    if (mode === "current") {
      return "current";
    }
    if (mode === "sketch3d" && is3dPreviewSupported()) {
      return "sketch3d";
    }
    if (mode === "sketch" && isLegacySketchPreviewAvailable()) {
      return "sketch";
    }
    return preferredSketchMode();
  }

  function loadInitialWorkspace(options = {}) {
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
      setStatus("Loaded example: Wave Hello");
      updateEffectStatus("Build blocks, then convert to Python.", "ready");
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
      suggestedName: `robobuddy-python-${slugTimestamp()}.py`,
      accept: PYTHON_FILE_ACCEPT,
      description: "Python code",
      mimeType: "text/plain;charset=utf-8"
    });
    if (!result.ok) {
      setStatus(result.canceled ? "Python save canceled." : `Python save failed: ${result.error ? result.error.message || result.error : "unknown error"}`);
      return;
    }
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
    setPythonEditorValue(result.text);
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

  function wireSplitters() {
    document.querySelectorAll("[data-python-splitter]").forEach((splitter) => {
      splitter.addEventListener("pointerdown", handleSplitterPointerDown);
      splitter.addEventListener("pointermove", handleSplitterPointerMove);
      splitter.addEventListener("pointerup", endSplitterDrag);
      splitter.addEventListener("pointercancel", endSplitterDrag);
      splitter.addEventListener("lostpointercapture", endSplitterDrag);
      splitter.addEventListener("keydown", handleSplitterKeydown);
    });
    document.addEventListener("pointermove", handleSplitterPointerMove);
    document.addEventListener("pointerup", endSplitterDrag);
    document.addEventListener("pointercancel", endSplitterDrag);
  }

  function applyPythonSplitLayout(options = {}) {
    const normalized = normalizePythonSplits(
      readStoredPythonSplitLeft(state.pythonSplitLeftPercent),
      readStoredPythonSplitRight(state.pythonSplitRightPercent)
    );
    state.pythonSplitLeftPercent = normalized.left;
    state.pythonSplitRightPercent = normalized.right;
    applyPythonSplitCss();
    updateSplitterA11y();
    if (options.persist) {
      persistPythonSplitLayout();
    }
  }

  function setPythonSplit(left, right, options = {}) {
    const next = normalizePythonSplits(left, right);
    state.pythonSplitLeftPercent = next.left;
    state.pythonSplitRightPercent = next.right;
    applyPythonSplitCss();
    updateSplitterA11y();
    if (options.persist !== false) {
      persistPythonSplitLayout();
    }
    scheduleLayoutRefresh();
  }

  function applyPythonSplitCss() {
    if (!ui.pythonDraft) {
      return;
    }
    ui.pythonDraft.style.setProperty("--python-split-left", `${state.pythonSplitLeftPercent}%`);
    ui.pythonDraft.style.setProperty("--python-split-mid", `${state.pythonSplitRightPercent}%`);
  }

  function persistPythonSplitLayout() {
    try {
      localStorage.setItem(PYTHON_SPLIT_LEFT_STORAGE_KEY, String(state.pythonSplitLeftPercent));
      localStorage.setItem(PYTHON_SPLIT_RIGHT_STORAGE_KEY, String(state.pythonSplitRightPercent));
    } catch (error) {
      // Split persistence is optional; the live resize should keep working.
    }
  }

  function normalizePythonSplits(left, right) {
    let leftPercent = clampNumber(left, PYTHON_SPLIT_PANEL_MIN_PERCENT, PYTHON_SPLIT_PANEL_MAX_PERCENT);
    let rightPercent = clampNumber(right, PYTHON_SPLIT_PANEL_MIN_PERCENT * 2, 100 - PYTHON_SPLIT_PANEL_MIN_PERCENT);
    rightPercent = clampNumber(
      rightPercent,
      leftPercent + PYTHON_SPLIT_PANEL_MIN_PERCENT,
      Math.min(leftPercent + PYTHON_SPLIT_PANEL_MAX_PERCENT, 100 - PYTHON_SPLIT_PANEL_MIN_PERCENT)
    );
    leftPercent = clampNumber(
      leftPercent,
      Math.max(PYTHON_SPLIT_PANEL_MIN_PERCENT, rightPercent - PYTHON_SPLIT_PANEL_MAX_PERCENT),
      rightPercent - PYTHON_SPLIT_PANEL_MIN_PERCENT
    );
    return {
      left: Math.round(leftPercent * 10) / 10,
      right: Math.round(rightPercent * 10) / 10
    };
  }

  function updateSplitterA11y() {
    const leftPanel = state.pythonSplitLeftPercent;
    const middlePanel = state.pythonSplitRightPercent - state.pythonSplitLeftPercent;

    if (ui.leftSplitter) {
      ui.leftSplitter.setAttribute("aria-valuemin", String(PYTHON_SPLIT_PANEL_MIN_PERCENT));
      ui.leftSplitter.setAttribute("aria-valuemax", String(Math.min(PYTHON_SPLIT_PANEL_MAX_PERCENT, state.pythonSplitRightPercent - PYTHON_SPLIT_PANEL_MIN_PERCENT)));
      ui.leftSplitter.setAttribute("aria-valuenow", String(leftPanel));
      ui.leftSplitter.setAttribute("aria-valuetext", `Blockly ${leftPanel} percent`);
    }

    if (ui.rightSplitter) {
      ui.rightSplitter.setAttribute("aria-valuemin", String(Math.max(state.pythonSplitLeftPercent + PYTHON_SPLIT_PANEL_MIN_PERCENT, 100 - PYTHON_SPLIT_PANEL_MAX_PERCENT)));
      ui.rightSplitter.setAttribute("aria-valuemax", String(100 - PYTHON_SPLIT_PANEL_MIN_PERCENT));
      ui.rightSplitter.setAttribute("aria-valuenow", String(state.pythonSplitRightPercent));
      ui.rightSplitter.setAttribute("aria-valuetext", `Python ${Math.round(middlePanel * 10) / 10} percent`);
    }
  }

  function splitterPointerPosition(event) {
    if (!ui.pythonDraft) {
      return null;
    }
    const bounds = ui.pythonDraft.getBoundingClientRect();
    if (!bounds.width) {
      return null;
    }
    return (event.clientX - bounds.left) / bounds.width * 100;
  }

  function handleSplitterPointerDown(event) {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    const splitter = event.currentTarget;
    const key = splitter.getAttribute("data-python-splitter");
    if (key !== "left" && key !== "right") {
      return;
    }
    state.activeSplitter = {
      key,
      pointerId: event.pointerId
    };
    splitter.classList.add("is-active");
    if (splitter.setPointerCapture) {
      splitter.setPointerCapture(event.pointerId);
    }
    document.body.classList.add("is-resizing-python");
    event.preventDefault();
    event.stopPropagation();
  }

  function handleSplitterPointerMove(event) {
    if (!state.activeSplitter) {
      return;
    }
    if (
      Number.isFinite(state.activeSplitter.pointerId) &&
      Number.isFinite(event.pointerId) &&
      event.pointerId !== state.activeSplitter.pointerId
    ) {
      return;
    }
    const percent = splitterPointerPosition(event);
    if (percent === null) {
      return;
    }
    if (state.activeSplitter.key === "left") {
      setPythonSplit(percent, state.pythonSplitRightPercent, { persist: false });
    } else {
      setPythonSplit(state.pythonSplitLeftPercent, percent, { persist: false });
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function endSplitterDrag(event) {
    if (!state.activeSplitter) {
      return;
    }
    if (
      Number.isFinite(state.activeSplitter.pointerId) &&
      event &&
      Number.isFinite(event.pointerId) &&
      event.pointerId !== state.activeSplitter.pointerId
    ) {
      return;
    }
    const activeSplitterNode = document.querySelector(`[data-python-splitter="${state.activeSplitter.key}"]`);
    if (activeSplitterNode) {
      activeSplitterNode.classList.remove("is-active");
      if (event && event.pointerId !== undefined && activeSplitterNode.hasPointerCapture && activeSplitterNode.hasPointerCapture(event.pointerId)) {
        activeSplitterNode.releasePointerCapture(event.pointerId);
      }
    }
    persistPythonSplitLayout();
    state.activeSplitter = null;
    document.body.classList.remove("is-resizing-python");
    scheduleLayoutRefresh();
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleSplitterKeydown(event) {
    const key = event.key;
    const isArrow = key === "ArrowLeft" || key === "ArrowRight";
    if (!isArrow && key !== "Home" && key !== "End") {
      return;
    }
    const splitter = event.currentTarget.getAttribute("data-python-splitter");
    let nextLeft = state.pythonSplitLeftPercent;
    let nextRight = state.pythonSplitRightPercent;
    const step = event.shiftKey ? 10 : 1;
    if (key === "Home") {
      if (splitter === "left") {
        nextLeft = PYTHON_SPLIT_PANEL_MIN_PERCENT;
      } else {
        nextRight = state.pythonSplitLeftPercent + PYTHON_SPLIT_PANEL_MIN_PERCENT;
      }
    } else if (key === "End") {
      if (splitter === "left") {
        nextLeft = Math.min(
          state.pythonSplitRightPercent - PYTHON_SPLIT_PANEL_MIN_PERCENT,
          PYTHON_SPLIT_PANEL_MAX_PERCENT
        );
      } else {
        nextRight = 100 - PYTHON_SPLIT_PANEL_MIN_PERCENT;
      }
    } else if (key === "ArrowLeft") {
      if (splitter === "left") {
        nextLeft = state.pythonSplitLeftPercent - step;
      } else {
        nextRight = state.pythonSplitRightPercent - step;
      }
    } else if (splitter === "left") {
      nextLeft = state.pythonSplitLeftPercent + step;
    } else {
      nextRight = state.pythonSplitRightPercent + step;
    }
    setPythonSplit(nextLeft, nextRight, { persist: true });
    event.preventDefault();
    event.stopPropagation();
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
    const connected = state.serial.isConnected();
    const span = ui.btnConnect.querySelector("span");
    if (span) {
      span.textContent = connected ? "Disconnect" : "Connect";
    }
    const icon = ui.btnConnect.querySelector("[data-lucide]");
    if (icon && window.lucide) {
      icon.setAttribute("data-lucide", connected ? "unlink" : "plug");
      lucide.createIcons({ nodes: [icon] });
    }
  }

  function syncMotorsToggleUi() {
    ui.motorsEnabled.checked = state.motorsEnabled;
    updateRunControls();
  }

  function readMotorsEnabled() {
    const raw = localStorage.getItem(MOTORS_STORAGE_KEY);
    return raw === "1" || raw === "true";
  }

  function readPreviewMode() {
    const fallback = defaultPreviewMode();
    try {
      const raw = localStorage.getItem(previewModeStorageKey());
      return raw ? normalizePreviewMode(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function previewModeStorageKey() {
    return document.body && document.body.dataset.previewStorageKey
      ? document.body.dataset.previewStorageKey
      : PREVIEW_MODE_STORAGE_KEY;
  }

  function defaultPreviewMode() {
    const defaultMode = document.body ? document.body.dataset.defaultPreviewMode : "";
    return defaultMode === "sketch" ? preferredSketchMode() : "current";
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
      const icon = ui.outputPanelToggle.querySelector("[data-lucide]");
      if (icon && window.lucide) {
        icon.setAttribute("data-lucide", nextCollapsed ? "chevron-right" : "chevron-down");
        lucide.createIcons({ nodes: [icon] });
      }
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

  function readStoredPythonSplitLeft(fallback) {
    return readStoredSplitPercent(PYTHON_SPLIT_LEFT_STORAGE_KEY, fallback);
  }

  function readStoredPythonSplitRight(fallback) {
    return readStoredSplitPercent(PYTHON_SPLIT_RIGHT_STORAGE_KEY, fallback);
  }

  function readStoredSplitPercent(storageKey, fallback) {
    let raw = "";
    try {
      raw = localStorage.getItem(storageKey) || "";
    } catch (error) {
      raw = "";
    }
    if (!raw.trim()) {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function setConnectionStatus(connected, text) {
    ui.statusDot.classList.toggle("is-connected", connected);
    ui.statusDot.classList.remove("is-connecting");
    ui.statusText.textContent = text || (connected ? "Connected" : "Disconnected");
  }

  function setStatus(text) {
    ui.programStatus.textContent = text;
  }

  function setPythonRuntimeStatus(text, tone) {
    ui.pythonRuntimeStatus.textContent = text;
    ui.pythonRuntimeStatus.dataset.tone = tone || "ready";
  }

  function updateEffectStatus(text, tone) {
    ui.effectStatus.textContent = text;
    ui.effectStatus.dataset.tone = tone || "ready";
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

  function clampNumber(value, min, max) {
    const parsed = Number(value);
    const fallback = Number.isFinite(min) ? min : 0;
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  function clampAngle(servo, angle) {
    const limits = JOINT_LIMITS[servo] || [0, 180];
    const value = Number(angle);
    const safe = Number.isFinite(value) ? Math.round(value) : limits[0];
    return Math.min(limits[1], Math.max(limits[0], safe));
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
