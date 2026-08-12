(function phoneLeaderUiModule(global) {
  "use strict";

  const STATE_SCHEMA = "robobuddy.phone-teleop.state.v1";
  const PHONE_OWNER = "virtual_phone_leader";
  const ROBOT_ID = "so101_follower";
  const ANNOUNCEMENT_INTERVAL_MS = 900;

  const SOURCE_STATES = new Set([
    "UNPAIRED",
    "PAIRING",
    "SOURCE_CONNECTED",
    "SOURCE_TRACKING",
    "SOURCE_READY",
    "SOURCE_LIMITED",
    "SOURCE_LOST",
    "SOURCE_STALE",
    "SOURCE_DISCONNECTED"
  ]);

  const ROBOT_STATES = new Set([
    "DISCONNECTED",
    "BRIDGE_UNAVAILABLE",
    "CONNECTED_DISARMED",
    "CONNECTED_ARMED_UNALIGNED",
    "RANGE_RECOVERY_REQUIRED",
    "READY",
    "ENGAGING",
    "LIVE_POSITION",
    "LIVE_SOFT_ORIENTATION",
    "LAGGING",
    "HOLDING",
    "STOPPED",
    "COMM_FAULT",
    "TRACKING_FAULT",
    "IK_FAULT"
  ]);

  const LIVE_ROBOT_STATES = new Set(["ENGAGING", "LIVE_POSITION", "LIVE_SOFT_ORIENTATION", "LAGGING", "HOLDING"]);
  const ARMED_ROBOT_STATES = new Set([
    "CONNECTED_ARMED_UNALIGNED",
    "RANGE_RECOVERY_REQUIRED",
    "READY",
    "ENGAGING",
    "LIVE_POSITION",
    "LIVE_SOFT_ORIENTATION",
    "LAGGING",
    "HOLDING",
    "TRACKING_FAULT",
    "IK_FAULT"
  ]);

  const ROUTES = Object.freeze({
    state: Object.freeze(["GET", "/robots/{robot_id}/phone-leader/v1/state"]),
    pairingCreate: Object.freeze(["POST", "/robots/{robot_id}/phone-leader/v1/pairing"]),
    pairingCancel: Object.freeze(["DELETE", "/robots/{robot_id}/phone-leader/v1/pairing"]),
    configUpdate: Object.freeze(["PUT", "/robots/{robot_id}/phone-leader/v1/config"]),
    activate: Object.freeze(["POST", "/robots/{robot_id}/phone-leader/v1/activate"]),
    align: Object.freeze(["POST", "/robots/{robot_id}/phone-leader/v1/align"]),
    cancel: Object.freeze(["POST", "/robots/{robot_id}/phone-leader/v1/cancel"]),
    exit: Object.freeze(["POST", "/robots/{robot_id}/phone-leader/v1/exit"]),
    diagnostics: Object.freeze(["GET", "/robots/{robot_id}/phone-leader/v1/diagnostics"])
  });

  const ROBOT_ROUTES = Object.freeze({
    state: Object.freeze(["GET", "/robots/{robot_id}/state"]),
    arm: Object.freeze(["POST", "/robots/{robot_id}/arm"]),
    disarm: Object.freeze(["POST", "/robots/{robot_id}/disarm"]),
    home: Object.freeze(["POST", "/robots/{robot_id}/home"]),
    stop: Object.freeze(["POST", "/robots/{robot_id}/stop"])
  });

  const FAILURE_GUIDANCE = Object.freeze({
    BRIDGE_VERSION_MISMATCH: Object.freeze({
      title: "Phone Leader bridge update required",
      message: "Update the local bridge to Phone Leader v1. Simulation, Blockly, Python, Gemini, and joint-space Leader remain available.",
      tone: "warning"
    }),
    PHONE_SOURCE_STALE: Object.freeze({
      title: "Phone updates are stale",
      message: "Motion was canceled. Release the phone move control, restore the connection, then recenter and Align again.",
      tone: "error"
    }),
    PHONE_TRACKING_LOST: Object.freeze({
      title: "Phone tracking lost",
      message: "Motion was canceled. Move back into a well-lit tracking area, release the move control, then recenter and Align again.",
      tone: "error"
    }),
    PHONE_TRACKING_LIMITED: Object.freeze({
      title: "Phone tracking is limited",
      message: "Keep the move control released and improve the tracking view before continuing.",
      tone: "warning"
    }),
    IK_FAILED: Object.freeze({
      title: "Target could not be solved",
      message: "The bridge rejected the Cartesian target and requested a hold. Recenter inside the workspace before aligning again.",
      tone: "error"
    }),
    HOLD_FAILED: Object.freeze({
      title: "Measured hold failed",
      message: "The robot was disarmed because a measured hold could not be confirmed. Keep clear and use the global STOP if motion persists.",
      tone: "error"
    }),
    MOTION_CONFLICT: Object.freeze({
      title: "Another control owner is active",
      message: "Release the current robot activity and wait for the bridge to report owner idle before requesting Phone Leader control.",
      tone: "warning"
    }),
    RANGE_RECOVERY_REQUIRED: Object.freeze({
      title: "Bounded range recovery required",
      message: "Phone Leader is blocked until the existing recovery workflow returns the named joint to its effective range.",
      tone: "warning"
    }),
    MEASURED_FEEDBACK_STALE: Object.freeze({
      title: "Measured robot feedback is stale",
      message: "No Cartesian target is accepted until fresh measured feedback is available.",
      tone: "error"
    }),
    PHONE_PAIRING_EXPIRED: Object.freeze({
      title: "Pairing code expired",
      message: "Create a new short-lived pairing code. Pairing does not arm the robot or restore a prior session.",
      tone: "warning"
    }),
    ARM_REQUIRED: Object.freeze({
      title: "Robot is disarmed",
      message: "Complete connection, calibration, and effective-limit checks before explicitly arming.",
      tone: "warning"
    }),
    ALIGNMENT_REQUIRED: Object.freeze({
      title: "Alignment required",
      message: "Recenter the released phone and select Align. Alignment is not restored from a previous page load.",
      tone: "warning"
    }),
    WORKSPACE_LIMITED: Object.freeze({
      title: "Workspace boundary reached",
      message: "The applied target is bounded. Move the phone back toward the center of the configured workspace.",
      tone: "warning"
    }),
    STOPPED: Object.freeze({
      title: "Robot stopped",
      message: "Phone motion is retired. Reconnect, re-arm, and re-align explicitly before another engagement.",
      tone: "warning"
    })
  });

  const UNAVAILABLE_STATE = Object.freeze({
    schema: STATE_SCHEMA,
    sourceState: "UNPAIRED",
    robotState: "BRIDGE_UNAVAILABLE",
    owner: "idle",
    sourceSessionId: "",
    aligned: false,
    configFingerprint: "",
    acceptedSourceSequence: -1,
    appliedTickSequence: -1,
    sourceAgeMs: null,
    measuredAgeMs: null,
    controllerRateHz: 0,
    cycleMs: 0,
    flags: [],
    error: Object.freeze({
      code: "BRIDGE_VERSION_MISMATCH",
      message: "Phone Leader v1 is unavailable.",
      retryable: false,
      details: Object.freeze({})
    })
  });

  function routePath(route, robotId) {
    return route.replace("{robot_id}", encodeURIComponent(robotId));
  }

  function validateFiniteMetric(value, name, nullable) {
    if (nullable && value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative finite number${nullable ? " or null" : ""}.`);
    }
    return value;
  }

  function validatePhoneState(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("Phone Leader state must be an object.");
    }
    if (payload.schema !== STATE_SCHEMA) throw new TypeError(`Phone Leader state schema must be ${STATE_SCHEMA}.`);
    if (!SOURCE_STATES.has(payload.sourceState)) throw new TypeError("Phone Leader sourceState is invalid.");
    if (!ROBOT_STATES.has(payload.robotState)) throw new TypeError("Phone Leader robotState is invalid.");
    if (typeof payload.owner !== "string" || !payload.owner || payload.owner.length > 64) throw new TypeError("Phone Leader owner is invalid.");
    if (typeof payload.sourceSessionId !== "string" || payload.sourceSessionId.length > 128) throw new TypeError("Phone Leader sourceSessionId is invalid.");
    if (typeof payload.aligned !== "boolean") throw new TypeError("Phone Leader aligned must be boolean.");
    if (typeof payload.configFingerprint !== "string" || (payload.configFingerprint && !/^[0-9a-f]{64}$/.test(payload.configFingerprint))) {
      throw new TypeError("Phone Leader configFingerprint is invalid.");
    }
    ["acceptedSourceSequence", "appliedTickSequence"].forEach((key) => {
      if (!Number.isInteger(payload[key]) || payload[key] < -1) throw new TypeError(`${key} must be an integer of -1 or greater.`);
    });
    validateFiniteMetric(payload.sourceAgeMs, "sourceAgeMs", true);
    validateFiniteMetric(payload.measuredAgeMs, "measuredAgeMs", true);
    validateFiniteMetric(payload.controllerRateHz, "controllerRateHz", false);
    validateFiniteMetric(payload.cycleMs, "cycleMs", false);
    if (!Array.isArray(payload.flags) || payload.flags.some((flag) => typeof flag !== "string" || flag.length > 96)) {
      throw new TypeError("Phone Leader flags are invalid.");
    }
    if (payload.error !== null) {
      if (!payload.error || typeof payload.error !== "object" || typeof payload.error.code !== "string" || typeof payload.error.message !== "string" || typeof payload.error.retryable !== "boolean" || !payload.error.details || typeof payload.error.details !== "object" || Array.isArray(payload.error.details)) {
        throw new TypeError("Phone Leader error is invalid.");
      }
    }
    return payload;
  }

  function normalizeBaseUrl(value) {
    const url = new URL(String(value || ""), global.location.href);
    if (url.username || url.password || url.search || url.hash) throw new TypeError("Bridge base URL cannot include credentials, query, or fragment.");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("Bridge base URL must use HTTP or HTTPS.");
    return url.href.replace(/\/$/, "");
  }

  function createFetchService(options) {
    const settings = options || {};
    const baseUrl = normalizeBaseUrl(settings.baseUrl);
    const robotId = String(settings.robotId || ROBOT_ID);
    const tokenProvider = typeof settings.tokenProvider === "function" ? settings.tokenProvider : () => "";
    const listeners = new Set();
    let pollTimer = 0;
    let pollInFlight = false;
    let compatibilityChecked = false;

    async function request(route, body, requestOptions) {
      const [method, template] = route;
      const requestSettings = requestOptions || {};
      const headers = { Accept: "application/json" };
      const token = String(tokenProvider() || "");
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await global.fetch(`${baseUrl}${routePath(template, robotId)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        keepalive: requestSettings.keepalive === true
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload && payload.error && payload.error.message ? payload.error.message : `Bridge request failed (${response.status}).`);
        error.code = payload && payload.error && payload.error.code ? payload.error.code : "BRIDGE_REQUEST_FAILED";
        error.details = payload && payload.error && payload.error.details ? payload.error.details : {};
        throw error;
      }
      return payload;
    }

    async function getSnapshot() {
      if (!compatibilityChecked) {
        const health = await request(Object.freeze(["GET", "/health"]));
        if (!health || !Array.isArray(health.capabilities) || !health.capabilities.includes("phone_leader_v1")) {
          const error = new Error("The local bridge does not advertise Phone Leader v1.");
          error.code = "BRIDGE_VERSION_MISMATCH";
          throw error;
        }
        compatibilityChecked = true;
      }
      const [phoneResponse, robotState] = await Promise.all([
        request(ROUTES.state),
        request(ROBOT_ROUTES.state).catch(() => null)
      ]);
      const state = validatePhoneState(phoneResponse && phoneResponse.state ? phoneResponse.state : phoneResponse);
      return { ...(phoneResponse && phoneResponse.state ? phoneResponse : {}), state, robot: robotState };
    }

    async function publishSnapshot() {
      if (pollInFlight || !listeners.size) return;
      pollInFlight = true;
      try {
        const snapshot = await getSnapshot();
        listeners.forEach((listener) => listener(snapshot));
      } catch (_error) {
        // The panel's explicit refresh/action paths surface bridge errors. A
        // telemetry poll never converts a transient outage into local state.
      } finally {
        pollInFlight = false;
      }
    }

    function subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      if (!pollTimer) pollTimer = global.setInterval(() => void publishSnapshot(), 150);
      void publishSnapshot();
      return () => {
        listeners.delete(listener);
        if (!listeners.size && pollTimer) {
          global.clearInterval(pollTimer);
          pollTimer = 0;
        }
      };
    }

    return Object.freeze({
      available: true,
      getSnapshot,
      subscribe,
      createPairing: () => request(ROUTES.pairingCreate, {}),
      cancelPairing: () => request(ROUTES.pairingCancel),
      updateConfig: (change) => request(ROUTES.configUpdate, change),
      activate: () => request(ROUTES.activate, {}),
      align: () => request(ROUTES.align, {}),
      cancel: (detail) => request(ROUTES.cancel, detail || { reason: "supervisor_cancel" }),
      exit: (detail) => request(ROUTES.exit, detail || { reason: "supervisor_exit" }, { keepalive: true }),
      arm: () => request(ROBOT_ROUTES.arm, {}),
      disarm: () => request(ROBOT_ROUTES.disarm, {}),
      home: () => request(ROBOT_ROUTES.home, {}),
      stop: () => request(ROBOT_ROUTES.stop, { source: "phone_leader_supervisor" }),
      exportDiagnostics: () => request(ROUTES.diagnostics)
    });
  }

  function createUnavailableService() {
    return Object.freeze({
      available: false,
      getSnapshot: async () => ({ state: UNAVAILABLE_STATE })
    });
  }

  function stateFromResult(result) {
    if (result && result.state) return result.state;
    if (result && result.schema === STATE_SCHEMA) return result;
    return null;
  }

  function displayStateName(value) {
    return String(value || "—").toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
  }

  function metric(value, suffix, digits) {
    return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)} ${suffix}` : "—";
  }

  function formatPose(value) {
    if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)) {
      return `x ${value[0].toFixed(3)} · y ${value[1].toFixed(3)} · z ${value[2].toFixed(3)} m`;
    }
    if (typeof value === "string" && value.length <= 96) return value;
    return "—";
  }

  function safePairingUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(String(value));
      if (url.protocol !== "https:" || url.username || url.password || url.hash || !isPrivatePhoneHost(url.hostname)) return null;
      const keys = Array.from(url.searchParams.keys());
      if (keys.length !== 1 || keys[0] !== "pair" || !/^[A-Za-z0-9_-]{8,128}$/.test(url.searchParams.get("pair") || "")) return null;
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function safeQrImage(value) {
    if (!value) return null;
    const text = String(value);
    return /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(text) && text.length <= 200000 ? text : null;
  }

  function isPrivatePhoneHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".local") || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) || /^169\.254\./.test(host) || /^(fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*$/i.test(host);
  }

  function redactDiagnostics(value, depth) {
    if (depth > 12) return "[TRUNCATED]";
    if (Array.isArray(value)) return value.slice(0, 2000).map((item) => redactDiagnostics(item, depth + 1));
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && value.length > 4096) return `${value.slice(0, 4096)}…`;
      return value;
    }
    const result = {};
    Object.entries(value).forEach(([key, item]) => {
      if (/(token|secret|credential|authorization|bearer|cookie|private[_-]?key|file[_-]?id|sha256|(^|_)path$|local[_-]?file|image|camera[_-]?frame|screenshot|pixels|blob)/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactDiagnostics(item, depth + 1);
      }
    });
    return result;
  }

  function downloadJson(payload) {
    const data = JSON.stringify(redactDiagnostics(payload, 0), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `robobuddy-phone-leader-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function guidanceForState(state) {
    if (state.error && FAILURE_GUIDANCE[state.error.code]) return FAILURE_GUIDANCE[state.error.code];
    if (state.error) {
      return {
        title: displayStateName(state.error.code),
        message: state.error.message || "The bridge blocked Phone Leader motion.",
        tone: "error"
      };
    }
    if (state.owner !== "idle" && state.owner !== PHONE_OWNER) return FAILURE_GUIDANCE.MOTION_CONFLICT;
    if (state.sourceState === "SOURCE_STALE") return FAILURE_GUIDANCE.PHONE_SOURCE_STALE;
    if (state.sourceState === "SOURCE_LOST") return FAILURE_GUIDANCE.PHONE_TRACKING_LOST;
    if (state.robotState === "IK_FAULT") return FAILURE_GUIDANCE.IK_FAILED;
    if (state.robotState === "TRACKING_FAULT") return FAILURE_GUIDANCE.PHONE_TRACKING_LOST;
    if (state.robotState === "RANGE_RECOVERY_REQUIRED") return FAILURE_GUIDANCE.RANGE_RECOVERY_REQUIRED;
    if (state.robotState === "STOPPED") return FAILURE_GUIDANCE.STOPPED;
    return null;
  }

  function normalizeGate(value, fallbackReady, readyLabel, pendingLabel) {
    if (value && typeof value === "object") {
      const ready = value.ready === true || value.state === "ready";
      const state = ["ready", "warning", "error", "pending"].includes(value.state) ? value.state : (ready ? "ready" : "pending");
      return { ready, state, label: String(value.label || (ready ? readyLabel : pendingLabel)).slice(0, 96) };
    }
    const ready = typeof value === "boolean" ? value : fallbackReady;
    return { ready, state: ready ? "ready" : "pending", label: ready ? readyLabel : pendingLabel };
  }

  function readinessFromSnapshot(snapshot, state) {
    const supplied = snapshot.readiness || {};
    const bridgeReady = state.robotState !== "BRIDGE_UNAVAILABLE";
    const robotReady = bridgeReady && state.robotState !== "DISCONNECTED";
    const armed = ARMED_ROBOT_STATES.has(state.robotState);
    const phoneReady = !["UNPAIRED", "PAIRING", "SOURCE_DISCONNECTED"].includes(state.sourceState);
    const trackingReady = ["SOURCE_TRACKING", "SOURCE_READY"].includes(state.sourceState);
    const ownerReady = state.owner === "idle" || state.owner === PHONE_OWNER;
    return {
      bridge: normalizeGate(supplied.bridge, bridgeReady, "Phone Leader v1", "Unavailable"),
      robot: normalizeGate(supplied.robot, robotReady, "Connected", "Disconnected"),
      calibration: normalizeGate(supplied.calibration, false, "Verified", "Not verified"),
      limits: normalizeGate(supplied.limits, false, "Effective limits", "Not verified"),
      arm: normalizeGate(supplied.arm, armed, "Armed", "Disarmed"),
      phone: normalizeGate(supplied.phone, phoneReady, "Paired", state.sourceState === "PAIRING" ? "Pairing" : "Unpaired"),
      tracking: normalizeGate(supplied.tracking, trackingReady, "Tracking", displayStateName(state.sourceState)),
      alignment: normalizeGate(supplied.alignment, state.aligned, "Aligned", "Required"),
      owner: normalizeGate(supplied.owner, ownerReady, state.owner === PHONE_OWNER ? "Phone Leader" : "Idle", displayStateName(state.owner))
    };
  }

  class PhoneLeaderPanel {
    constructor(panel, service) {
      this.panel = panel;
      this.service = service || createUnavailableService();
      this.state = UNAVAILABLE_STATE;
      this.snapshot = { state: UNAVAILABLE_STATE };
      this.pairing = null;
      this.recording = false;
      this.busy = false;
      this.unsubscribe = null;
      this.announcementTimer = 0;
      this.announcementGeneration = 0;
      this.lastAnnouncementAt = -Infinity;
      this.lastAnnouncement = "";
      this.transitionReplay = false;
      this.elements = this.collectElements();
      this.confirmedRobotSelection = this.elements.robotChooser ? this.elements.robotChooser.value : ROBOT_ID;
      this.bind();
      this.syncRobotVisibility();
      this.renderSnapshot(this.snapshot, { announce: false });
      this.attachService(this.service);
    }

    collectElements() {
      const byId = (id) => document.getElementById(id);
      return {
        toggle: byId("phoneLeaderToggle"),
        body: byId("phoneLeaderBody"),
        stateChip: byId("phoneLeaderStateChip"),
        status: byId("phoneLeaderStatus"),
        announcer: byId("phoneLeaderAnnouncements"),
        robotState: byId("phoneLeaderRobotState"),
        sourceState: byId("phoneLeaderSourceState"),
        owner: byId("phoneLeaderOwner"),
        refresh: byId("phoneLeaderRefresh"),
        pairExpiry: byId("phoneLeaderPairExpiry"),
        qrFrame: byId("phoneLeaderQrFrame"),
        qrImage: byId("phoneLeaderQrImage"),
        qrPlaceholder: byId("phoneLeaderQrPlaceholder"),
        pairLink: byId("phoneLeaderPairLink"),
        pair: byId("phoneLeaderPair"),
        cancelPair: byId("phoneLeaderCancelPair"),
        configLock: byId("phoneLeaderConfigLock"),
        workspace: byId("phoneLeaderWorkspace"),
        gripperSpeed: byId("phoneLeaderGripperSpeed"),
        gripperSpeedValue: byId("phoneLeaderGripperSpeedValue"),
        align: byId("phoneLeaderAlign"),
        arm: byId("phoneLeaderArm"),
        disarm: byId("phoneLeaderDisarm"),
        home: byId("phoneLeaderHome"),
        stop: byId("phoneLeaderStop"),
        inputPose: byId("phoneLeaderInputPose"),
        targetPose: byId("phoneLeaderTargetPose"),
        measuredPose: byId("phoneLeaderMeasuredPose"),
        sourceAge: byId("phoneLeaderSourceAge"),
        controllerRate: byId("phoneLeaderControllerRate"),
        measuredAge: byId("phoneLeaderMeasuredAge"),
        cycleTime: byId("phoneLeaderCycleTime"),
        fault: byId("phoneLeaderFault"),
        faultTitle: byId("phoneLeaderFaultTitle"),
        faultMessage: byId("phoneLeaderFaultMessage"),
        recordingState: byId("phoneLeaderRecordingState"),
        recordStart: byId("phoneLeaderRecordStart"),
        recordStop: byId("phoneLeaderRecordStop"),
        export: byId("phoneLeaderExport"),
        robotChooser: byId("robotChooser")
      };
    }

    bind() {
      this.elements.toggle.addEventListener("click", () => void this.toggleExpanded());
      this.elements.refresh.addEventListener("click", () => void this.refresh({ announce: true }));
      this.elements.pair.addEventListener("click", () => void this.perform("createPairing", undefined, "Creating a short-lived pairing code…"));
      this.elements.cancelPair.addEventListener("click", () => void this.perform("cancelPairing", undefined, "Canceling the pairing code…"));
      this.elements.align.addEventListener("click", () => void this.perform("align", undefined, "Requesting phone-to-robot alignment…"));
      this.elements.arm.addEventListener("click", () => void this.perform("arm", undefined, "Requesting explicit arm…"));
      this.elements.disarm.addEventListener("click", () => void this.perform("disarm", undefined, "Requesting disarm…"));
      this.elements.home.addEventListener("click", () => void this.perform("home", undefined, "Requesting Home while owner is idle…"));
      this.elements.stop.addEventListener("click", () => void this.perform("stop", undefined, "Requesting authoritative STOP…", { force: true }));
      this.elements.recordStart.addEventListener("click", () => void this.perform("startRecording", undefined, "Starting local diagnostic recording…"));
      this.elements.recordStop.addEventListener("click", () => void this.perform("stopRecording", undefined, "Stopping local diagnostic recording…"));
      this.elements.export.addEventListener("click", () => void this.exportDiagnostics());

      document.querySelectorAll('input[name="phoneLeaderOrientation"]').forEach((input) => {
        input.addEventListener("change", (event) => {
          if (event.target.checked) void this.updateConfig({ orientationMode: event.target.value }, event.target);
        });
      });
      document.querySelectorAll('input[name="phoneLeaderScale"]').forEach((input) => {
        input.addEventListener("change", (event) => {
          if (event.target.checked) void this.updateConfig({ scale: event.target.value }, event.target);
        });
      });
      this.elements.workspace.addEventListener("change", (event) => void this.updateConfig({ workspacePreset: event.target.value }, event.target));
      this.elements.gripperSpeed.addEventListener("input", () => {
        this.elements.gripperSpeedValue.textContent = `${this.elements.gripperSpeed.value}%/s`;
      });
      this.elements.gripperSpeed.addEventListener("change", (event) => void this.updateConfig({ gripperSpeedPctS: Number(event.target.value) }, event.target));

      if (this.elements.robotChooser) {
        this.elements.robotChooser.addEventListener("change", (event) => {
          const requested = this.elements.robotChooser.value;
          if (this.transitionReplay || !this.needsSafeExit()) {
            this.confirmedRobotSelection = requested;
            this.syncRobotVisibility();
            return;
          }
          event.preventDefault();
          event.stopImmediatePropagation();
          this.elements.robotChooser.value = this.confirmedRobotSelection;
          void this.confirmRobotTransition(requested);
        }, { capture: true });
      }
      document.querySelectorAll("[data-workbench-mode-option]").forEach((button) => {
        button.addEventListener("click", (event) => {
          if (this.transitionReplay || !this.needsSafeExit()) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          void this.confirmModeTransition(button);
        }, { capture: true });
      });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden && this.needsSafeExit()) void this.requestExit("supervisor_hidden");
      });
      global.addEventListener("pagehide", () => {
        if (this.needsSafeExit() && this.hasAction("exit")) {
          void this.service.exit({ reason: "supervisor_pagehide" });
        }
      });
    }

    syncRobotVisibility() {
      const selected = this.elements.robotChooser ? this.elements.robotChooser.value : ROBOT_ID;
      this.panel.hidden = selected !== ROBOT_ID;
    }

    attachService(service) {
      if (typeof this.unsubscribe === "function") this.unsubscribe();
      this.unsubscribe = null;
      this.service = service && typeof service.getSnapshot === "function" ? service : createUnavailableService();
      if (typeof this.service.subscribe === "function") {
        const unsubscribe = this.service.subscribe((snapshot) => {
          try {
            this.renderSnapshot(snapshot, { announce: true });
          } catch (error) {
            this.renderClientFailure(error);
          }
        });
        if (typeof unsubscribe === "function") this.unsubscribe = unsubscribe;
      }
      void this.refresh({ announce: false });
    }

    setService(service) {
      this.pairing = null;
      this.recording = false;
      this.renderSnapshot({ state: UNAVAILABLE_STATE }, { announce: false });
      this.attachService(service);
    }

    async toggleExpanded() {
      const open = this.elements.toggle.getAttribute("aria-expanded") === "true";
      if (open && this.needsSafeExit()) {
        const released = await this.requestExit("supervisor_panel_closed");
        if (!released) return;
      }
      this.elements.toggle.setAttribute("aria-expanded", open ? "false" : "true");
      this.elements.toggle.querySelector("span").textContent = open ? "Open supervisor" : "Close supervisor";
      this.elements.body.hidden = open;
      if (!open) await this.refresh({ announce: false });
    }

    async refresh(options) {
      try {
        const snapshot = await this.service.getSnapshot();
        this.renderSnapshot(snapshot, options || {});
        return snapshot;
      } catch (error) {
        this.renderClientFailure(error);
        return null;
      }
    }

    renderClientFailure(error) {
      const code = error && error.code === "BRIDGE_VERSION_MISMATCH" ? error.code : "BRIDGE_VERSION_MISMATCH";
      const state = {
        ...UNAVAILABLE_STATE,
        error: { code, message: error && error.message ? String(error.message) : "Phone Leader v1 is unavailable.", retryable: true, details: {} }
      };
      this.renderSnapshot({ state }, { announce: true });
    }

    renderSnapshot(input, options) {
      const snapshot = input && input.state ? input : { state: input };
      const state = validatePhoneState(snapshot.state);
      this.snapshot = snapshot;
      this.state = state;
      if (snapshot.pairing !== undefined) this.pairing = snapshot.pairing;
      if (typeof snapshot.recording === "boolean") this.recording = snapshot.recording;

      this.panel.dataset.availability = this.service.available === false || state.robotState === "BRIDGE_UNAVAILABLE" ? "unavailable" : "available";
      this.elements.robotState.textContent = state.robotState;
      this.elements.sourceState.textContent = state.sourceState;
      this.elements.owner.textContent = state.owner;
      this.elements.sourceAge.textContent = metric(state.sourceAgeMs, "ms", 0);
      this.elements.controllerRate.textContent = metric(state.controllerRateHz, "Hz", 1);
      this.elements.measuredAge.textContent = metric(state.measuredAgeMs, "ms", 0);
      this.elements.cycleTime.textContent = metric(state.cycleMs, "ms", 1);

      const authorities = snapshot.authorities || {};
      this.elements.inputPose.textContent = formatPose(authorities.input);
      this.elements.targetPose.textContent = formatPose(authorities.target);
      this.elements.measuredPose.textContent = formatPose(authorities.measured);

      const readiness = readinessFromSnapshot(snapshot, state);
      Object.entries(readiness).forEach(([key, gate]) => {
        const item = this.panel.querySelector(`[data-phone-readiness="${key}"]`);
        if (!item) return;
        item.dataset.state = gate.state;
        const label = item.querySelector("small");
        if (label) label.textContent = gate.label;
      });

      this.renderPairing();
      const guidance = guidanceForState(state);
      this.renderGuidance(guidance);
      this.renderStateSummary(guidance);
      this.renderControls(readiness);
      this.elements.recordingState.textContent = this.recording ? "Recording" : "Not recording";
      if (options && options.announce !== false) this.announce(this.elements.status.textContent);
    }

    renderPairing() {
      const pairing = this.pairing && typeof this.pairing === "object" ? this.pairing : null;
      const image = pairing ? safeQrImage(pairing.qrImageSrc) : null;
      const link = pairing ? safePairingUrl(pairing.phoneUrl) : null;
      this.elements.qrImage.hidden = !image;
      this.elements.qrPlaceholder.hidden = Boolean(image);
      this.elements.qrFrame.dataset.state = image ? "ready" : "empty";
      if (image) this.elements.qrImage.src = image;
      else this.elements.qrImage.removeAttribute("src");
      this.elements.pairLink.hidden = !link;
      if (link) this.elements.pairLink.href = link;
      else this.elements.pairLink.removeAttribute("href");
      const expires = pairing && (pairing.expiresInSeconds ?? pairing.expiresInS);
      this.elements.pairExpiry.textContent = Number.isFinite(expires) && expires >= 0 ? `Expires in ${Math.ceil(expires)} s` : "No active code";
    }

    renderGuidance(guidance) {
      if (!guidance) {
        this.elements.fault.dataset.tone = "idle";
        this.elements.faultTitle.textContent = "No active fault";
        this.elements.faultMessage.textContent = "Phone motion remains blocked until every readiness gate is confirmed.";
        return;
      }
      this.elements.fault.dataset.tone = guidance.tone;
      this.elements.faultTitle.textContent = guidance.title;
      this.elements.faultMessage.textContent = guidance.message;
    }

    renderStateSummary(guidance) {
      let label = displayStateName(this.state.robotState);
      let message = "Phone Leader is idle. Complete the readiness chain before engagement.";
      let tone = "warning";
      if (guidance) {
        label = guidance.title;
        message = guidance.message;
        tone = guidance.tone;
      } else if (["LIVE_POSITION", "LIVE_SOFT_ORIENTATION"].includes(this.state.robotState)) {
        label = this.state.robotState === "LIVE_POSITION" ? "Live · position only" : "Live · soft orientation";
        message = "Phone Leader is active. Release the phone move control to hold; use STOP for immediate retirement.";
        tone = "active";
      } else if (this.state.robotState === "READY") {
        label = "Ready";
        message = "Bridge, robot, phone, tracking, and alignment are ready. Motion still requires the phone hold-to-move control.";
        tone = "ready";
      } else if (this.state.robotState === "CONNECTED_ARMED_UNALIGNED") {
        label = "Align required";
        message = "Recenter the released phone, then select Align. No motion is sent by alignment.";
      } else if (this.state.robotState === "CONNECTED_DISARMED") {
        label = "Disarmed";
        message = "Verify calibration and effective limits before explicitly arming the SO-101.";
      }
      this.elements.stateChip.textContent = label;
      this.elements.stateChip.dataset.tone = tone;
      this.elements.status.textContent = message;
      this.elements.status.dataset.tone = tone;
    }

    hasAction(name) {
      return this.service && typeof this.service[name] === "function";
    }

    renderControls(readiness) {
      const live = this.isLive();
      const available = this.service.available !== false && this.state.robotState !== "BRIDGE_UNAVAILABLE";
      const armed = ARMED_ROBOT_STATES.has(this.state.robotState);
      const sourceReady = ["SOURCE_TRACKING", "SOURCE_READY"].includes(this.state.sourceState);
      const pairedOrPairing = Boolean(this.pairing) || this.state.sourceState === "PAIRING";
      const ownerIdle = this.state.owner === "idle";
      const baseReady = readiness.bridge.ready && readiness.robot.ready && readiness.calibration.ready && readiness.limits.ready;

      this.elements.pair.disabled = this.busy || !available || !this.hasAction("createPairing") || pairedOrPairing;
      this.elements.cancelPair.disabled = this.busy || !this.hasAction("cancelPairing") || !pairedOrPairing;
      this.elements.arm.disabled = this.busy || !available || !this.hasAction("arm") || armed || !baseReady || !ownerIdle;
      this.elements.disarm.disabled = this.busy || !available || !this.hasAction("disarm") || !armed;
      this.elements.align.disabled = this.busy || !available || !this.hasAction("align") || !armed || !sourceReady || (!ownerIdle && this.state.owner !== PHONE_OWNER);
      this.elements.home.disabled = this.busy || !available || !this.hasAction("home") || !ownerIdle || !readiness.robot.ready;
      this.elements.stop.disabled = this.busy || !available || !this.hasAction("stop");
      this.elements.recordStart.disabled = this.busy || !available || !this.hasAction("startRecording") || this.recording;
      this.elements.recordStop.disabled = this.busy || !this.hasAction("stopRecording") || !this.recording;
      this.elements.export.disabled = this.busy || !this.hasAction("exportDiagnostics");

      this.panel.querySelectorAll("[data-phone-config], [data-phone-config-group] input").forEach((control) => {
        control.disabled = this.busy || !available || !this.hasAction("updateConfig") || live;
      });
      this.elements.configLock.textContent = live ? "Locked while live" : "Editable while idle";
    }

    isLive() {
      return LIVE_ROBOT_STATES.has(this.state.robotState);
    }

    needsSafeExit() {
      return Boolean(
        this.pairing
        || this.state.sourceState !== "UNPAIRED"
        || this.state.aligned
        || ARMED_ROBOT_STATES.has(this.state.robotState)
        || this.state.owner === PHONE_OWNER
      );
    }

    async requestExit(reason) {
      if (!this.hasAction("exit")) {
        this.setTransientStatus("Phone exit could not be confirmed. Keep this view open and use the global STOP.", "error", true);
        return false;
      }
      try {
        const result = await this.service.exit({ reason });
        const nextState = stateFromResult(result);
        if (nextState) this.renderSnapshot(result.state ? result : { state: nextState }, { announce: true });
        else await this.refresh({ announce: true });
        if (this.needsSafeExit()) {
          this.setTransientStatus("The bridge has not confirmed source retirement and disarm. The requested exit remains blocked.", "error", true);
          return false;
        }
        return true;
      } catch (error) {
        this.setTransientStatus(error && error.message ? String(error.message) : "Phone exit could not be confirmed.", "error", true);
        return false;
      }
    }

    async confirmModeTransition(button) {
      if (!(await this.requestExit("workbench_mode_exit"))) return;
      this.transitionReplay = true;
      try {
        button.click();
      } finally {
        this.transitionReplay = false;
      }
    }

    async confirmRobotTransition(requested) {
      if (!(await this.requestExit("robot_selection_change"))) return;
      this.transitionReplay = true;
      try {
        this.elements.robotChooser.value = requested;
        this.elements.robotChooser.dispatchEvent(new Event("change", { bubbles: true }));
        this.confirmedRobotSelection = requested;
        this.syncRobotVisibility();
      } finally {
        this.transitionReplay = false;
      }
    }

    async requestCancel(reason) {
      if (!this.hasAction("cancel")) {
        this.setTransientStatus("Phone release could not be confirmed. Keep the panel open and use the global STOP.", "error", true);
        return false;
      }
      try {
        const result = await this.service.cancel({ reason });
        const nextState = stateFromResult(result);
        if (nextState) this.renderSnapshot(result.state ? result : { state: nextState }, { announce: true });
        else await this.refresh({ announce: true });
        if (this.isLive()) {
          this.setTransientStatus("The bridge has not confirmed release. The requested exit remains blocked.", "error", true);
          return false;
        }
        return true;
      } catch (error) {
        this.setTransientStatus(error && error.message ? String(error.message) : "Phone release could not be confirmed.", "error", true);
        return false;
      }
    }

    async updateConfig(change, control) {
      const previous = control.dataset.confirmedValue || control.defaultValue || control.value;
      if (this.isLive() && !(await this.requestCancel("configuration_change"))) {
        if (control.type === "radio") {
          const prior = document.querySelector(`input[name="${control.name}"][value="${CSS.escape(previous)}"]`);
          if (prior) prior.checked = true;
        } else {
          control.value = previous;
        }
        return;
      }
      const ok = await this.perform("updateConfig", change, "Applying an idle-only configuration change…");
      if (ok) control.dataset.confirmedValue = control.value;
    }

    async perform(name, argument, pendingText, options) {
      if (!this.hasAction(name) || (this.busy && !(options && options.force))) return false;
      this.busy = true;
      this.setTransientStatus(pendingText, "active", false);
      this.renderControls(readinessFromSnapshot(this.snapshot, this.state));
      try {
        const result = argument === undefined ? await this.service[name]() : await this.service[name](argument);
        if (name === "createPairing") {
          this.pairing = result && result.pairing ? result.pairing : result;
          this.renderPairing();
        } else if (name === "cancelPairing") {
          this.pairing = null;
          this.renderPairing();
        } else if (name === "startRecording") {
          this.recording = true;
        } else if (name === "stopRecording") {
          this.recording = false;
        }
        const nextState = stateFromResult(result);
        if (nextState) this.renderSnapshot(result.state ? result : { state: nextState }, { announce: true });
        else await this.refresh({ announce: true });
        return true;
      } catch (error) {
        this.setTransientStatus(error && error.message ? String(error.message) : "The bridge rejected the request.", "error", true);
        return false;
      } finally {
        this.busy = false;
        this.renderControls(readinessFromSnapshot(this.snapshot, this.state));
        this.elements.recordingState.textContent = this.recording ? "Recording" : "Not recording";
      }
    }

    async exportDiagnostics() {
      if (!this.hasAction("exportDiagnostics") || this.busy) return;
      this.busy = true;
      try {
        const payload = await this.service.exportDiagnostics();
        if (!payload || typeof payload !== "object" || payload instanceof Blob) throw new TypeError("Diagnostics export must provide a redacted structured payload.");
        downloadJson(payload);
        this.setTransientStatus("Safe local diagnostics exported. Credentials and local path material were redacted.", "ready", true);
      } catch (error) {
        this.setTransientStatus(error && error.message ? String(error.message) : "Diagnostics export failed.", "error", true);
      } finally {
        this.busy = false;
        this.renderControls(readinessFromSnapshot(this.snapshot, this.state));
      }
    }

    setTransientStatus(message, tone, announce) {
      this.elements.status.textContent = String(message || "");
      this.elements.status.dataset.tone = tone;
      if (announce) this.announce(message);
    }

    announce(message) {
      const text = String(message || "").trim();
      if (!text || text === this.lastAnnouncement) return;
      const now = performance.now();
      const generation = ++this.announcementGeneration;
      const commit = () => {
        if (generation !== this.announcementGeneration) return;
        this.announcementTimer = 0;
        this.lastAnnouncement = text;
        this.lastAnnouncementAt = performance.now();
        this.elements.announcer.textContent = text;
        const count = Number(this.elements.announcer.dataset.announcementCount || "0") + 1;
        this.elements.announcer.dataset.announcementCount = String(count);
      };
      global.clearTimeout(this.announcementTimer);
      if (now - this.lastAnnouncementAt >= ANNOUNCEMENT_INTERVAL_MS) {
        commit();
      } else {
        this.announcementTimer = global.setTimeout(commit, ANNOUNCEMENT_INTERVAL_MS - (now - this.lastAnnouncementAt));
      }
    }
  }

  let panelController = null;
  let runtimeServiceKey = "";

  function syncRuntimeService() {
    const runtime = global.RoboAdmin && global.RoboAdmin.RobotRuntime;
    const adapter = runtime && typeof runtime.getBridgeAdapter === "function" ? runtime.getBridgeAdapter() : null;
    const key = adapter ? `${adapter.baseUrl}\n${adapter.token || ""}` : "";
    if (key === runtimeServiceKey) return;
    runtimeServiceKey = key;
    const service = adapter
      ? createFetchService({
          baseUrl: adapter.baseUrl,
          robotId: ROBOT_ID,
          tokenProvider: () => adapter.token || ""
        })
      : createUnavailableService();
    global.RoboBuddyPhoneLeaderService = service;
    if (panelController) panelController.setService(service);
  }

  function initialize() {
    const panel = document.getElementById("phoneLeaderPanel");
    if (!panel || panelController) return panelController;
    panelController = new PhoneLeaderPanel(panel, global.RoboBuddyPhoneLeaderService || createUnavailableService());
    syncRuntimeService();
    return panelController;
  }

  global.RoboBuddyPhoneLeaderUI = Object.freeze({
    STATE_SCHEMA,
    PHONE_OWNER,
    ROUTES,
    ROBOT_ROUTES,
    validatePhoneState,
    createFetchService,
    createUnavailableService,
    initialize,
    getPanel: () => panelController,
    setService: (service) => {
      const controller = initialize();
      if (controller) controller.setService(service);
    }
  });

  global.addEventListener("robobuddy:robot-state-change", syncRuntimeService);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})(window);
