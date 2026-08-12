(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const PREFS_KEY = "robobuddy.virtualLeader.display.v1";
  const DIAGNOSTICS_SCHEMA = "robobuddy-virtual-leader-diagnostics-v1";
  const MAX_DIAGNOSTIC_EVENTS = 10000;
  const MAX_DIAGNOSTIC_AGE_MS = 15 * 60 * 1000;
  const CANCEL_REASONS = new Set([
    "pointer_cancelled", "focus_lost", "page_hidden", "escape", "mode_switch", "takeover",
    "disarm", "disconnect", "stale_input", "feedback_fault", "client_error"
  ]);

  const ui = {};
  const local = {
    initialized: false,
    mode: "joints",
    modeTransitioning: false,
    pair: "base",
    speed: "normal",
    visibility: { input: false, target: false, measured: true },
    deadman: false,
    driveSource: "",
    driveAttemptGeneration: 0,
    activeDriveAttempt: 0,
    pointerId: null,
    padVector: { x: 0, y: 0 },
    keyVector: { x: 0, y: 0 },
    precisionVector: { x: 0, y: 0 },
    gamepadVector: { x: 0, y: 0 },
    gamepadFine: false,
    gamepadSampleSequence: 0,
    gamepadConsumedSampleSequence: 0,
    gamepadIntegrationElapsedSeconds: 0,
    gamepadState: { phase: "off", reason: "", controllers: [], selectedIndex: null },
    gamepadController: null,
    gamepadControllersKey: "",
    gamepadFaultHandling: false,
    heldKeys: new Set(),
    inputPose: {},
    lastFrameAt: 0,
    lastCandidateAt: 0,
    animationFrame: null,
    releasing: false,
    recoveryTimer: null,
    recoveryStarting: false,
    recoveryKeyHeld: false,
    valuesJointKey: "",
    valuesRows: new Map(),
    measuredAgeSourceReceivedAt: null,
    measuredAgeLastRenderAt: -Infinity,
    detailsPinned: false,
    recoveryDetailsOpen: false,
    options: {}
  };

  const diagnosticEvents = [];
  const diagnosticsStartedAt = monotonicNow();
  const motionLockPrevious = new WeakMap();

  function virtualLeaderConfig() {
    const manifest = runtime() && runtime().getManifest ? runtime().getManifest() : null;
    return manifest && manifest.virtualLeader || {};
  }

  function pairsConfig() {
    return virtualLeaderConfig().pairs || {};
  }

  function speedsConfig() {
    return virtualLeaderConfig().speedLevels || {};
  }

  function gamepadProfile() {
    const registry = NS.RobotRegistry;
    const manifest = registry && typeof registry.get === "function"
      ? registry.get("so101_follower")
      : null;
    return manifest && manifest.virtualLeader && manifest.virtualLeader.gamepad || null;
  }

  function heartbeatAfterMs() {
    const configured = Number(virtualLeaderConfig().heartbeatAfterMs);
    return Number.isFinite(configured) && configured > 0 ? configured : 100;
  }

  function monotonicNow() {
    return window.performance && typeof window.performance.now === "function" ? window.performance.now() : 0;
  }

  function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function setBooleanProperty(element, property, value) {
    const next = Boolean(value);
    if (element && element[property] !== next) element[property] = next;
  }

  function setAttributeValue(element, name, value) {
    const next = String(value);
    if (element && element.getAttribute(name) !== next) element.setAttribute(name, next);
  }

  function sanitizeDiagnosticEvent(type, data = {}) {
    const safe = { type: String(type || "event").slice(0, 64), atMs: Math.max(0, Math.round(monotonicNow() - diagnosticsStartedAt)) };
    const stringFields = ["phase", "owner", "errorCode", "reason", "joint", "featureState"];
    const numberFields = ["durationMs", "sequence", "acceptedSequence", "observationAgeMs"];
    stringFields.forEach((key) => {
      if (typeof data[key] === "string") safe[key] = data[key].slice(0, 96);
    });
    numberFields.forEach((key) => {
      if (Number.isFinite(Number(data[key]))) safe[key] = Number(data[key]);
    });
    ["target", "measured"].forEach((key) => {
      if (data[key] && typeof data[key] === "object") {
        const pose = {};
        const pairs = pairsConfig();
        Object.keys(pairs).forEach((pairKey) => {
          const pair = pairs[pairKey];
          [pair.horizontal, pair.vertical].forEach((jointId) => {
            if (Number.isFinite(Number(data[key][jointId]))) pose[jointId] = Number(data[key][jointId]);
          });
        });
        safe[key] = pose;
      }
    });
    return safe;
  }

  function pruneDiagnostics() {
    const cutoff = Math.max(0, Math.round(monotonicNow() - diagnosticsStartedAt - MAX_DIAGNOSTIC_AGE_MS));
    while (diagnosticEvents.length && (diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS || diagnosticEvents[0].atMs < cutoff)) {
      diagnosticEvents.shift();
    }
  }

  function recordDiagnostic(type, data) {
    diagnosticEvents.push(sanitizeDiagnosticEvent(type, data));
    pruneDiagnostics();
  }

  function diagnosticsObject() {
    pruneDiagnostics();
    const runtimeState = runtime() && runtime().getState ? runtime().getState() : null;
    const availability = runtime() && runtime().getLeaderAvailability ? runtime().getLeaderAvailability() : { available: false };
    return {
      schema: DIAGNOSTICS_SCHEMA,
      appVersion: "2026.07.13",
      bridgeApiVersion: runtimeState && runtimeState.bridgeApiVersion || "",
      featureState: availability.simulation ? "simulation" : (availability.available ? "enabled" : "disabled"),
      durationMs: Math.max(0, Math.round(monotonicNow() - diagnosticsStartedAt)),
      eventCount: diagnosticEvents.length,
      events: diagnosticEvents.map((event) => ({ ...event }))
    };
  }

  function downloadDiagnostics() {
    const blob = new Blob([JSON.stringify(diagnosticsObject(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "robobuddy-virtual-leader-diagnostics-v1.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function runtime() {
    return NS.RobotRuntime;
  }

  function init(options = {}) {
    if (local.initialized) return;
    local.initialized = true;
    local.options = options;
    loadPreferences();
    cacheUi();
    wireUi();
    setMode("joints", { force: true, silent: true });
    window.addEventListener("robobuddy:robot-state-change", onRuntimeState);
    window.addEventListener("robobuddy:active-robot-change", () => {
      if (local.gamepadController) local.gamepadController.disable("robot_change");
      void setMode("joints", { force: true, silent: true });
    });
    window.addEventListener("resize", syncControlFocus);
    window.addEventListener("blur", () => {
      const state = runtime() && runtime().getState ? runtime().getState() : null;
      if (local.gamepadController && local.gamepadController.getState().enabled) local.gamepadController.disable("focus_lost");
      if (local.deadman || state && state.controlOwner === "range_recovery") void cancelDrive("focus_lost");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        const state = runtime() && runtime().getState ? runtime().getState() : null;
        const activeMotion = local.deadman || state && ["virtual_leader", "range_recovery"].includes(state.controlOwner);
        if (local.gamepadController && local.gamepadController.getState().enabled) local.gamepadController.disable("page_hidden");
        if (activeMotion) void cancelDrive("page_hidden", { keepalive: true });
        else if (runtime() && runtime().invalidateLeaderAlignment) runtime().invalidateLeaderAlignment("Page visibility changed.");
      }
    });
    bindRendererCallbacks();
    render(runtime() && runtime().getState ? runtime().getState() : null);
    recordDiagnostic("ui_ready", { featureState: "inactive" });
  }

  function cacheUi() {
    const byId = (id) => document.getElementById(id);
    ui.manualCard = document.querySelector(".index-3d-manual-card");
    ui.modeSelector = byId("manualModeSelector");
    ui.modeButtons = Array.from(document.querySelectorAll("[data-manual-mode-option]"));
    ui.leaderPanel = byId("virtualLeaderPanel");
    ui.jointsPanel = byId("manualJointsPanel");
    ui.teachPanel = byId("teachControlsPanel");
    ui.align = byId("leaderAlign");
    ui.cancel = byId("leaderCancel");
    ui.gamepadQuickEnable = byId("leaderGamepadQuickEnable");
    ui.status = byId("leaderStatus");
    ui.readinessTitle = byId("leaderReadinessTitle");
    ui.stateChip = byId("leaderStateChip");
    ui.pad = byId("leaderPad");
    ui.padThumb = byId("leaderPadThumb");
    ui.padHorizontal = byId("leaderPadHorizontal");
    ui.padVertical = byId("leaderPadVertical");
    ui.pairButtons = Array.from(document.querySelectorAll("[data-leader-pair]"));
    ui.speedButtons = Array.from(document.querySelectorAll("[data-leader-speed]"));
    ui.gamepad = byId("leaderGamepad");
    ui.gamepadState = byId("leaderGamepadState");
    ui.gamepadStatus = byId("leaderGamepadStatus");
    ui.gamepadEnable = byId("leaderGamepadEnable");
    ui.gamepadDisable = byId("leaderGamepadDisable");
    ui.gamepadPicker = byId("leaderGamepadPicker");
    ui.gamepadSelect = byId("leaderGamepadSelect");
    ui.gamepadUse = byId("leaderGamepadUse");
    ui.gamepadControllerName = byId("leaderGamepadControllerName");
    ui.gamepadPair = byId("leaderGamepadPair");
    ui.gamepadSpeed = byId("leaderGamepadSpeed");
    ui.gamepadFreshness = byId("leaderGamepadFreshness");
    ui.precisionButtons = Array.from(document.querySelectorAll("[data-leader-precision-axis]"));
    ui.precisionHorizontalLabel = byId("leaderPrecisionHorizontalLabel");
    ui.precisionVerticalLabel = byId("leaderPrecisionVerticalLabel");
    ui.precisionHorizontalValue = byId("leaderPrecisionHorizontalValue");
    ui.precisionVerticalValue = byId("leaderPrecisionVerticalValue");
    ui.values = byId("leaderValues");
    ui.valuesBody = byId("leaderValuesBody");
    ui.valuesFocus = byId("leaderValuesFocus");
    ui.layerControls = byId("leaderLayerControls");
    ui.layerButtons = Array.from(document.querySelectorAll("[data-leader-layer]"));
    ui.measuredAge = byId("leaderMeasuredAge");
    ui.owner = byId("leaderOwner");
    ui.frameRate = byId("leaderFrameRate");
    ui.recovery = byId("leaderRangeRecovery");
    ui.recoveryMessage = byId("leaderRangeRecoveryMessage");
    ui.recoveryHold = byId("leaderRangeRecoveryHold");
    ui.exportDiagnostics = byId("leaderExportDiagnostics");
    ui.openProgram = byId("leaderOpenProgramWorkspace");
    ui.home = byId("btnHome");
    ui.run = byId("btnRun");
  }

  function wireUi() {
    ui.align && ui.align.addEventListener("click", () => void align());
    ui.cancel && ui.cancel.addEventListener("click", () => void cancelDrive("client_error"));
    ui.pairButtons.forEach((button) => button.addEventListener("click", () => selectPair(button.dataset.leaderPair)));
    ui.speedButtons.forEach((button) => button.addEventListener("click", () => selectSpeed(button.dataset.leaderSpeed)));
    ui.layerButtons.forEach((button) => button.addEventListener("click", () => toggleLayer(button.dataset.leaderLayer)));
    ui.valuesFocus && ui.valuesFocus.addEventListener("click", () => {
      ui.values.open = true;
      ui.values.scrollIntoView({ block: "nearest", behavior: "smooth" });
      const summary = ui.values.querySelector("summary");
      if (summary) summary.focus();
    });
    ui.exportDiagnostics && ui.exportDiagnostics.addEventListener("click", downloadDiagnostics);
    wirePad();
    wirePrecision();
    wireKeyboard();
    wireRecovery();
    wireGamepad();
  }

  async function setMode(mode, options = {}) {
    const next = ["leader", "joints", "teach"].includes(mode) ? mode : "joints";
    if (local.modeTransitioning) return;
    if (!options.force && next === local.mode) return;
    if (local.mode === "leader" && next !== "leader") {
      local.modeTransitioning = true;
      renderGamepad();
      try {
        if (local.gamepadController) local.gamepadController.disable("mode_switch");
        stopInputLoop();
        if (runtime() && runtime().cancelRangeRecovery) {
          try { await runtime().cancelRangeRecovery("mode_switch"); } catch (error) { await emergencyFallback(error); }
        }
        if (runtime() && runtime().cancelLeaderSession) {
          try { await runtime().cancelLeaderSession("mode_switch"); } catch (error) { await emergencyFallback(error); }
        }
        if (runtime() && runtime().setLeaderMode) runtime().setLeaderMode(false);
      } finally {
        if (local.gamepadController) local.gamepadController.disable("mode_switch");
        local.modeTransitioning = false;
      }
    }
    local.mode = next;
    local.deadman = false;
    local.releasing = false;
    if (next === "leader" && runtime() && runtime().setLeaderMode) runtime().setLeaderMode(true);
    if (next === "leader" && runtime() && runtime().setLeaderLayerVisibility) runtime().setLeaderLayerVisibility(local.visibility);
    updateModeDom();
    syncControlFocus();
    bindRendererCallbacks();
    if (typeof local.options.onWorkspaceResize === "function") window.setTimeout(local.options.onWorkspaceResize, 0);
    if (!options.silent) recordDiagnostic("mode", { phase: next });
  }

  function updateModeDom() {
    const isSo101 = activeRobotId() === "so101_follower";
    if (ui.manualCard) {
      if (isSo101 && ui.manualCard.dataset.leaderLifecycleMode !== local.mode) ui.manualCard.dataset.leaderLifecycleMode = local.mode;
      else if (!isSo101 && ui.manualCard.dataset.leaderLifecycleMode) delete ui.manualCard.dataset.leaderLifecycleMode;
    }
    if (ui.layerControls) ui.layerControls.hidden = !isSo101;
  }

  function activeRobotId() {
    const state = runtime() && runtime().getState ? runtime().getState() : null;
    return state && state.robotId || "";
  }

  function syncControlFocus() {
  }

  async function align() {
    if (!runtime() || !runtime().alignLeaderToMeasured || local.releasing) return;
    ui.align.disabled = true;
    recordDiagnostic("align_start");
    try {
      const next = await runtime().alignLeaderToMeasured();
      local.inputPose = { ...(next.leaderControl && next.leaderControl.inputPose || {}) };
      recordDiagnostic("align_result", {
        phase: next.leaderControl && next.leaderControl.phase,
        observationAgeMs: next.observation && next.observation.ageMs,
        measured: next.leaderControl && next.leaderControl.measuredPose
      });
    } catch (error) {
      recordDiagnostic("align_error", { errorCode: error.code || "ALIGNMENT_FAILED" });
    } finally {
      render(runtime().getState());
    }
  }

  function wirePad() {
    if (!ui.pad) return;
    ui.pad.addEventListener("pointerdown", (event) => {
      if (local.deadman || event.button !== 0) return;
      event.preventDefault();
      local.pointerId = event.pointerId;
      local.driveSource = "pad";
      try { ui.pad.setPointerCapture(event.pointerId); } catch (error) { /* Pointer capture can be unavailable in synthetic events. */ }
      updatePadVector(event);
      void beginDrive("pad");
    });
    ui.pad.addEventListener("pointermove", (event) => {
      if (local.pointerId === event.pointerId) updatePadVector(event);
    });
    ui.pad.addEventListener("pointerup", (event) => {
      if (local.pointerId !== event.pointerId) return;
      local.pointerId = null;
      centerPad();
      void releaseDrive();
    });
    ["pointercancel", "lostpointercapture"].forEach((type) => ui.pad.addEventListener(type, (event) => {
      if (local.pointerId !== event.pointerId) return;
      local.pointerId = null;
      centerPad();
      void cancelDrive("pointer_cancelled");
    }));
    ui.pad.addEventListener("blur", () => {
      if (local.deadman && local.driveSource === "keyboard") void cancelDrive("focus_lost");
    });
  }

  function updatePadVector(event) {
    const rect = ui.pad.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
    const y = Math.max(-1, Math.min(1, -(((event.clientY - rect.top) / rect.height - 0.5) * 2)));
    const magnitude = Math.min(1, Math.hypot(x, y));
    const configuredDeadZone = Number(virtualLeaderConfig().deadZone);
    const deadZone = Number.isFinite(configuredDeadZone) ? configuredDeadZone : 0.12;
    if (magnitude <= deadZone) {
      local.padVector = { x: 0, y: 0 };
    } else {
      const response = Math.pow((magnitude - deadZone) / (1 - deadZone), 3);
      local.padVector = { x: x / magnitude * response, y: y / magnitude * response };
    }
    if (ui.padThumb) ui.padThumb.style.transform = `translate(${x * 42}px, ${-y * 42}px)`;
  }

  function centerPad() {
    local.padVector = { x: 0, y: 0 };
    local.precisionVector = { x: 0, y: 0 };
    if (ui.padThumb) ui.padThumb.style.transform = "translate(0, 0)";
  }

  function wirePrecision() {
    ui.precisionButtons.forEach((button) => {
      const setPrecisionVector = () => {
        const axis = button.dataset.leaderPrecisionAxis;
        const direction = Number(button.dataset.leaderDirection) || 0;
        local.precisionVector = axis === "horizontal" ? { x: direction * 0.35, y: 0 } : { x: 0, y: direction * 0.35 };
      };
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || local.deadman) return;
        event.preventDefault();
        try { button.setPointerCapture(event.pointerId); } catch (error) { /* Pointer capture can be unavailable in synthetic events. */ }
        local.pointerId = event.pointerId;
        local.driveSource = "precision";
        setPrecisionVector();
        void beginDrive("precision");
      });
      button.addEventListener("pointerup", (event) => {
        if (local.pointerId !== event.pointerId) return;
        local.pointerId = null;
        local.precisionVector = { x: 0, y: 0 };
        void releaseDrive();
      });
      ["pointercancel", "lostpointercapture"].forEach((type) => button.addEventListener(type, (event) => {
        if (local.pointerId !== event.pointerId) return;
        local.pointerId = null;
        local.precisionVector = { x: 0, y: 0 };
        void cancelDrive("pointer_cancelled");
      }));
      button.addEventListener("keydown", (event) => {
        if (!["Space", "Enter"].includes(event.code) || event.repeat || local.deadman) return;
        event.preventDefault();
        event.stopPropagation();
        local.driveSource = "precision";
        setPrecisionVector();
        void beginDrive("precision");
      });
      button.addEventListener("keyup", (event) => {
        if (!["Space", "Enter"].includes(event.code) || local.driveSource !== "precision") return;
        event.preventDefault();
        event.stopPropagation();
        local.precisionVector = { x: 0, y: 0 };
        void releaseDrive();
      });
      button.addEventListener("blur", () => {
        if (local.deadman && local.driveSource === "precision") void cancelDrive("focus_lost");
      });
    });
  }

  function wireKeyboard() {
    if (!ui.leaderPanel) return;
    ui.leaderPanel.addEventListener("keydown", (event) => {
      if (local.mode !== "leader") return;
      if (["1", "2", "3"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        selectPair({ 1: "base", 2: "bend", 3: "tool" }[event.key]);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault(); event.stopPropagation();
        selectSpeed(local.speed === "fine" ? "normal" : "coarse");
        return;
      }
      if (event.key === "-") {
        event.preventDefault(); event.stopPropagation();
        selectSpeed(local.speed === "coarse" ? "normal" : "fine");
        return;
      }
      const deadmanFocused = event.target === ui.pad;
      if (event.code === "Space" && !event.repeat && deadmanFocused) {
        event.preventDefault(); event.stopPropagation();
        local.driveSource = "keyboard";
        void beginDrive("keyboard");
        return;
      }
      if (event.key === "Shift" && deadmanFocused) {
        local.heldKeys.add("Shift");
        return;
      }
      if (deadmanFocused && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        local.heldKeys.add(event.key);
        updateKeyVector();
      }
    });
    ui.leaderPanel.addEventListener("keyup", (event) => {
      const deadmanFocused = event.target === ui.pad;
      if (event.code === "Space" && deadmanFocused) {
        event.preventDefault(); event.stopPropagation();
        local.heldKeys.clear();
        updateKeyVector();
        void releaseDrive();
        return;
      }
      if (event.key === "Shift" && deadmanFocused) {
        local.heldKeys.delete("Shift");
        return;
      }
      if (deadmanFocused && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        local.heldKeys.delete(event.key);
        updateKeyVector();
      }
    });
  }

  function updateKeyVector() {
    local.keyVector = {
      x: (local.heldKeys.has("ArrowRight") ? 1 : 0) - (local.heldKeys.has("ArrowLeft") ? 1 : 0),
      y: (local.heldKeys.has("ArrowUp") ? 1 : 0) - (local.heldKeys.has("ArrowDown") ? 1 : 0)
    };
  }

  async function beginDrive(source) {
    if (local.deadman || local.releasing || !runtime()) return false;
    const runtimeState = runtime().getState();
    const leader = runtimeState && runtimeState.leaderControl;
    if (!leader || !leader.aligned || leader.phase !== "ready") {
      centerPad();
      announce("Align to the measured pose before driving.");
      return false;
    }
    local.deadman = true;
    local.driveSource = source;
    const attempt = ++local.driveAttemptGeneration;
    local.activeDriveAttempt = attempt;
    local.inputPose = { ...leader.inputPose };
    local.lastFrameAt = monotonicNow();
    local.lastCandidateAt = local.lastFrameAt;
    if (source === "gamepad") {
      local.gamepadConsumedSampleSequence = local.gamepadSampleSequence;
      local.gamepadIntegrationElapsedSeconds = 0;
    }
    startInputLoop();
    recordDiagnostic("engage_start", { phase: "engaging", owner: runtimeState.controlOwner });
    try {
      const startPromise = runtime().startLeaderSession(local.inputPose, {
        source: source === "gamepad" ? "gamepad" : "virtual_leader"
      });
      const startedState = runtime().getState();
      const expectedSessionId = startedState && startedState.leaderControl && startedState.leaderControl.sessionId || "";
      await startPromise;
      if (local.activeDriveAttempt !== attempt) return null;
      const current = runtime().getState();
      const currentLeader = current && current.leaderControl;
      const accepted = Boolean(
        expectedSessionId && currentLeader && currentLeader.sessionId === expectedSessionId &&
        ["live", "lagging"].includes(currentLeader.phase) && current.controlOwner === "virtual_leader"
      );
      if (!accepted) {
        recordDiagnostic("engage_error", { errorCode: "ENGAGE_NOT_CONFIRMED" });
        stopInputLoop();
        return false;
      }
      recordDiagnostic("engage_result", { phase: "live", owner: "virtual_leader" });
      return true;
    } catch (error) {
      if (local.activeDriveAttempt !== attempt) return null;
      stopInputLoop();
      if (runtime().cancelLeaderInteraction) runtime().cancelLeaderInteraction("client_error");
      recordDiagnostic("engage_error", { errorCode: error.code || "ENGAGE_FAILED" });
      return false;
    }
  }

  function startInputLoop() {
    if (local.animationFrame !== null) return;
    const tick = (now) => {
      local.animationFrame = null;
      if (!local.deadman) return;
      const dt = Math.max(0, Math.min(0.05, (now - local.lastFrameAt) / 1000));
      local.lastFrameAt = now;
      if (local.driveSource === "gamepad") {
        local.gamepadIntegrationElapsedSeconds = Math.min(0.05, local.gamepadIntegrationElapsedSeconds + dt);
        if (integrateInput(local.gamepadIntegrationElapsedSeconds)) {
          local.gamepadIntegrationElapsedSeconds = 0;
        }
      } else {
        integrateInput(dt);
      }
      local.animationFrame = window.requestAnimationFrame(tick);
    };
    local.animationFrame = window.requestAnimationFrame(tick);
  }

  function stopInputLoop() {
    local.driveAttemptGeneration += 1;
    local.activeDriveAttempt = 0;
    if (local.animationFrame !== null) window.cancelAnimationFrame(local.animationFrame);
    local.animationFrame = null;
    local.deadman = false;
    local.heldKeys.clear();
    local.keyVector = { x: 0, y: 0 };
    local.gamepadVector = { x: 0, y: 0 };
    local.gamepadFine = false;
    local.gamepadConsumedSampleSequence = local.gamepadSampleSequence;
    local.gamepadIntegrationElapsedSeconds = 0;
    local.driveSource = "";
    centerPad();
  }

  function integrateInput(dt) {
    const selected = pairsConfig()[local.pair];
    if (!selected) return false;
    const gamepadDrive = local.driveSource === "gamepad";
    if (gamepadDrive) {
      if (local.gamepadSampleSequence <= local.gamepadConsumedSampleSequence) return false;
      local.gamepadConsumedSampleSequence = local.gamepadSampleSequence;
    }
    const vector = local.driveSource === "pad"
      ? local.padVector
      : local.driveSource === "precision"
        ? local.precisionVector
        : gamepadDrive
          ? local.gamepadVector
          : local.keyVector;
    const speedName = local.heldKeys.has("Shift") || gamepadDrive && local.gamepadFine ? "fine" : local.speed;
    const speed = speedsConfig()[speedName];
    if (!speed) return gamepadDrive;
    const limits = runtime().getLeaderOperatingLimits();
    const next = { ...local.inputPose };
    const moving = Math.abs(Number(vector.x)) > 0.00001 || Math.abs(Number(vector.y)) > 0.00001;
    [[selected.horizontal, vector.x], [selected.vertical, vector.y]].forEach(([jointId, velocity]) => {
      const jointSpeed = jointId === "gripper" ? speed.gripper : speed.revolute;
      const limit = limits[jointId];
      const candidate = Number(next[jointId]) + Number(velocity) * jointSpeed * dt;
      next[jointId] = Math.min(limit.max, Math.max(limit.min, candidate));
    });
    local.inputPose = next;
    const now = monotonicNow();
    if (moving || now - local.lastCandidateAt >= heartbeatAfterMs()) {
      local.lastCandidateAt = now;
      runtime().setLeaderInputPose(next, { heartbeat: !moving });
    }
    return true;
  }

  async function releaseDrive() {
    if ((!local.deadman && !(runtime().getLeaderControlState() || {}).sessionId) || local.releasing) return;
    local.releasing = true;
    stopInputLoop();
    try {
      const next = await runtime().finalizeLeaderSession(local.inputPose);
      recordDiagnostic("settled", {
        phase: next.leaderControl && next.leaderControl.phase,
        owner: next.controlOwner,
        target: next.leaderControl && next.leaderControl.acceptedTargetPose,
        measured: next.leaderControl && next.leaderControl.measuredPose
      });
    } catch (error) {
      recordDiagnostic("settle_error", { errorCode: error.code || "SETTLE_FAILED" });
      await emergencyFallback(error);
    } finally {
      local.releasing = false;
      render(runtime().getState());
    }
  }

  async function cancelDrive(reason, options = {}) {
    const safeReason = CANCEL_REASONS.has(reason) ? reason : "client_error";
    if (local.deadman && local.driveSource === "gamepad" && local.gamepadController) {
      local.gamepadController.requireNeutral("cancel_release_required");
    }
    stopInputLoop();
    if (local.recoveryTimer !== null) {
      window.clearInterval(local.recoveryTimer);
      local.recoveryTimer = null;
    }
    local.recoveryKeyHeld = false;
    local.pointerId = null;
    if (!runtime()) return;
    try {
      await runtime().cancelRangeRecovery(safeReason, options);
      const next = await runtime().cancelLeaderSession(safeReason, options);
      recordDiagnostic("cancelled", { reason: safeReason, phase: next.leaderControl && next.leaderControl.phase, owner: next.controlOwner });
    } catch (error) {
      recordDiagnostic("cancel_error", { reason: safeReason, errorCode: error.code || "CANCEL_FAILED" });
      if (!options.keepalive) await emergencyFallback(error);
    }
  }

  async function emergencyFallback(error) {
    announce(`Measured hold could not be confirmed. Emergency STOP required. ${error && error.message || ""}`.trim());
    if (typeof local.options.onEmergencyStop === "function") {
      try {
        await Promise.resolve(local.options.onEmergencyStop({ source: "leader_fallback" }));
        return;
      } catch (stopError) {
        recordDiagnostic("emergency_stop_error", { errorCode: stopError && stopError.code || "STOP_FAILED" });
      }
    }
    if (runtime() && runtime().stopHardware) {
      try {
        await runtime().stopHardware();
      } catch (stopError) {
        runtime().stop();
        recordDiagnostic("emergency_stop_unconfirmed", { errorCode: stopError && stopError.code || "STOP_UNCONFIRMED" });
        announce("Emergency STOP could not be confirmed. Hardware commands remain unsafe; verify the arm is stationary before reconnecting.");
      }
    } else if (runtime()) {
      runtime().stop();
    }
  }

  function wireRecovery() {
    if (!ui.recoveryHold) return;
    const start = async (source, pointerId = null) => {
      if (local.recoveryStarting) return;
      const state = runtime().getState();
      const need = state.leaderControl && state.leaderControl.rangeRecovery && state.leaderControl.rangeRecovery.needs[0];
      if (!need) return;
      local.recoveryStarting = true;
      try {
        await runtime().startRangeRecovery(need.joint);
        const nextState = runtime().getState();
        const activeRecovery = nextState && nextState.leaderControl && nextState.leaderControl.rangeRecovery;
        const stillHeld = source === "keyboard" ? local.recoveryKeyHeld : local.pointerId === pointerId;
        if (!stillHeld || !activeRecovery || !activeRecovery.active) {
          return;
        }
        recordDiagnostic("recovery_start", { joint: need.joint, owner: "range_recovery" });
        local.recoveryTimer = window.setInterval(() => {
          void runtime().stepRangeRecovery().catch((error) => {
            recordDiagnostic("recovery_error", { errorCode: error.code || "RECOVERY_FAILED" });
            void cancelDrive("client_error");
          });
        }, 40);
      } catch (error) {
        if (source === "keyboard") local.recoveryKeyHeld = false;
        else if (local.pointerId === pointerId) local.pointerId = null;
        recordDiagnostic("recovery_error", { errorCode: error.code || "RECOVERY_FAILED" });
      } finally {
        local.recoveryStarting = false;
      }
    };
    const finish = (reason) => {
      local.pointerId = null;
      local.recoveryKeyHeld = false;
      window.clearInterval(local.recoveryTimer);
      local.recoveryTimer = null;
      void runtime().cancelRangeRecovery(reason)
        .then(() => runtime().invalidateLeaderAlignment("Range recovery completed. Align again."))
        .catch((error) => emergencyFallback(error));
    };
    ui.recoveryHold.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || local.recoveryStarting) return;
      event.preventDefault();
      try { ui.recoveryHold.setPointerCapture(event.pointerId); } catch (error) { /* Pointer capture can be unavailable in synthetic events. */ }
      local.pointerId = event.pointerId;
      void start("pointer", event.pointerId);
    });
    const finishPointer = (event) => {
      if (local.pointerId !== event.pointerId) return;
      finish("pointer_cancelled");
    };
    ui.recoveryHold.addEventListener("pointerup", finishPointer);
    ui.recoveryHold.addEventListener("pointercancel", finishPointer);
    ui.recoveryHold.addEventListener("lostpointercapture", finishPointer);
    ui.recoveryHold.addEventListener("keydown", (event) => {
      if (!["Space", "Enter"].includes(event.code) || event.repeat || local.recoveryKeyHeld) return;
      event.preventDefault();
      event.stopPropagation();
      local.recoveryKeyHeld = true;
      void start("keyboard");
    });
    ui.recoveryHold.addEventListener("keyup", (event) => {
      if (!["Space", "Enter"].includes(event.code) || !local.recoveryKeyHeld) return;
      event.preventDefault();
      event.stopPropagation();
      finish("pointer_cancelled");
    });
    ui.recoveryHold.addEventListener("blur", () => {
      if (local.recoveryKeyHeld) finish("focus_lost");
    });
  }

  function wireGamepad() {
    if (!ui.gamepad) return;
    const profile = gamepadProfile();
    if (!profile || !NS.StandardGamepadInput || typeof NS.StandardGamepadInput.create !== "function") {
      local.gamepadState = { phase: "unsupported", reason: "adapter_unavailable", controllers: [], selectedIndex: null };
      renderGamepad();
      return;
    }

    try {
      local.gamepadController = NS.StandardGamepadInput.create({
        config: profile,
        onState: handleGamepadState,
        onSample: handleGamepadSample,
        onAction: handleGamepadAction,
        onFault: handleGamepadFault
      });
    } catch (error) {
      local.gamepadController = null;
      local.gamepadState = { phase: "unsupported", reason: "invalid_profile", enabled: false, controllers: [], selection: null };
      recordDiagnostic("gamepad_profile_invalid", { errorCode: "INVALID_GAMEPAD_PROFILE" });
      renderGamepad();
      return;
    }
    local.gamepadState = local.gamepadController.getState();

    ui.gamepadEnable.addEventListener("click", () => {
      const result = local.gamepadController.discover();
      if (!result.ok) announceGamepadIssue(result.error);
    });
    if (ui.gamepadQuickEnable) ui.gamepadQuickEnable.addEventListener("click", openGamepadSetup);
    ui.gamepadUse.addEventListener("click", () => {
      const index = Number(ui.gamepadSelect.value);
      const result = local.gamepadController.select(index);
      if (!result.ok) announceGamepadIssue(result.error);
      else ui.gamepadDisable.focus();
    });
    ui.gamepadSelect.addEventListener("change", renderGamepad);
    ui.gamepadDisable.addEventListener("click", () => {
      const restoreFocus = document.activeElement === ui.gamepadDisable;
      void disableGamepad("operator_disabled", { cancel: true }).then(() => {
        const focusUnclaimed = document.activeElement === ui.gamepadDisable || document.activeElement === document.body;
        if (restoreFocus && focusUnclaimed && local.mode === "leader" && ui.leaderPanel && !ui.leaderPanel.hidden) {
          ui.gamepadEnable.focus();
        }
      });
    });
    window.addEventListener("gamepadconnected", () => local.gamepadController && local.gamepadController.refresh());
    window.addEventListener("gamepaddisconnected", (event) => {
      const index = event && event.gamepad ? Number(event.gamepad.index) : null;
      if (local.gamepadController) local.gamepadController.refresh({ disconnectedIndex: index });
    });
    renderGamepad();
  }

  function openGamepadSetup() {
    if (!local.gamepadController) return;
    const restoreFocus = document.activeElement === ui.gamepadQuickEnable;
    const state = local.gamepadController.getState();
    if (!state.enabled) {
      const result = local.gamepadController.discover();
      if (!result.ok) announceGamepadIssue(result.error);
    }
    renderGamepad();
    if (ui.gamepad && typeof ui.gamepad.scrollIntoView === "function") {
      ui.gamepad.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    window.requestAnimationFrame(() => {
      const focusUnclaimed = document.activeElement === ui.gamepadQuickEnable || document.activeElement === document.body;
      if (!restoreFocus || !focusUnclaimed || local.mode !== "leader" || !ui.leaderPanel || ui.leaderPanel.hidden) return;
      const latest = local.gamepadController && local.gamepadController.getState();
      if (latest && latest.phase === "choose_controller" && !ui.gamepadPicker.hidden) ui.gamepadSelect.focus();
      else if (latest && latest.enabled) ui.gamepadDisable.focus();
      else ui.gamepadEnable.focus();
    });
  }

  function handleGamepadState(state) {
    const previousPhase = local.gamepadState && local.gamepadState.phase;
    local.gamepadState = state || { phase: "off", reason: "", controllers: [] };
    if (previousPhase !== local.gamepadState.phase) {
      recordDiagnostic("gamepad_state", {
        phase: local.gamepadState.phase,
        reason: local.gamepadState.reason,
        featureState: local.gamepadState.enabled ? "enabled" : "disabled"
      });
    }
    const pinned = Boolean(local.gamepadState.enabled && ["neutral_required", "ready", "active", "faulted", "unavailable"].includes(local.gamepadState.phase));
    if (pinned !== local.detailsPinned) {
      local.detailsPinned = pinned;
      window.dispatchEvent(new CustomEvent("robobuddy:leader-details-request", {
        detail: { open: pinned, pin: pinned, reason: `controller_${local.gamepadState.phase}` }
      }));
    }
    renderGamepad();
  }

  function handleGamepadSample(sample) {
    if (!sample || !sample.vector) return;
    const previousFine = local.gamepadFine;
    local.gamepadVector = {
      x: Number.isFinite(Number(sample.vector.x)) ? Number(sample.vector.x) : 0,
      y: Number.isFinite(Number(sample.vector.y)) ? Number(sample.vector.y) : 0
    };
    local.gamepadFine = sample.fineOverride === true;
    if (local.gamepadFine !== previousFine) renderGamepad();
    local.gamepadSampleSequence += 1;

    if (sample.terminal) {
      local.gamepadVector = { x: 0, y: 0 };
      local.gamepadFine = false;
      return;
    }
    if (sample.deadman) {
      if (local.deadman && local.driveSource !== "gamepad") {
        local.gamepadController.requireNeutral("source_busy");
        announce("Release the active input before engaging the controller.");
        return;
      }
      if (!local.deadman) {
        void beginDrive("gamepad").then((engaged) => {
          if (engaged === false && local.gamepadController) local.gamepadController.requireNeutral("engagement_rejected");
        });
      }
      return;
    }
    if (sample.released && local.deadman && local.driveSource === "gamepad") {
      void releaseDrive();
    }
  }

  function handleGamepadAction(action) {
    if (!action || !action.type) return;
    if (action.type === "stop") {
      recordDiagnostic("gamepad_stop", { reason: "operator_stop" });
      stopInputLoop();
      if (local.gamepadController) local.gamepadController.disable("stop");
      if (typeof local.options.onEmergencyStop === "function") {
        void Promise.resolve(local.options.onEmergencyStop({ source: "gamepad" }));
      } else {
        void emergencyFallback(new Error("The global Emergency STOP action is unavailable."));
      }
      return;
    }
    if (action.type === "cancel") {
      recordDiagnostic("gamepad_cancel", { reason: "operator_cancel" });
      const state = runtime() && runtime().getState ? runtime().getState() : null;
      if (local.deadman || state && state.leaderControl && state.leaderControl.sessionId || state && state.controlOwner === "range_recovery") {
        void cancelDrive("client_error");
      } else {
        announce("Controller cancellation acknowledged. No Leader motion was active.");
      }
      return;
    }
    if (action.type === "previous_pair" || action.type === "next_pair") {
      const keys = Object.keys(pairsConfig());
      const currentIndex = Math.max(0, keys.indexOf(local.pair));
      const delta = action.type === "previous_pair" ? -1 : 1;
      const next = keys[(currentIndex + delta + keys.length) % keys.length];
      if (next) selectPair(next);
    }
  }

  function handleGamepadFault(fault) {
    if (!fault || local.gamepadFaultHandling) return;
    local.gamepadFaultHandling = true;
    local.gamepadVector = { x: 0, y: 0 };
    local.gamepadFine = false;
    const disconnectCodes = new Set([
      "controller_missing", "controller_disconnected", "controller_signature_changed",
      "unsupported_mapping", "insufficient_axes", "insufficient_buttons"
    ]);
    const reason = disconnectCodes.has(fault.code) ? "disconnect" : "stale_input";
    recordDiagnostic("gamepad_fault", { reason: fault.code || reason, featureState: "lost" });
    const state = runtime() && runtime().getState ? runtime().getState() : null;
    const active = local.deadman || state && state.leaderControl && state.leaderControl.sessionId || state && state.controlOwner === "range_recovery";
    const completion = active ? cancelDrive(reason) : Promise.resolve();
    void completion.finally(() => {
      local.gamepadFaultHandling = false;
      renderGamepad();
    });
  }

  async function disableGamepad(reason, options = {}) {
    if (!local.gamepadController) return;
    const state = runtime() && runtime().getState ? runtime().getState() : null;
    const active = local.deadman || state && state.leaderControl && state.leaderControl.sessionId || state && state.controlOwner === "range_recovery";
    local.gamepadController.disable(reason);
    local.gamepadVector = { x: 0, y: 0 };
    local.gamepadFine = false;
    if (options.cancel && active) await cancelDrive(options.cancelReason || "client_error", options.cancelOptions || {});
  }

  function retireForEmergencyStop(source = "external") {
    const hadRecovery = local.recoveryTimer !== null || local.recoveryStarting || local.recoveryKeyHeld;
    if (local.recoveryTimer !== null) window.clearInterval(local.recoveryTimer);
    local.recoveryTimer = null;
    local.recoveryStarting = false;
    local.recoveryKeyHeld = false;
    local.pointerId = null;
    const hadDrive = local.deadman;
    stopInputLoop();
    let retiredController = false;
    if (local.gamepadController) {
      const state = local.gamepadController.getState();
      retiredController = Boolean(state.enabled || state.selection);
      if (retiredController) local.gamepadController.disable("stop");
    }
    local.gamepadFaultHandling = false;
    if (hadRecovery || hadDrive || retiredController) {
      recordDiagnostic("emergency_stop_retire", { reason: String(source || "external") });
    }
    renderGamepad();
  }

  function announceGamepadIssue(reason) {
    if (ui.gamepadStatus) ui.gamepadStatus.textContent = gamepadIssueMessage(reason);
  }

  function gamepadIssueMessage(reason) {
    const messages = {
      gamepad_api_unavailable: "Gamepad API is unavailable. Use current Chrome or Edge on a secure or local page.",
      gamepad_read_failed: "The browser could not read controller state. Check browser permissions and retry.",
      controller_missing: "The selected controller is no longer available.",
      unsupported_mapping: "This controller does not expose the standard browser mapping.",
      insufficient_axes: "This controller does not expose the required left-stick axes.",
      insufficient_buttons: "This controller does not expose the required Xbox controls."
    };
    return messages[reason] || "Controller setup could not continue. Release all controls and retry.";
  }

  function renderGamepad() {
    if (!ui.gamepad) return;
    const state = local.gamepadState || { phase: "off", reason: "", controllers: [] };
    const phase = String(state.phase || "off");
    const controllers = Array.isArray(state.controllers) ? state.controllers : [];
    const activeRuntime = runtime();
    const runtimeState = activeRuntime && activeRuntime.getState ? activeRuntime.getState() : null;
    const leader = runtimeState && runtimeState.leaderControl;
    let display = gamepadStatusCopy(phase, state.reason);
    if (state.supported === false) display = gamepadStatusCopy("unsupported", "gamepad_api_unavailable");
    if (phase === "ready") {
      const availability = activeRuntime && activeRuntime.getLeaderAvailability
        ? activeRuntime.getLeaderAvailability("gamepad")
        : null;
      const leaderReady = Boolean(
        local.mode === "leader" &&
        runtimeState && runtimeState.robotId === "so101_follower" &&
        leader && leader.aligned && leader.phase === "ready" &&
        availability && availability.available
      );
      if (!leaderReady) {
        display = {
          label: "Input ready",
          tone: "warning",
          panelState: "neutral",
          message: availability && !availability.available
            ? availability.reason
            : "Controller input is ready, but Leader is blocked above. Resolve readiness and Align before holding RT."
        };
      }
    }
    if (phase === "active" && !(runtimeState && runtimeState.controlOwner === "virtual_leader" && leader && ["live", "lagging"].includes(leader.phase))) {
      display = {
        label: "RT held",
        tone: "warning",
        panelState: "neutral",
        message: "RT is held while RoboBuddy confirms Leader ownership. No controller frame is accepted before the session is Live."
      };
    }
    if (phase === "choose_controller" && controllers.length && !controllers.some((controller) => controller.supported)) {
      display = {
        label: "Unsupported",
        tone: "error",
        panelState: "unsupported",
        message: gamepadIssueMessage(controllers[0].reason)
      };
    }
    if (ui.gamepad.dataset.state !== display.panelState) ui.gamepad.dataset.state = display.panelState;
    if (ui.gamepadState.textContent !== display.label) ui.gamepadState.textContent = display.label;
    if (ui.gamepadState.dataset.tone !== display.tone) ui.gamepadState.dataset.tone = display.tone;
    if (ui.gamepadStatus.textContent !== display.message) ui.gamepadStatus.textContent = display.message;

    const previousValue = ui.gamepadSelect.value;
    const controllersKey = JSON.stringify(controllers.map((controller) => ({
      index: Number(controller.index),
      label: String(controller.label || ""),
      supported: controller.supported === true
    })));
    if (controllersKey !== local.gamepadControllersKey) {
      local.gamepadControllersKey = controllersKey;
      ui.gamepadSelect.innerHTML = controllers.length
        ? controllers.map((controller) => `<option value="${Number(controller.index)}"${controller.supported ? "" : " disabled"}>${escapeHtml(controller.label)}${controller.supported ? "" : " (unsupported)"}</option>`).join("")
        : '<option value="">No exposed controllers</option>';
    }
    if (controllers.some((controller) => String(controller.index) === previousValue && controller.supported)) {
      ui.gamepadSelect.value = previousValue;
    }
    const chosen = controllers.find((controller) => String(controller.index) === ui.gamepadSelect.value);
    const controllerUnavailable = !local.gamepadController || state.supported === false || phase === "unsupported";
    setBooleanProperty(ui.gamepadPicker, "hidden", !state.enabled || !["discovering", "choose_controller"].includes(phase));
    setBooleanProperty(ui.gamepadUse, "disabled", !chosen || !chosen.supported || driveLifecycleBusy());
    setBooleanProperty(ui.gamepadEnable, "disabled", controllerUnavailable || local.modeTransitioning || state.enabled && !["faulted", "unavailable"].includes(phase));
    const enableCopy = controllerUnavailable ? "Controller unavailable" : ["faulted", "unavailable"].includes(phase) ? "Retry controller" : "Enable controller";
    setText(ui.gamepadEnable, enableCopy);
    setBooleanProperty(ui.gamepadDisable, "disabled", !state.enabled);
    if (ui.gamepadQuickEnable) {
      setBooleanProperty(ui.gamepadQuickEnable, "disabled", controllerUnavailable || local.modeTransitioning);
    }

    const fresh = phase === "active";
    const neutralVerified = phase === "ready";
    const validating = phase === "neutral_required";
    const unselected = ["discovering", "choose_controller"].includes(phase);
    const freshnessCopy = fresh ? "Input polling" : neutralVerified ? "Neutral verified" : validating ? "Input check" : unselected ? "Input not selected" : phase === "faulted" ? "Input lost" : "Input \u2014";
    const freshnessState = fresh || neutralVerified ? "fresh" : validating ? "aging" : phase === "faulted" ? "stale" : "unknown";
    if (ui.gamepadFreshness.textContent !== freshnessCopy) ui.gamepadFreshness.textContent = freshnessCopy;
    if (ui.gamepadFreshness.dataset.freshness !== freshnessState) ui.gamepadFreshness.dataset.freshness = freshnessState;
    if (ui.gamepadControllerName) {
      const selection = state.selection;
      const selectedController = selection && controllers.find((controller) => Number(controller.index) === Number(selection.index));
      const controllerCopy = selection ? `Controller ${selectedController && selectedController.label || `Gamepad ${Number(selection.index) + 1}`}` : "Controller \u2014";
      if (ui.gamepadControllerName.textContent !== controllerCopy) ui.gamepadControllerName.textContent = controllerCopy;
    }
    const pair = pairsConfig()[local.pair];
    const pairCopy = `Pair ${pair && pair.label || local.pair}`;
    if (ui.gamepadPair && ui.gamepadPair.textContent !== pairCopy) ui.gamepadPair.textContent = pairCopy;
    if (ui.gamepadSpeed) {
      const speed = speedsConfig()[local.gamepadFine ? "fine" : local.speed];
      const speedCopy = `Speed ${speed && speed.label || (local.gamepadFine ? "fine" : local.speed)}${local.gamepadFine ? " (LB)" : ""}`;
      if (ui.gamepadSpeed.textContent !== speedCopy) ui.gamepadSpeed.textContent = speedCopy;
    }
  }

  function gamepadStatusCopy(phase, reason) {
    const reasonCopy = {
      positive_timestamp_required: "The controller must provide positive browser timestamps before it can drive.",
      input_probe_required: "Move only the left stick away from center. Do not press RT or any buttons.",
      input_probe_return_required: "Return the left stick to center and leave RT, LB, D-pad, X, and B untouched.",
      input_probe_controls_required: "Leave RT, LB, D-pad, X, and B untouched, then move only the left stick.",
      neutral_hold: "Keep the left stick centered and leave RT, LB, D-pad, X, and B untouched for 250 ms.",
      center_and_release_controls: "Center the left stick and leave RT, LB, D-pad, X, and B untouched.",
      center_before_deadman: "RT was pressed with the stick displaced. Release RT, recenter, then press RT again.",
      deadman_release_required: "Release RT before the controller can engage again.",
      cancel_release_required: "Release RT and every mapped control, center the stick, then hold neutral before driving again.",
      source_busy: "Another input source is active. Release RT and recenter before retrying.",
      engagement_rejected: "Leader engagement was blocked. Release RT, recenter, and resolve the Leader status above.",
      poll_gap: "Browser polling paused beyond the safe window. Reselect the controller.",
      timestamp_inconsistent: "Controller values changed without a matching browser timestamp. Reselect the controller.",
      timestamp_rollback: "Controller timing reset, so the selected connection was retired.",
      controller_missing: "The selected controller disappeared. Reconnect and select it again.",
      controller_disconnected: "The selected controller disconnected. Reconnect and select it again.",
      controller_signature_changed: "The controller slot changed. Select the intended controller again.",
      invalid_profile: "The controller safety profile is invalid, so controller input is disabled.",
      adapter_unavailable: "Controller support did not load, so controller input is disabled."
    };
    const map = {
      off: ["Off", "idle", "off", "Pair the controller in Windows, then enable discovery here. RoboBuddy does not use Web Bluetooth."],
      unsupported: ["Unsupported", "error", "unsupported", reasonCopy[reason] || "Gamepad API is unavailable. Use current Chrome or Edge on a secure or local page."],
      unavailable: ["Unavailable", "error", "unsupported", reasonCopy[reason] || "The browser could not read controller state."],
      discovering: ["Discovering", "warning", "discovering", "Press any button on the paired controller so the browser exposes it."],
      choose_controller: ["Choose", "warning", "discovering", "Select the intended standard controller. Selection is kept only for this page session."],
      neutral_required: ["Neutral required", "warning", "neutral", reasonCopy[reason] || "Center the stick and release all mapped controls."],
      ready: ["Ready", "ready", "ready", reasonCopy[reason] || "Hold RT with the stick centered, then move the left stick to drive the selected pair."],
      active: ["Live", "active", "live", "RT is held. Release RT for measured settlement; B remains Emergency STOP."],
      faulted: ["Lost", "error", "lost", reasonCopy[reason] || "Controller input was retired. Reselect it before driving."],
      destroyed: ["Unavailable", "error", "unsupported", "Controller support was shut down for this page."]
    };
    const value = map[phase] || map.off;
    return { label: value[0], tone: value[1], panelState: value[2], message: value[3] };
  }

  function driveLifecycleBusy() {
    const state = runtime() && runtime().getState ? runtime().getState() : null;
    const leader = state && state.leaderControl;
    return Boolean(
      local.deadman ||
      local.releasing ||
      local.modeTransitioning ||
      local.recoveryStarting ||
      leader && leader.sessionId ||
      state && ["virtual_leader", "range_recovery"].includes(state.controlOwner)
    );
  }

  function selectPair(pair, options = {}) {
    if (!pairsConfig()[pair]) return false;
    if (driveLifecycleBusy()) {
      if (!options.silent) announce("Release the active drive before changing the joint pair.");
      return false;
    }
    local.pair = pair;
    savePreferences();
    render(runtime().getState());
    return true;
  }

  function selectSpeed(speed, options = {}) {
    if (!speedsConfig()[speed]) return false;
    if (driveLifecycleBusy()) {
      if (!options.silent) announce("Release the active drive before changing the base speed.");
      return false;
    }
    local.speed = speed;
    savePreferences();
    render(runtime().getState());
    return true;
  }

  function toggleLayer(layer) {
    if (!Object.prototype.hasOwnProperty.call(local.visibility, layer)) return;
    local.visibility[layer] = !local.visibility[layer];
    savePreferences();
    if (runtime() && runtime().setLeaderLayerVisibility) runtime().setLeaderLayerVisibility(local.visibility);
    render(runtime().getState());
  }

  function bindRendererCallbacks() {
    if (!runtime() || !runtime().setLeaderInteractionCallbacks) return;
    runtime().setLeaderInteractionCallbacks(local.mode === "leader" ? {
      onJointDragStart: (payload) => {
        const jointId = typeof payload === "string" ? payload : payload && payload.jointId;
        const state = runtime().getState();
        const leader = state && state.leaderControl;
        if (!jointId || local.deadman || local.releasing || !leader || !leader.aligned || leader.phase !== "ready") {
          announce("Align to the measured pose before using a 3D joint handle.");
          return false;
        }
        const pairs = pairsConfig();
        const pair = Object.keys(pairs).find((key) => pairs[key].horizontal === jointId || pairs[key].vertical === jointId);
        if (pair) selectPair(pair);
        void beginDrive("handle");
        return true;
      },
      onJointDrag: (payload, value) => {
        const jointId = typeof payload === "string" ? payload : payload && payload.jointId;
        const relative = Number(typeof payload === "object" && payload ? payload.delta : value);
        if (jointId && Number.isFinite(relative)) {
          const limits = runtime().getLeaderOperatingLimits();
          const limit = limits[jointId];
          if (!limit) return false;
          const numeric = Math.min(limit.max, Math.max(limit.min, Number(local.inputPose[jointId]) + relative));
          local.inputPose = { ...local.inputPose, [jointId]: numeric };
          runtime().setLeaderInputPose(local.inputPose);
          return true;
        }
        return false;
      },
      onJointDragEnd: () => void releaseDrive(),
      onJointDragCancel: () => void cancelDrive("pointer_cancelled"),
      onHandleUnavailable: () => announce("This handle is too small or edge-on. Use the linked pad or precision controls.")
    } : null);
  }

  function onRuntimeState(event) {
    const state = event && event.detail || (runtime() && runtime().getState ? runtime().getState() : null);
    if (state && state.controlOwner === "stop") {
      retireForEmergencyStop("runtime_stop");
    }
    if (state && state.leaderControl) {
      if (["stopped", "hold_failed", "feedback_unavailable"].includes(state.leaderControl.phase) && local.deadman) {
        stopInputLoop();
      }
      local.inputPose = { ...(state.leaderControl.inputPose || local.inputPose) };
      recordDiagnostic("state", {
        phase: state.leaderControl.phase,
        owner: state.controlOwner,
        sequence: state.leaderControl.latestIssuedSequence,
        acceptedSequence: state.leaderControl.latestAcceptedSequence,
        observationAgeMs: state.leaderControl.measuredAgeMs,
        target: state.leaderControl.acceptedTargetPose,
        measured: state.leaderControl.measuredPose,
        errorCode: state.leaderControl.lastError ? (state.leaderControl.lastErrorCode || "LEADER_STATE_ERROR") : ""
      });
    }
    render(state);
  }

  function render(state) {
    if (!local.initialized) return;
    updateModeDom();
    syncControlFocus();
    if (!state || state.robotId !== "so101_follower" || !state.leaderControl) return;
    const leader = state.leaderControl;
    const availability = runtime().getLeaderAvailability();
    const phase = String(leader.phase || "unaligned");
    const phaseCopy = statusForPhase(phase, availability, leader);
    if (ui.readinessTitle && ui.readinessTitle.textContent !== phaseCopy.title) ui.readinessTitle.textContent = phaseCopy.title;
    if (ui.status && ui.status.textContent !== phaseCopy.message) ui.status.textContent = phaseCopy.message;
    if (ui.stateChip) {
      if (ui.stateChip.textContent !== phaseCopy.chip) ui.stateChip.textContent = phaseCopy.chip;
      if (ui.stateChip.dataset.tone !== phaseCopy.tone) ui.stateChip.dataset.tone = phaseCopy.tone;
    }
    if (ui.align) {
      setBooleanProperty(ui.align, "disabled", !availability.available || ["aligning", "engaging", "live", "lagging", "settling", "holding", "range_recovery"].includes(phase));
      setText(ui.align.querySelector("span"), phase === "aligning" ? "Reading pose…" : "Align to robot");
    }
    setBooleanProperty(ui.cancel, "disabled", !leader.sessionId && state.controlOwner !== "range_recovery");
    const motionLocked = ["virtual_leader", "range_recovery"].includes(state.controlOwner);
    setMotionLock(ui.home, motionLocked);
    setMotionLock(ui.run, motionLocked);
    renderPair(leader);
    renderValues(leader, state);
    renderRecovery(leader);
    renderLayers();
    renderGamepad();
    if (ui.measuredAge) {
      const now = monotonicNow();
      const receivedAt = leader.observationReceivedAtLocalMs === null || leader.observationReceivedAtLocalMs === undefined
        ? NaN
        : Number(leader.observationReceivedAtLocalMs);
      const receivedAtKey = Number.isFinite(receivedAt) ? receivedAt : null;
      const baseAge = leader.measuredAgeMs === null || leader.measuredAgeMs === undefined ? NaN : Number(leader.measuredAgeMs);
      const age = baseAge + (Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : 0);
      const sourceChanged = local.measuredAgeSourceReceivedAt !== receivedAtKey;
      if (sourceChanged || now - local.measuredAgeLastRenderAt >= 100 || !ui.measuredAge.textContent) {
        setText(ui.measuredAge, Number.isFinite(age) ? `Measured ${Math.max(0, Math.round(age))} ms` : "Measured —");
        const freshness = !Number.isFinite(age) ? "unknown" : age <= 350 ? "fresh" : age <= 600 ? "aging" : "stale";
        if (ui.measuredAge.dataset.freshness !== freshness) ui.measuredAge.dataset.freshness = freshness;
        local.measuredAgeSourceReceivedAt = receivedAtKey;
        local.measuredAgeLastRenderAt = now;
      }
    }
    setText(ui.owner, `Owner ${String(state.controlOwner || "idle").replace(/_/g, " ")}`);
    setText(ui.frameRate, availability.simulation ? "Local atomic frames" : `REST ${Number(virtualLeaderConfig().maxFrameRateHz) || 30} Hz max`);
  }

  function statusForPhase(phase, availability, leader) {
    if (!availability.available) return { title: "Leader unavailable", chip: "Blocked", tone: "warning", message: availability.reason };
    const map = {
      inactive: ["Leader inactive", "Inactive", "idle", "Select Leader to prepare joint-space control."],
      unaligned: ["Align before driving", "Unaligned", "warning", leader.lastError || "Select Align to copy one fresh, complete measured pose. No motion is sent."],
      aligning: ["Reading all six joints", "Aligning", "active", "Waiting for one complete, finite observation from the same read."],
      range_recovery_required: ["Return one joint to range", "Recovery", "warning", "Coordinated Leader motion stays blocked until bounded recovery and a fresh alignment."],
      range_recovery: ["Bounded inward motion", "Recovering", "active", "Release to hold the complete measured pose."],
      ready: ["Hold to drive", "Ready", "ready", "Aligned to measured pose. Pad, keyboard, precision controls, joint handles, and an enabled controller share one guarded input session."],
      engaging: ["Verifying pickup", "Engaging", "active", "The bridge is checking fresh feedback and ownership. Start performs no motion write."],
      live: ["Deadman held", "Live", "active", "Input is local; Target changes only on bridge acceptance; Measured comes only from observation."],
      lagging: ["Follower lag detected", "Lagging", "warning", "Target remains visible ahead of Measured and input is reduced by the bridge."],
      settling: ["Sending final frame", "Settling", "active", "Waiting for fresh measured-position hold confirmation."],
      holding: ["Holding measured pose", "Holding", "active", "Pending targets are retired while the bridge confirms the measured six-joint hold."],
      stopped: ["Emergency STOP active", "Stopped", "error", "Review the work area, then explicitly arm and align again."],
      hold_failed: ["Hold not confirmed", "Fault", "error", leader.lastError || "Motion is disarmed and takeover is blocked."],
      hardware_range_fault: ["Calibration range exceeded", "Disarmed", "error", leader.lastError || "Disconnect and reposition the joint or recalibrate before retrying."],
      feedback_unavailable: ["Feedback unavailable", "Blocked", "error", leader.lastError || "Reconnect or retry the complete observation."]
    };
    const value = map[phase] || map.unaligned;
    return { title: value[0], chip: value[1], tone: value[2], message: value[3] };
  }

  function renderPair(leader) {
    const pair = pairsConfig()[local.pair];
    if (!pair) return;
    const selectionLocked = driveLifecycleBusy();
    ui.pairButtons.forEach((button) => {
      setAttributeValue(button, "aria-pressed", button.dataset.leaderPair === local.pair);
      setBooleanProperty(button, "disabled", selectionLocked);
    });
    ui.speedButtons.forEach((button) => {
      setAttributeValue(button, "aria-pressed", button.dataset.leaderSpeed === local.speed);
      setBooleanProperty(button, "disabled", selectionLocked);
    });
    setText(ui.padHorizontal, labelForJoint(pair.horizontal));
    setText(ui.padVertical, labelForJoint(pair.vertical));
    setText(ui.precisionHorizontalLabel, labelForJoint(pair.horizontal));
    setText(ui.precisionVerticalLabel, labelForJoint(pair.vertical));
    const pose = leader.inputPose || local.inputPose;
    setText(ui.precisionHorizontalValue, formatJointValue(pair.horizontal, pose[pair.horizontal]));
    setText(ui.precisionVerticalValue, formatJointValue(pair.vertical, pose[pair.vertical]));
  }

  function renderValues(leader, state) {
    if (!ui.valuesBody) return;
    const input = leader.inputPose || {};
    const target = leader.acceptedTargetPose || {};
    const measured = leader.measuredPose || state.measuredJoints || {};
    const joints = runtime().getManifest().joints;
    const jointKey = joints.map((joint) => joint.id).join("|");
    if (local.valuesJointKey !== jointKey) {
      ui.valuesBody.innerHTML = joints.map((joint) => `<tr data-leader-joint="${escapeHtml(joint.id)}"><th scope="row">${escapeHtml(joint.label)}</th><td data-value="input"></td><td data-value="target"></td><td data-value="measured"></td><td data-value="delta"></td></tr>`).join("");
      local.valuesJointKey = jointKey;
      local.valuesRows = new Map(Array.from(ui.valuesBody.querySelectorAll("tr[data-leader-joint]"), (row) => [row.dataset.leaderJoint, row]));
    }
    joints.forEach((joint) => {
      const row = local.valuesRows.get(joint.id);
      if (!row) return;
      const delta = Number(target[joint.id]) - Number(measured[joint.id]);
      const lagging = (leader.laggingJoints || []).includes(joint.id);
      const values = {
        input: formatJointValue(joint.id, input[joint.id]),
        target: formatJointValue(joint.id, target[joint.id]),
        measured: formatJointValue(joint.id, measured[joint.id]),
        delta: Number.isFinite(delta) ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}` : "\u2014"
      };
      Object.entries(values).forEach(([key, value]) => {
        const cell = row.querySelector(`[data-value="${key}"]`);
        if (cell && cell.textContent !== value) cell.textContent = value;
      });
      if (lagging && row.dataset.state !== "lagging") row.dataset.state = "lagging";
      if (!lagging && row.dataset.state) delete row.dataset.state;
    });
  }

  function renderRecovery(leader) {
    const recovery = leader.rangeRecovery;
    const need = recovery && Array.isArray(recovery.needs) ? recovery.needs[0] : null;
    const required = Boolean(need && ["range_recovery_required", "range_recovery"].includes(leader.phase));
    setBooleanProperty(ui.recovery, "hidden", !required);
    if (required && !local.recoveryDetailsOpen) {
      window.dispatchEvent(new CustomEvent("robobuddy:leader-details-request", {
        detail: { open: true, reason: "range_recovery" }
      }));
    }
    local.recoveryDetailsOpen = required;
    if (need && ui.recoveryMessage) {
      setText(ui.recoveryMessage, `${labelForJoint(need.joint)} is ${formatJointValue(need.joint, need.value)}. Nearest Leader boundary: ${formatJointValue(need.joint, need.boundary)}.`);
    }
    setAttributeValue(ui.recoveryHold, "aria-pressed", Boolean(recovery && recovery.active));
  }

  function renderLayers() {
    ui.layerButtons.forEach((button) => {
      const enabled = local.visibility[button.dataset.leaderLayer] !== false;
      setAttributeValue(button, "aria-pressed", enabled);
    });
  }

  function labelForJoint(jointId) {
    const manifest = runtime() && runtime().getManifest ? runtime().getManifest() : null;
    const joint = manifest && manifest.joints.find((item) => item.id === jointId);
    return joint ? joint.label : String(jointId || "").replace(/_/g, " ");
  }

  function formatJointValue(jointId, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "—";
    return jointId === "gripper" ? `${numeric.toFixed(1)}%` : `${numeric.toFixed(1)}°`;
  }

  function announce(message) {
    if (!ui.status || ui.status.textContent === message) return;
    ui.status.textContent = message;
  }

  function setMotionLock(element, locked) {
    if (!element) return;
    if (locked) {
      if (!motionLockPrevious.has(element)) motionLockPrevious.set(element, Boolean(element.disabled));
      setBooleanProperty(element, "disabled", true);
      if (element.dataset.leaderLocked !== "true") element.dataset.leaderLocked = "true";
      return;
    }
    if (motionLockPrevious.has(element)) {
      setBooleanProperty(element, "disabled", motionLockPrevious.get(element));
      motionLockPrevious.delete(element);
    }
    if (element.dataset.leaderLocked) delete element.dataset.leaderLocked;
  }

  function loadPreferences() {
    try {
      const value = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (pairsConfig()[value.pair]) local.pair = value.pair;
      if (speedsConfig()[value.speed]) local.speed = value.speed;
      if (value.visibility && typeof value.visibility === "object") {
        local.visibility = {
          input: value.visibility.input !== false,
          target: value.visibility.target !== false,
          measured: value.visibility.measured !== false
        };
      }
    } catch (error) {
      // Display preferences are optional; live state is never restored.
    }
  }

  function savePreferences() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ pair: local.pair, speed: local.speed, visibility: local.visibility }));
    } catch (error) {
      // Storage may be unavailable in privacy-restricted contexts.
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  NS.VirtualLeaderDiagnostics = {
    record: recordDiagnostic,
    exportObject: diagnosticsObject,
    download: downloadDiagnostics,
    getSnapshot: () => {
      pruneDiagnostics();
      return diagnosticEvents.map((event) => ({ ...event }));
    }
  };

  NS.VirtualLeaderUI = {
    init,
    setMode,
    getMode: () => local.mode,
    cancel: cancelDrive,
    retireForEmergencyStop,
    exportDiagnostics: diagnosticsObject
  };
})();
