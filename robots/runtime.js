(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  const safety = NS.RobotSafety;
  const schema = NS.RobotCommandSchema;
  const simulation = NS.RobotSimulation;
  const hardware = NS.RobotHardware;

  let state = null;
  let simAdapter = null;
  let simContainer = null;
  let bridgeAdapter = null;
  let bridgeSafetyConfirmed = false;
  let bridgeDisarmPending = false;
  let manualResponseEpoch = 0;
  let activeManualSessionId = "";
  let activeManualSequence = -1;
  let connectionEpoch = 0;
  let leaderResponseEpoch = 0;
  let leaderStartAbortController = null;
  let leaderAbortController = null;
  let leaderFrameTimer = null;
  let leaderObservationTimer = null;
  let leaderObservationInFlight = false;
  let leaderPendingFrame = null;
  let leaderFrameInFlight = null;
  let leaderFrameSnapshot = null;
  let leaderLastSentAt = 0;
  let recoveryAbortController = null;
  let recoveryResponseEpoch = 0;
  let recoveryStepPending = false;
  let recoveryStepDrainPromise = null;
  let recoveryStartPromise = null;
  let recoveryReleaseDuringStart = "";
  let leaderStartPromise = null;
  let leaderReleaseDuringStart = "";

  const LEADER_REQUIRED_CAPABILITIES = ["strict_observation_v1", "virtual_leader_v1", "range_recovery_v1"];
  const PROGRAM_REQUIRED_CAPABILITIES = [
    "absolute_program_targets_v1",
    "bounded_absolute_program_motion_v1"
  ];
  const COMPLETE_JOINT_IDS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
  const LEADER_PROTOCOL_MAX_FRAME_RATE_HZ = 30;
  const LEADER_FINAL_WAIT_MS = 100;
  const BRIDGE_SESSION_STORAGE_KEY = "robobuddy.so101BridgeSession.v1";
  const BRIDGE_SESSION_SCHEMA = "robobuddy.so101-bridge-session.v1";

  function clearWindowTimeout(timer) {
    if (timer !== null && window && typeof window.clearTimeout === "function") window.clearTimeout(timer);
  }

  function clearWindowInterval(timer) {
    if (timer !== null && window && typeof window.clearInterval === "function") window.clearInterval(timer);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function completePose(value, fallback) {
    const source = value && typeof value === "object" ? value : {};
    const backup = fallback && typeof fallback === "object" ? fallback : {};
    const manifest = getManifest();
    const pose = {};
    (manifest && manifest.joints ? manifest.joints : []).forEach((joint) => {
      const raw = Object.prototype.hasOwnProperty.call(source, joint.id) ? source[joint.id] : backup[joint.id];
      const numeric = Number(raw);
      const effectiveJoint = safety.getJointById(manifest, joint.id) || joint;
      pose[joint.id] = safety.clampJointValue(effectiveJoint, Number.isFinite(numeric) ? numeric : joint.home);
    });
    return pose;
  }

  function isCompleteFinitePose(value) {
    return Boolean(value && typeof value === "object" && COMPLETE_JOINT_IDS.every((jointId) => Number.isFinite(Number(value[jointId]))));
  }

  function rawCompletePose(value) {
    if (!isCompleteFinitePose(value)) return null;
    const pose = {};
    COMPLETE_JOINT_IDS.forEach((jointId) => { pose[jointId] = Number(value[jointId]); });
    return pose;
  }

  function leaderBranch() {
    return state && state.leaderControl ? state.leaderControl : null;
  }

  function retireRecoveryWork() {
    recoveryResponseEpoch += 1;
    recoveryStepPending = false;
    recoveryReleaseDuringStart = "";
    if (recoveryAbortController) {
      recoveryAbortController.abort();
    }
    recoveryAbortController = null;
    recoveryStepDrainPromise = null;
    if (leaderBranch() && leaderBranch().rangeRecovery) {
      leaderBranch().rangeRecovery.active = false;
      leaderBranch().rangeRecovery.starting = false;
      leaderBranch().rangeRecovery.sessionId = "";
      leaderBranch().rangeRecovery.requestInFlight = false;
    }
  }

  function retireLeaderWork(reason = "") {
    leaderResponseEpoch += 1;
    leaderReleaseDuringStart = "";
    if (leaderStartAbortController) {
      leaderStartAbortController.abort();
    }
    leaderStartAbortController = null;
    leaderStartPromise = null;
    leaderPendingFrame = null;
    clearWindowTimeout(leaderFrameTimer);
    leaderFrameTimer = null;
    if (leaderAbortController) {
      leaderAbortController.abort();
    }
    leaderAbortController = null;
    retireRecoveryWork();
    leaderFrameInFlight = null;
    leaderFrameSnapshot = null;
    if (leaderBranch()) {
      state.leaderControl.requestInFlight = false;
      state.leaderControl.lastCancelReason = reason || state.leaderControl.lastCancelReason || "";
    }
  }

  function clearLeaderObservationPolling() {
    clearWindowInterval(leaderObservationTimer);
    leaderObservationTimer = null;
    leaderObservationInFlight = false;
  }

  function init(options = {}) {
    registry.initialize();
    const manifest = registry.getActive();
    state = safety.createActiveRobotState(manifest.id, manifest.defaultMode);
    simAdapter = simulation.createSimulationAdapter(manifest);
    if (options.container) {
      render(options.container);
    }
    window.dispatchEvent(new CustomEvent("robobuddy:robot-state-change", { detail: getState() }));
  }

  function normalizeRetainedBridgeUrl(value) {
    try {
      const parsed = new URL(String(value || "http://127.0.0.1:8765"));
      if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
        return "";
      }
      const port = Number(parsed.port || 80);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return "";
      }
      parsed.pathname = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/+$/, "");
    } catch (error) {
      return "";
    }
  }

  function readBridgeSession() {
    try {
      const raw = window.sessionStorage && window.sessionStorage.getItem(BRIDGE_SESSION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const bridgeUrl = parsed && normalizeRetainedBridgeUrl(parsed.bridgeUrl);
      if (
        !parsed ||
        parsed.schema !== BRIDGE_SESSION_SCHEMA ||
        parsed.robotId !== "so101_follower" ||
        parsed.authMode !== "no_token" ||
        !bridgeUrl
      ) {
        return null;
      }
      return {
        schema: BRIDGE_SESSION_SCHEMA,
        robotId: "so101_follower",
        bridgeUrl,
        authMode: "no_token"
      };
    } catch (error) {
      return null;
    }
  }

  function rememberBridgeSession(options = {}) {
    const bridgeUrl = normalizeRetainedBridgeUrl(options.bridgeUrl);
    if (!bridgeUrl || options.authRequired === true || options.noTokenLocal === false) {
      forgetBridgeSession();
      return null;
    }
    const descriptor = {
      schema: BRIDGE_SESSION_SCHEMA,
      robotId: "so101_follower",
      bridgeUrl,
      authMode: "no_token"
    };
    try {
      if (window.sessionStorage) {
        window.sessionStorage.setItem(BRIDGE_SESSION_STORAGE_KEY, JSON.stringify(descriptor));
      }
    } catch (error) {
      return null;
    }
    return { ...descriptor };
  }

  function forgetBridgeSession() {
    try {
      if (window.sessionStorage) {
        window.sessionStorage.removeItem(BRIDGE_SESSION_STORAGE_KEY);
      }
    } catch (error) {
      // Session persistence is optional; the live runtime still fails closed.
    }
  }

  function hasBridgeSession() {
    return Boolean(readBridgeSession());
  }

  async function reattachBridgeSession(options = {}) {
    const descriptor = readBridgeSession();
    if (!descriptor) {
      return { status: "NO_SESSION", attached: false, state: getState() };
    }
    if (!state || state.robotId !== descriptor.robotId) {
      return { status: "ROBOT_MISMATCH", attached: false, descriptor, state: getState() };
    }

    const adapter = createBridgeAdapter({ baseUrl: descriptor.bridgeUrl, token: "" });
    try {
      const health = await adapter.health();
      applyBridgeCapabilities(health);
      if (health && health.authRequired) {
        const error = new Error("The retained bridge now requires a token. Return to Main and enter its current token.");
        error.code = "BRIDGE_TOKEN_REQUIRED";
        throw error;
      }
      let bridgeState = await adapter.reattach(descriptor.robotId);
      if (!bridgeState || bridgeState.connected !== true) {
        invalidateBridgeConnection(bridgeState || { status: "DISCONNECTED" });
        return { status: "DISCONNECTED", attached: false, descriptor, health, state: getState() };
      }
      if (options.disarm !== false && bridgeState.armed === true) {
        bridgeState = await adapter.disarm(descriptor.robotId);
      }
      setBridgeConnected(bridgeState);
      return {
        status: "ATTACHED",
        attached: true,
        descriptor,
        health,
        bridgeState,
        state: getState()
      };
    } catch (error) {
      invalidateBridgeConnection({
        status: error && error.code ? error.code : "BRIDGE_OFFLINE",
        lastError: error && error.message ? error.message : String(error || "")
      });
      return {
        status: error && error.code ? error.code : "BRIDGE_OFFLINE",
        attached: false,
        descriptor,
        error,
        state: getState()
      };
    }
  }

  function disarmBridgeForPageExit() {
    if (!state || state.robotId !== "so101_follower" || !bridgeAdapter || !isBridgeConnected()) {
      return false;
    }
    bridgeSafetyConfirmed = false;
    state.connection.armedForMotion = false;
    if (typeof bridgeAdapter.disarm === "function") {
      void bridgeAdapter.disarm(state.robotId, { keepalive: true }).catch(() => {});
    }
    return true;
  }

  function getManifest() {
    return registry.getActive();
  }

  function getLeaderFrameIntervalMs() {
    const manifest = getManifest();
    const configuredRate = Number(manifest && manifest.virtualLeader && manifest.virtualLeader.maxFrameRateHz);
    const effectiveRate = Number.isFinite(configuredRate) && configuredRate > 0
      ? Math.min(configuredRate, LEADER_PROTOCOL_MAX_FRAME_RATE_HZ)
      : LEADER_PROTOCOL_MAX_FRAME_RATE_HZ;
    return 1000 / effectiveRate;
  }

  function isCurrentBridgeRequest(robotId, adapter) {
    return Boolean(state && state.robotId === robotId && bridgeAdapter === adapter);
  }

  function retireManualResponses() {
    manualResponseEpoch += 1;
    activeManualSessionId = "";
    activeManualSequence = -1;
  }

  function setActive(robotId, options = {}) {
    retireLeaderWork("robot_change");
    clearLeaderObservationPolling();
    connectionEpoch += 1;
    if (state && safety && typeof safety.clearRuntimeJointLimits === "function") {
      safety.clearRuntimeJointLimits(state.robotId);
    }
    const manifest = registry.setActive(robotId, options);
    state = safety.createActiveRobotState(manifest.id, manifest.defaultMode);
    simAdapter = simulation.createSimulationAdapter(manifest);
    bridgeAdapter = null;
    bridgeSafetyConfirmed = false;
    bridgeDisarmPending = false;
    retireManualResponses();
    render(simContainer);
    emitState();
    return getState();
  }

  function setMode(mode) {
    const manifest = getManifest();
    if (!manifest.supportedModes.includes(mode)) {
      throw new Error(`${manifest.name} does not support ${mode} mode.`);
    }
    state.mode = mode;
    state.connection.status = mode === "simulate" ? "simulated" : "disconnected";
    if (mode !== "local_bridge") {
      retireLeaderWork("mode_switch");
      clearLeaderObservationPolling();
      if (safety && typeof safety.clearRuntimeJointLimits === "function") {
        safety.clearRuntimeJointLimits(state.robotId);
      }
      state.connection.connected = false;
      state.connection.calibrated = false;
      state.connection.armedForMotion = false;
      state.connection.moving = false;
    }
    emitState();
  }

  function getState() {
    return state ? cloneJson(state) : null;
  }

  function getJointArray() {
    const manifest = getManifest();
    return manifest.joints.map((joint) => Number(state.joints[joint.id] ?? joint.home ?? 0));
  }

  function updateJointsFromArray(angles) {
    const manifest = getManifest();
    if (!state || !Array.isArray(angles)) {
      return getState();
    }
    manifest.joints.forEach((joint, index) => {
      if (index < angles.length) {
        const effectiveJoint = safety.getJointById(manifest, joint.id) || joint;
        state.joints[joint.id] = safety.clampJointValue(effectiveJoint, angles[index]);
      }
    });
    if (simAdapter) {
      simAdapter.state = cloneJson(state);
      simAdapter.render(simContainer, state);
    }
    emitState();
    return getState();
  }

  async function applyCommand(command) {
    const validated = schema.validateCommand(command, { activeRobotId: state.robotId });
    if (!validated.ok) {
      throw new Error(validated.error);
    }
    const safeCommand = validated.command;
    if (state && ["virtual_leader", "range_recovery"].includes(state.controlOwner) && safeCommand.type !== "stop") {
      throw new Error("Release virtual leader motion before starting another command.");
    }
    if (safeCommand.robotId !== state.robotId && safeCommand.type !== "wait") {
      throw new Error(`Active robot is ${state.robotId}; command targets ${safeCommand.robotId}.`);
    }

    let bridgeHandled = false;
    if (state.mode === "local_bridge" && state.robotId === "so101_follower") {
      if (!bridgeAdapter) {
        throw new Error("BRIDGE_OFFLINE: connect to the local bridge first.");
      }
      if (!isBridgeConnected() && safeCommand.type !== "stop") {
        throw new Error("SO-101 is not connected to the local bridge.");
      }
      if (!isBridgeArmed() && safeCommand.type !== "stop") {
        throw new Error("SO-101 is connected but not armed for motion.");
      }
      if (!["stop", "home", "wait"].includes(safeCommand.type)) {
        const programAvailability = getProgramAvailability();
        if (!programAvailability.available) {
          const error = new Error(programAvailability.reason);
          error.code = "BRIDGE_PROGRAM_INCOMPATIBLE";
          throw error;
        }
      }
      const requestRobotId = state.robotId;
      const requestAdapter = bridgeAdapter;
      let bridgeResult = null;
      try {
        if (safeCommand.type === "stop") {
          bridgeResult = await requestAdapter.stop(requestRobotId);
        } else if (safeCommand.type === "home") {
          bridgeResult = await requestAdapter.home(requestRobotId);
        } else if (safeCommand.type !== "wait") {
          bridgeResult = await requestAdapter.execute(requestRobotId, [safeCommand]);
        }
      } catch (error) {
        if (
          error &&
          error.payload &&
          isCurrentBridgeRequest(requestRobotId, requestAdapter)
        ) {
          applyBridgeState(error.payload);
        }
        throw error;
      }
      if (bridgeResult) {
        if (!isCurrentBridgeRequest(requestRobotId, requestAdapter)) {
          return getState();
        }
        applyBridgeState(bridgeResult);
        const bridgeError = bridgeCommandError(bridgeResult, safeCommand);
        if (bridgeError) {
          throw new Error(bridgeError);
        }
        if (!bridgeResult.joints && !["stop", "home", "wait"].includes(safeCommand.type)) {
          throw new Error("SO-101 bridge returned without measured joint feedback; the program target was not accepted as complete.");
        }
        bridgeHandled = true;
      }
    }

    if (simAdapter && !bridgeHandled) {
      simAdapter.state = cloneJson(state);
      simAdapter.applyCommand(safeCommand);
      state = simAdapter.getState();
    }
    emitState();
    return getState();
  }

  async function applyCommands(commands) {
    const safeCommands = schema.validateCommandList(commands, { activeRobotId: state.robotId });
    for (const command of safeCommands) {
      await applyCommand(command);
    }
    return getState();
  }

  function home() {
    invalidateLeaderAlignment("Home changed the robot pose.");
    if (simAdapter) {
      simAdapter.state = cloneJson(state);
      simAdapter.home();
      state = simAdapter.getState();
    } else {
      state.joints = safety.getHomeJoints(getManifest());
    }
    emitState();
    return getState();
  }

  function stop() {
    retireLeaderWork("escape");
    clearLeaderObservationPolling();
    if (simAdapter && typeof simAdapter.cancelLeaderInteraction === "function") {
      simAdapter.cancelLeaderInteraction("escape");
    }
    if (simAdapter) {
      simAdapter.state = cloneJson(state);
      simAdapter.stop();
      state = simAdapter.getState();
    } else if (state) {
      state.queue = [];
      state.stopped = true;
    }
    if (state) {
      state.controlOwner = "stop";
      if (leaderBranch()) {
        state.leaderControl.aligned = false;
        state.leaderControl.phase = state.leaderControl.mode === "leader" ? "stopped" : "inactive";
        state.leaderControl.sessionId = "";
      }
    }
    emitState();
    return getState();
  }

  async function stopHardware() {
    const hardwareRequired = Boolean(state && state.mode === "local_bridge" && state.robotId === "so101_follower");
    if (hardwareRequired && !bridgeAdapter) {
      stop();
      const error = new Error("SO-101 hardware STOP could not be confirmed because the local bridge adapter is unavailable.");
      error.code = "STOP_UNCONFIRMED";
      throw error;
    }
    if (hardwareRequired) {
      const requestRobotId = state.robotId;
      const requestAdapter = bridgeAdapter;
      retireManualResponses();
      retireLeaderWork("escape");
      clearLeaderObservationPolling();
      const result = await requestAdapter.stop(requestRobotId);
      const currentRequest = isCurrentBridgeRequest(requestRobotId, requestAdapter);
      if (currentRequest) {
        applyBridgeState(result);
      }
      const hardwareConfirmed = Boolean(
        currentRequest &&
        result &&
        result.armed === false &&
        (result.status === "STOPPED" || result.controlOwner === "stop")
      );
      if (!hardwareConfirmed) {
        stop();
        const error = new Error("SO-101 hardware STOP returned without an explicit stopped/disarmed confirmation.");
        error.code = "STOP_UNCONFIRMED";
        throw error;
      }
    }
    stop();
    return {
      ...getState(),
      stopConfirmation: {
        hardwareRequired,
        hardwareConfirmed: hardwareRequired
      }
    };
  }

  function render(container) {
    simContainer = container || simContainer;
    if (simAdapter && simContainer) {
      simAdapter.render(simContainer, state);
    }
  }

  function createBridgeAdapter(options = {}) {
    const manifest = getManifest();
    state.bridgeApiVersion = "";
    state.bridgeCapabilities = [];
    state.hardwareFeatures = {
      ...(state.hardwareFeatures || {}),
      virtualLeader: "disabled",
      gamepadLeader: "disabled",
      phoneLeader: "disabled",
      phoneLeaderQualified: false
    };
    bridgeAdapter = new hardware.BridgeAdapter({
      manifest,
      baseUrl: options.baseUrl,
      token: options.token
    });
    connectionEpoch += 1;
    retireLeaderWork("bridge_change");
    clearLeaderObservationPolling();
    retireManualResponses();
    state.connection.bridgeUrl = bridgeAdapter.baseUrl;
    emitState();
    return bridgeAdapter;
  }

  function getBridgeAdapter() {
    return bridgeAdapter;
  }

  function invalidateBridgeConnection(payload = {}) {
    retireManualResponses();
    retireLeaderWork("disconnect");
    clearLeaderObservationPolling();
    connectionEpoch += 1;
    bridgeSafetyConfirmed = false;
    bridgeDisarmPending = false;
    const offline = {
      ...payload,
      status: payload.status || "BRIDGE_OFFLINE",
      connected: false,
      calibrated: false,
      armed: false,
      moving: false,
      limitStatus: "unavailable",
      jointLimits: {}
    };
    bridgeAdapter = null;
    state.bridgeApiVersion = "";
    state.bridgeCapabilities = [];
    state.hardwareFeatures = { ...(state.hardwareFeatures || {}), virtualLeader: "disabled", gamepadLeader: "disabled" };
    applyBridgeState(offline);
    return getState();
  }

  function setBridgeConnected(statusPayload) {
    state.mode = "local_bridge";
    applyBridgeState(statusPayload || { status: "CONNECTED", connected: true });
  }

  async function setBridgeSafetyConfirmed(value) {
    bridgeSafetyConfirmed = Boolean(value);
    bridgeDisarmPending = !value;
    if (!value && state) {
      state.connection.armedForMotion = false;
    }
    if (!state || !bridgeAdapter || !isBridgeConnected()) {
      if (state) {
        state.connection.armedForMotion = false;
        emitState();
      }
      bridgeDisarmPending = false;
      return getState();
    }
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    if (!value) {
      retireManualResponses();
      await cancelRangeRecovery("disarm").catch(() => getState());
      await cancelLeaderSession("disarm").catch(() => getState());
      clearLeaderObservationPolling();
    }
    try {
      const result = value
        ? await requestAdapter.arm(requestRobotId)
        : await requestAdapter.disarm(requestRobotId);
      if (!isCurrentBridgeRequest(requestRobotId, requestAdapter)) {
        return getState();
      }
      applyBridgeState(result);
      bridgeSafetyConfirmed = Boolean(result && result.armed);
      return getState();
    } finally {
      bridgeDisarmPending = false;
    }
  }

  function isBridgeSafetyConfirmed() {
    return bridgeSafetyConfirmed;
  }

  function isBridgeConnected() {
    return Boolean(state && state.connection && state.connection.connected && state.connection.status !== "DISCONNECTED");
  }

  function isBridgeArmed() {
    return Boolean(
      bridgeSafetyConfirmed &&
      isBridgeConnected() &&
      state.connection.calibrated &&
      state.connection.armedForMotion
    );
  }

  function bridgeStateIsTerminal(payload = {}) {
    return Boolean(
      payload && (
        payload.controlOwner === "stop" ||
        payload.status === "STOPPED" ||
        payload.armed === false
      )
    );
  }

  function applyBridgeState(payload = {}) {
    if (!state) {
      return getState();
    }
    const terminal = bridgeStateIsTerminal(payload);
    if (terminal) {
      retireManualResponses();
      retireLeaderWork("disarm");
      clearLeaderObservationPolling();
    }
    const previousRobotInstanceId = state.connection.robotInstanceId;
    const previouslyCalibrated = state.connection.calibrated;
    const previouslyArmed = state.connection.armedForMotion;
    state.mode = "local_bridge";
    state.connection.status = payload.status || state.connection.status || "CONNECTED";
    state.connection.connected = Boolean(payload.connected);
    state.connection.calibrated = Boolean(payload.calibrated);
    state.connection.moving = Boolean(payload.moving);
    state.connection.armedForMotion = Boolean(payload.armed) && !bridgeDisarmPending;
    bridgeSafetyConfirmed = state.connection.armedForMotion;
    state.connection.port = payload.port || state.connection.port || null;
    state.connection.portLabel = payload.port || state.connection.portLabel || null;
    state.connection.robotInstanceId = payload.robotInstanceId || state.connection.robotInstanceId || null;
    state.connection.lastError = payload.lastError || "";
    state.connection.limitStatus = payload.limitStatus || state.connection.limitStatus || "unavailable";
    state.connection.homeCompatible = payload.homeCompatible !== false;
    state.connection.homeLimitErrors = Array.isArray(payload.homeLimitErrors) ? payload.homeLimitErrors.slice() : [];
    if (leaderBranch() && leaderBranch().aligned && (
      !state.connection.connected ||
      !state.connection.calibrated ||
      !state.connection.armedForMotion ||
      (previousRobotInstanceId && payload.robotInstanceId && previousRobotInstanceId !== payload.robotInstanceId) ||
      (previouslyCalibrated && !state.connection.calibrated) ||
      (previouslyArmed && !state.connection.armedForMotion)
    )) {
      leaderBranch().aligned = false;
      leaderBranch().phase = leaderBranch().mode === "leader" ? "unaligned" : "inactive";
      leaderBranch().alignmentObservationSequence = -1;
    }
    applyBridgeCapabilities(payload, { emit: false });
    if (typeof payload.controlOwner === "string") {
      state.controlOwner = payload.controlOwner;
    } else if (payload.armed === false || payload.status === "STOPPED") {
      state.controlOwner = "stop";
    } else if (payload.armed === true && state.controlOwner === "stop") {
      state.controlOwner = "idle";
    }
    if (payload.observation && typeof payload.observation === "object") {
      state.observation = {
        sequence: Number.isFinite(Number(payload.observation.sequence)) ? Number(payload.observation.sequence) : -1,
        sampledAtServerMs: Number(payload.observation.sampledAtServerMs) || 0,
        ageMs: Number.isFinite(Number(payload.observation.ageMs)) ? Number(payload.observation.ageMs) : null,
        fresh: payload.observation.fresh === true
      };
      if (leaderBranch()) {
        state.leaderControl.measuredAgeMs = state.observation.ageMs;
        state.leaderControl.observationReceivedAtLocalMs = window.performance && typeof window.performance.now === "function" ? window.performance.now() : 0;
      }
    }
    if (payload.gripperMapping === "closed_at_min" || payload.gripperMapping === "closed_at_max") {
      state.gripperMapping = payload.gripperMapping;
    }
    if (payload.jointLimits && typeof payload.jointLimits === "object" && Object.keys(payload.jointLimits).length > 0) {
      state.jointLimits = cloneJson(payload.jointLimits);
      if (safety && typeof safety.setRuntimeJointLimits === "function") {
        safety.setRuntimeJointLimits(state.robotId, payload.jointLimits);
      }
    } else if (payload.connected === false || payload.limitStatus === "unavailable") {
      state.jointLimits = {};
      if (safety && typeof safety.clearRuntimeJointLimits === "function") {
        safety.clearRuntimeJointLimits(state.robotId);
      }
    }
    if (payload.joints && typeof payload.joints === "object") {
      const manifest = getManifest();
      state.measuredJoints = state.measuredJoints || {};
      manifest.joints.forEach((joint) => {
        if (Object.prototype.hasOwnProperty.call(payload.joints, joint.id)) {
          const measured = Number(payload.joints[joint.id]);
          if (Number.isFinite(measured)) {
            state.measuredJoints[joint.id] = measured;
          }
        }
      });
      if (isCompleteFinitePose(payload.joints) && leaderBranch()) {
        state.leaderControl.measuredPose = rawCompletePose(payload.joints);
      }
    }
    if (payload.targetJoints && typeof payload.targetJoints === "object") {
      const manifest = getManifest();
      manifest.joints.forEach((joint) => {
        if (Object.prototype.hasOwnProperty.call(payload.targetJoints, joint.id)) {
          const effectiveJoint = safety.getJointById(manifest, joint.id) || joint;
          state.joints[joint.id] = safety.clampJointValue(effectiveJoint, payload.targetJoints[joint.id]);
        }
      });
      if (isCompleteFinitePose(payload.targetJoints) && leaderBranch()) {
        state.leaderControl.acceptedTargetPose = completePose(payload.targetJoints, state.joints);
      }
    }
    if (payload.manualControl && typeof payload.manualControl === "object") {
      state.manualControl = cloneJson(payload.manualControl);
    }
    if (payload.homeControl && typeof payload.homeControl === "object") {
      state.homeControl = cloneJson(payload.homeControl);
    }
    if (payload.leaderControl && typeof payload.leaderControl === "object" && leaderBranch()) {
      const serverLeader = payload.leaderControl;
      ["phase", "sessionId", "acceptedSequence", "appliedSequence", "coalescedThroughSequence", "lastFrameAgeMs", "error"].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(serverLeader, key)) {
          if (
            key === "phase" &&
            serverLeader.phase === "idle" &&
            state.leaderControl.mode === "leader" &&
            !state.leaderControl.sessionId
          ) {
            return;
          }
          const localKey = key === "acceptedSequence" ? "latestAcceptedSequence" : (key === "error" ? "lastError" : key);
          state.leaderControl[localKey] = cloneJson(serverLeader[key]);
        }
      });
      ["clampedJoints", "quantizedJoints", "slewLimitedJoints", "downstreamLimitedJoints", "laggingJoints"].forEach((key) => {
        if (Array.isArray(payload[key])) {
          state.leaderControl[key] = payload[key].slice();
        }
      });
    }
    if (terminal && leaderBranch()) {
      state.controlOwner = "stop";
      state.leaderControl.aligned = false;
      if (state.leaderControl.phase !== "hardware_range_fault") {
        state.leaderControl.phase = state.leaderControl.mode === "leader" ? "stopped" : "inactive";
      }
      state.leaderControl.sessionId = "";
    }
    if (simAdapter) {
      simAdapter.state = cloneJson(state);
      simAdapter.render(simContainer, state);
    }
    emitState();
    return getState();
  }

  function applyBridgeCapabilities(payload = {}, options = {}) {
    if (!state) {
      return getState();
    }
    if (Object.prototype.hasOwnProperty.call(payload, "bridgeApiVersion")) {
      state.bridgeApiVersion = typeof payload.bridgeApiVersion === "string" ? payload.bridgeApiVersion : "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "capabilities")) {
      state.bridgeCapabilities = Array.isArray(payload.capabilities)
        ? payload.capabilities.filter((item) => typeof item === "string")
        : [];
    }
    state.hardwareFeatures = {
      ...state.hardwareFeatures,
      virtualLeader: payload.hardwareFeatures && payload.hardwareFeatures.virtualLeader === "enabled" ? "enabled" : "disabled",
      gamepadLeader: payload.hardwareFeatures && payload.hardwareFeatures.gamepadLeader === "enabled" ? "enabled" : "disabled"
    };
    if (options.emit !== false) emitState();
    return getState();
  }

  async function sendManualTarget(target) {
    if (!bridgeAdapter || !isBridgeArmed()) {
      throw new Error("SO-101 is not armed for motion.");
    }
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    const sessionId = String(target && target.sessionId || "");
    const sequence = Number(target && target.sequence);
    if (sessionId !== activeManualSessionId) {
      activeManualSessionId = sessionId;
      activeManualSequence = -1;
    }
    if (Number.isFinite(sequence)) {
      activeManualSequence = Math.max(activeManualSequence, sequence);
    }
    const responseEpoch = manualResponseEpoch;
    const result = await requestAdapter.sendManualTarget(requestRobotId, target);
    if (
      !isCurrentBridgeRequest(requestRobotId, requestAdapter) ||
      responseEpoch !== manualResponseEpoch ||
      sessionId !== activeManualSessionId ||
      (Number.isFinite(sequence) && sequence < activeManualSequence)
    ) {
      return getState();
    }
    applyBridgeState(result);
    const error = bridgeCommandError(result, { type: "manual-target" });
    if (error) {
      throw new Error(error);
    }
    return getState();
  }

  async function cancelManualTarget(reason = "cancelled", sessionId = "", sequence = -1) {
    if (!bridgeAdapter || !isBridgeConnected()) {
      return getState();
    }
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    retireManualResponses();
    const responseEpoch = manualResponseEpoch;
    const result = await requestAdapter.cancelManualTarget(requestRobotId, reason, sessionId, sequence);
    if (
      !isCurrentBridgeRequest(requestRobotId, requestAdapter) ||
      responseEpoch !== manualResponseEpoch ||
      activeManualSessionId
    ) {
      return getState();
    }
    applyBridgeState(result);
    return getState();
  }

  async function refreshBridgeState(options = {}) {
    if (!bridgeAdapter || !state || state.robotId !== "so101_follower") {
      return getState();
    }
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    const result = options.strict === true
      ? await requestAdapter.observe(requestRobotId, "program_seed")
      : await requestAdapter.getState(requestRobotId);
    if (!isCurrentBridgeRequest(requestRobotId, requestAdapter)) {
      return getState();
    }
    applyBridgeState(result);
    return getState();
  }

  function getMeasuredJointArray() {
    const manifest = getManifest();
    const measured = state && state.measuredJoints ? state.measuredJoints : {};
    return manifest.joints.map((joint) => Number(measured[joint.id] ?? state.joints[joint.id] ?? joint.home ?? 0));
  }

  function bridgeApiSupports(minimumMinor) {
    const match = /^0\.(\d+)\.(\d+)(?:$|-)/.exec(String(state && state.bridgeApiVersion || ""));
    return Boolean(match && Number(match[1]) >= minimumMinor);
  }

  function getLeaderAvailability(inputSource = "virtual_leader") {
    if (!state || state.robotId !== "so101_follower") {
      return { available: false, simulation: false, reason: "Virtual Leader is available only for the SO-101 follower." };
    }
    if (state.mode !== "local_bridge" || !state.connection.connected) {
      return { available: true, simulation: true, reason: "Simulation Leader is available." };
    }
    const capabilities = Array.isArray(state.bridgeCapabilities) ? state.bridgeCapabilities : [];
    const compatible = bridgeApiSupports(3) && LEADER_REQUIRED_CAPABILITIES.every((item) => capabilities.includes(item));
    if (!compatible) {
      return { available: false, simulation: false, reason: "Update the local bridge to a compatible API for hardware Leader." };
    }
    if (!state.hardwareFeatures || state.hardwareFeatures.virtualLeader !== "enabled") {
      return { available: false, simulation: false, reason: "Hardware Leader is disabled until supervised qualification." };
    }
    if (inputSource === "gamepad" && state.hardwareFeatures.gamepadLeader !== "enabled") {
      return { available: false, simulation: false, reason: "Hardware Xbox controller is disabled pending separate controller qualification." };
    }
    return { available: true, simulation: false, reason: "Hardware Leader is enabled." };
  }

  function getProgramAvailability() {
    if (!state || state.robotId !== "so101_follower") {
      return { available: true, simulation: true, reason: "Program runs in simulation." };
    }
    if (state.mode !== "local_bridge" || !state.connection.connected) {
      return { available: true, simulation: true, reason: "Program runs in simulation." };
    }
    const capabilities = Array.isArray(state.bridgeCapabilities) ? state.bridgeCapabilities : [];
    const compatible = bridgeApiSupports(5)
      && PROGRAM_REQUIRED_CAPABILITIES.every((item) => capabilities.includes(item));
    if (!compatible) {
      return {
        available: false,
        simulation: false,
        reason: "Update the local bridge to API 0.5.0 or later before running hardware programs. Commands were not sent."
      };
    }
    return {
      available: true,
      simulation: false,
      reason: "Absolute hardware targets use measured, bounded intermediate motion."
    };
  }

  function getLeaderOperatingLimits() {
    const manifest = getManifest();
    const restrictions = manifest && manifest.virtualLeader && manifest.virtualLeader.operatingLimits || {};
    const limits = {};
    (manifest && manifest.joints || []).forEach((joint) => {
      const effective = safety.getJointById(manifest, joint.id) || joint;
      const restriction = restrictions[joint.id] || {};
      limits[joint.id] = {
        min: Math.max(Number(effective.min), Number.isFinite(Number(restriction.min)) ? Number(restriction.min) : -Infinity),
        max: Math.min(Number(effective.max), Number.isFinite(Number(restriction.max)) ? Number(restriction.max) : Infinity),
        step: Number(effective.step) > 0 ? Number(effective.step) : (joint.type === "gripper" ? 1 : 0.1),
        unit: joint.unit,
        type: joint.type
      };
    });
    return limits;
  }

  function findRangeRecoveryNeeds(pose) {
    const limits = getLeaderOperatingLimits();
    return COMPLETE_JOINT_IDS.reduce((needs, jointId) => {
      const value = Number(pose && pose[jointId]);
      const limit = limits[jointId];
      if (limit && Number.isFinite(value) && (value < limit.min || value > limit.max)) {
        needs.push({ joint: jointId, value, boundary: value < limit.min ? limit.min : limit.max });
      }
      return needs;
    }, []);
  }

  function findHardwareRangeFaults(pose) {
    const manifest = getManifest();
    return COMPLETE_JOINT_IDS.reduce((faults, jointId) => {
      const commandLimit = safety.getJointById(manifest, jointId);
      const bridgeLimit = state && state.jointLimits && state.jointLimits[jointId] || {};
      const value = Number(pose && pose[jointId]);
      const hardwareMin = Number.isFinite(Number(bridgeLimit.hardwareMin))
        ? Number(bridgeLimit.hardwareMin)
        : Number(commandLimit && commandLimit.min);
      const hardwareMax = Number.isFinite(Number(bridgeLimit.hardwareMax))
        ? Number(bridgeLimit.hardwareMax)
        : Number(commandLimit && commandLimit.max);
      if (!Number.isFinite(value) || !Number.isFinite(hardwareMin) || !Number.isFinite(hardwareMax) || value < hardwareMin || value > hardwareMax) {
        faults.push({ joint: jointId, value, min: hardwareMin, max: hardwareMax });
      }
      return faults;
    }, []);
  }

  function describeHardwareRangeFaults(faults) {
    return faults.map((fault) => {
      if (![fault.value, fault.min, fault.max].every((value) => Number.isFinite(value))) {
        return fault.joint;
      }
      return `${fault.joint} ${fault.value.toFixed(1)} outside ${fault.min.toFixed(1)}..${fault.max.toFixed(1)}`;
    }).join("; ");
  }

  function setLeaderMode(active) {
    if (!leaderBranch()) {
      return getState();
    }
    if (!active) {
      retireLeaderWork("mode_switch");
      clearLeaderObservationPolling();
      state.leaderControl.mode = "inactive";
      state.leaderControl.phase = "inactive";
      state.leaderControl.aligned = false;
      state.leaderControl.sessionId = "";
      state.controlOwner = state.controlOwner === "virtual_leader" ? "idle" : state.controlOwner;
      if (simAdapter && typeof simAdapter.cancelLeaderInteraction === "function") {
        simAdapter.cancelLeaderInteraction("mode_switch");
      }
    } else {
      state.leaderControl.mode = "leader";
      state.leaderControl.phase = "unaligned";
      state.leaderControl.aligned = false;
      state.leaderControl.sessionId = "";
      state.leaderControl.lastError = "";
      state.leaderControl.lastErrorCode = "";
      state.leaderControl.rangeRecovery = null;
      state.leaderControl.inputPose = completePose(state.measuredJoints, state.joints);
      state.leaderControl.acceptedTargetPose = completePose(state.joints, state.measuredJoints);
      state.leaderControl.measuredPose = completePose(state.measuredJoints, state.joints);
    }
    syncSimulationLeaderState();
    emitState();
    return getState();
  }

  async function observeLeader(purpose = "leader_ready") {
    if (!state || state.robotId !== "so101_follower") {
      throw new Error("Virtual Leader observation requires the SO-101 follower.");
    }
    let result;
    if (state.mode === "local_bridge" && state.connection.connected) {
      if (!bridgeAdapter) {
        throw new Error("BRIDGE_OFFLINE: connect to the local bridge first.");
      }
      const requestRobotId = state.robotId;
      const requestAdapter = bridgeAdapter;
      result = await requestAdapter.observe(requestRobotId, purpose);
      if (!isCurrentBridgeRequest(requestRobotId, requestAdapter)) {
        return getState();
      }
      if (!isCompleteFinitePose(result && result.joints)) {
        const error = new Error("Complete six-joint feedback is unavailable.");
        error.code = "FEEDBACK_UNAVAILABLE";
        throw error;
      }
      applyBridgeState(result);
      if (bridgeStateIsTerminal(result)) {
        const error = new Error("The bridge disarmed while feedback was being observed.");
        error.code = "ARM_REQUIRED";
        throw error;
      }
    } else {
      const pose = rawCompletePose(state.measuredJoints);
      result = {
        ok: true,
        joints: pose,
        targetJoints: completePose(state.joints, pose),
        observation: {
          sequence: Math.max(0, Number(state.observation && state.observation.sequence) + 1),
          sampledAtServerMs: 0,
          ageMs: 0,
          fresh: true
        }
      };
      applyBridgeObservation(result);
    }
    const leader = leaderBranch();
    if (leader && leader.aligned && state.controlOwner === "idle") {
      const baseline = leader.alignmentPose || leader.inputPose;
      const moved = COMPLETE_JOINT_IDS.some((jointId) => {
        const tolerance = jointId === "gripper" ? 5 : 3;
        return Math.abs(Number(result.joints[jointId]) - Number(baseline[jointId])) > tolerance;
      });
      if (moved) {
        invalidateLeaderAlignment("Measured robot movement exceeded the alignment tolerance.");
      }
    }
    return getState();
  }

  function applyBridgeObservation(payload) {
    if (!state || !isCompleteFinitePose(payload && payload.joints)) {
      return getState();
    }
    state.measuredJoints = rawCompletePose(payload.joints);
    if (payload.targetJoints && isCompleteFinitePose(payload.targetJoints)) {
      state.joints = completePose(payload.targetJoints, state.joints);
    }
    state.observation = cloneJson(payload.observation || state.observation);
    if (leaderBranch()) {
      state.leaderControl.measuredPose = rawCompletePose(payload.joints);
      state.leaderControl.measuredAgeMs = Number(payload.observation && payload.observation.ageMs) || 0;
      state.leaderControl.observationReceivedAtLocalMs = window.performance && typeof window.performance.now === "function" ? window.performance.now() : 0;
    }
    syncSimulationLeaderState();
    emitState();
    return getState();
  }

  async function alignLeaderToMeasured() {
    const availability = getLeaderAvailability();
    const hardware = state && state.mode === "local_bridge" && state.connection.connected;
    if (!availability.available) {
      const error = new Error(availability.reason);
      error.code = hardware && !state.bridgeCapabilities.length ? "BRIDGE_UPDATE_REQUIRED" : "VIRTUAL_LEADER_DISABLED";
      throw error;
    }
    if (hardware && !isBridgeArmed()) {
      const error = new Error("Arm motion for this bridge session before aligning.");
      error.code = "ARM_REQUIRED";
      throw error;
    }
    const leader = leaderBranch();
    leader.phase = "aligning";
    leader.lastError = "";
    leader.lastErrorCode = "";
    emitState();
    try {
      await observeLeader("leader_align");
      const pose = rawCompletePose(state.measuredJoints);
      const hardwareFaults = findHardwareRangeFaults(pose);
      if (hardwareFaults.length) {
        const error = new Error(`Measured pose is outside verified hardware-safe limits: ${describeHardwareRangeFaults(hardwareFaults)}.`);
        error.code = "LIMITS_UNVERIFIED";
        if (hardware && isBridgeArmed()) {
          try {
            await setBridgeSafetyConfirmed(false);
          } catch (disarmError) {
            error.disarmError = disarmError;
          }
        }
        if (hardware) {
          error.message += isBridgeArmed()
            ? ` Automatic disarm was not confirmed${error.disarmError && error.disarmError.message ? `: ${error.disarmError.message}` : ""}. Press STOP before troubleshooting.`
            : " Motion was disarmed; disconnect and reposition the joint or recalibrate before retrying.";
        }
        throw error;
      }
      const needs = findRangeRecoveryNeeds(pose);
      leader.inputPose = { ...pose };
      leader.acceptedTargetPose = { ...pose };
      leader.measuredPose = { ...pose };
      leader.alignmentPose = { ...pose };
      leader.alignmentObservationSequence = Number(state.observation && state.observation.sequence) || 0;
      leader.rangeRecovery = needs.length ? { required: true, needs, active: false } : null;
      leader.aligned = needs.length === 0;
      leader.phase = needs.length ? "range_recovery_required" : "ready";
      if (leader.aligned) {
        startLeaderObservationPolling();
      }
      syncSimulationLeaderState();
      emitState();
      return getState();
    } catch (error) {
      leader.aligned = false;
      leader.phase = error.code === "LIMITS_UNVERIFIED" ? "hardware_range_fault" : "feedback_unavailable";
      leader.lastError = error.message || "Feedback unavailable.";
      leader.lastErrorCode = error.code || "FEEDBACK_UNAVAILABLE";
      emitState();
      throw error;
    }
  }

  function startLeaderObservationPolling() {
    clearLeaderObservationPolling();
    if (!leaderBranch() || !leaderBranch().aligned || state.mode !== "local_bridge") {
      return;
    }
    leaderObservationTimer = window.setInterval(() => {
      if (leaderObservationInFlight || !leaderBranch() || !leaderBranch().aligned || state.controlOwner !== "idle") {
        return;
      }
      leaderObservationInFlight = true;
      void observeLeader("leader_ready").catch((error) => {
        if (leaderBranch()) {
          leaderBranch().lastError = error.message || "Feedback unavailable.";
          leaderBranch().lastErrorCode = error.code || "FEEDBACK_UNAVAILABLE";
        }
      }).finally(() => {
        leaderObservationInFlight = false;
      });
    }, 200);
  }

  function invalidateLeaderAlignment(reason = "Alignment is no longer valid.") {
    clearLeaderObservationPolling();
    if (leaderBranch()) {
      state.leaderControl.aligned = false;
      state.leaderControl.phase = state.leaderControl.mode === "leader" ? "unaligned" : "inactive";
      state.leaderControl.lastError = reason;
      state.leaderControl.lastErrorCode = "ALIGNMENT_INVALIDATED";
      state.leaderControl.alignmentObservationSequence = -1;
    }
    emitState();
  }

  function newSessionId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    const bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      window.crypto.getRandomValues(bytes);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function startLeaderSession(inputPose, options = {}) {
    const requestedSource = options.source;
    if (requestedSource !== undefined && !["virtual_leader", "gamepad"].includes(requestedSource)) {
      const error = new Error("Leader input source is not recognized.");
      error.code = "INVALID_LEADER_SOURCE";
      throw error;
    }
    const inputSource = requestedSource || "virtual_leader";
    const availability = getLeaderAvailability(inputSource);
    if (!availability.available) {
      const error = new Error(availability.reason);
      error.code = inputSource === "gamepad" ? "GAMEPAD_LEADER_DISABLED" : "VIRTUAL_LEADER_DISABLED";
      throw error;
    }
    const leader = leaderBranch();
    if (!leader || !leader.aligned || leader.phase !== "ready") {
      const error = new Error("Align to the measured robot pose before driving.");
      error.code = "ALIGNMENT_REQUIRED";
      throw error;
    }
    clearLeaderObservationPolling();
    leaderReleaseDuringStart = "";
    const pose = completePose(inputPose || leader.inputPose, leader.inputPose);
    const sessionId = newSessionId("vl");
    leader.sessionId = sessionId;
    leader.nextSequence = 1;
    leader.latestIssuedSequence = 0;
    leader.latestAcceptedSequence = 0;
    leader.phase = "engaging";
    leader.inputPose = { ...pose };
    leader.lastError = "";
    leader.lastErrorCode = "";
    emitState();

    if (state.mode !== "local_bridge" || !state.connection.connected) {
      state.controlOwner = "virtual_leader";
      leader.phase = "live";
      syncSimulationLeaderState();
      emitState();
      return getState();
    }

    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    const requestConnectionEpoch = connectionEpoch;
    const requestEpoch = leaderResponseEpoch;
    const controller = new AbortController();
    leaderStartAbortController = controller;
    const payload = {
      schema: "robobuddy.virtual-leader.start.v1",
      sessionId,
      sequence: 0,
      source: inputSource,
      mode: "joint_space",
      clientTimeOriginMs: Number(performance.timeOrigin),
      sourceMonotonicMs: performance.now(),
      baselineObservationSequence: Math.max(0, Number(leader.alignmentObservationSequence) || 0),
      joints: pose
    };
    const request = requestAdapter.leaderStart(requestRobotId, payload, { signal: controller.signal });
    let startPromise = null;
    startPromise = Promise.resolve(request)
      .then(async (result) => {
        if (!isCurrentBridgeRequest(requestRobotId, requestAdapter) || requestConnectionEpoch !== connectionEpoch || requestEpoch !== leaderResponseEpoch) {
          return getState();
        }
        applyBridgeState(result);
        if (bridgeStateIsTerminal(result)) return getState();
        leader.phase = "live";
        state.controlOwner = "virtual_leader";
        if (leaderReleaseDuringStart) {
          const reason = leaderReleaseDuringStart;
          leaderReleaseDuringStart = "";
          return cancelLeaderSession(reason);
        }
        emitState();
        return getState();
      })
      .catch((error) => {
        if (requestEpoch === leaderResponseEpoch && leader.sessionId === sessionId) {
          leader.phase = "unaligned";
          leader.aligned = false;
          leader.lastError = error.message || "Leader engagement failed.";
          leader.lastErrorCode = error.code || "LEADER_START_FAILED";
          leader.sessionId = "";
          state.controlOwner = "idle";
          emitState();
        }
        throw error;
      })
      .finally(() => {
        if (leaderStartPromise === startPromise) {
          leaderStartPromise = null;
        }
        if (leaderStartAbortController === controller) {
          leaderStartAbortController = null;
        }
      });
    leaderStartPromise = startPromise;
    return startPromise;
  }

  function setLeaderInputPose(inputPose, options = {}) {
    const leader = leaderBranch();
    if (!leader || leader.mode !== "leader") {
      return getState();
    }
    const pose = completePose(inputPose, leader.inputPose);
    leader.inputPose = { ...pose };
    syncSimulationLeaderState();
    emitState();
    if (leader.phase !== "live" && leader.phase !== "lagging") {
      return getState();
    }
    if (state.mode !== "local_bridge" || !state.connection.connected) {
      if (simAdapter && typeof simAdapter.applyLeaderFrame === "function") {
        simAdapter.state = cloneJson(state);
        simAdapter.applyLeaderFrame(pose, { sequence: leader.nextSequence++, final: false });
        state = simAdapter.getState();
        state.leaderControl.mode = "leader";
        state.leaderControl.aligned = true;
        emitState();
      }
      return getState();
    }
    leaderPendingFrame = { sessionId: leader.sessionId, pose, sourceMonotonicMs: performance.now(), final: Boolean(options.final) };
    scheduleLeaderPump(Boolean(options.final));
    return getState();
  }

  function scheduleLeaderPump(immediate = false) {
    if (leaderFrameInFlight || !leaderPendingFrame) {
      return;
    }
    clearWindowTimeout(leaderFrameTimer);
    const wait = immediate ? 0 : Math.max(0, getLeaderFrameIntervalMs() - (performance.now() - leaderLastSentAt));
    leaderFrameTimer = window.setTimeout(() => {
      leaderFrameTimer = null;
      void pumpLeaderFrames();
    }, wait);
  }

  async function pumpLeaderFrames() {
    if (leaderFrameInFlight || !leaderPendingFrame || !leaderBranch() || !leaderBranch().sessionId) {
      return getState();
    }
    const candidate = leaderPendingFrame;
    leaderPendingFrame = null;
    try {
      await issueLeaderFrame(candidate.pose, candidate.final);
    } catch (error) {
      if (leaderBranch() && error && error.code !== "LEADER_RATE_LIMITED") {
        leaderBranch().lastError = error.message || "Leader frame failed.";
        leaderBranch().lastErrorCode = error.code || "LEADER_FRAME_FAILED";
        if (["SESSION_RETIRED", "SESSION_NOT_ACTIVE", "SESSION_CONFLICT", "SEQUENCE_CONFLICT", "MOTION_CONFLICT"].includes(error.code)) {
          retireLeaderWork("server_retired");
          leaderBranch().sessionId = "";
          leaderBranch().aligned = false;
          leaderBranch().phase = "unaligned";
          state.controlOwner = "idle";
        }
        emitState();
      }
    } finally {
      if (leaderPendingFrame) {
        scheduleLeaderPump(Boolean(leaderPendingFrame.final));
      }
    }
    return getState();
  }

  function rebaseLeaderInputAfterAcknowledgement(snapshot, result) {
    const leader = leaderBranch();
    if (!leader || !snapshot || snapshot.final || leader.sessionId !== snapshot.sessionId) {
      return false;
    }
    const accepted = rawCompletePose(result && result.targetJoints) || rawCompletePose(leader.acceptedTargetPose);
    const current = rawCompletePose(leader.inputPose);
    const issued = rawCompletePose(snapshot.inputPose);
    if (!accepted || !current || !issued) {
      return false;
    }
    const limits = getLeaderOperatingLimits();
    const rebased = {};
    COMPLETE_JOINT_IDS.forEach((jointId) => {
      const limit = limits[jointId];
      const postSnapshotDelta = Number(current[jointId]) - Number(issued[jointId]);
      const candidate = Number(accepted[jointId]) + postSnapshotDelta;
      rebased[jointId] = limit
        ? Math.min(limit.max, Math.max(limit.min, candidate))
        : candidate;
    });
    leader.inputPose = rebased;
    if (leaderPendingFrame && leaderPendingFrame.sessionId === snapshot.sessionId) {
      leaderPendingFrame.pose = { ...rebased };
    }
    return true;
  }

  async function issueLeaderFrame(pose, final) {
    const leader = leaderBranch();
    const sequence = leader.nextSequence++;
    leader.latestIssuedSequence = sequence;
    const issuedPose = completePose(pose, leader.inputPose);
    const payload = {
      schema: "robobuddy.virtual-leader.frame.v1",
      sessionId: leader.sessionId,
      sequence,
      sourceMonotonicMs: performance.now(),
      final: Boolean(final),
      joints: issuedPose
    };
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    const requestEpoch = leaderResponseEpoch;
    const requestConnectionEpoch = connectionEpoch;
    const controller = new AbortController();
    leaderAbortController = controller;
    leader.requestInFlight = true;
    leaderLastSentAt = performance.now();
    const snapshot = {
      sessionId: leader.sessionId,
      sequence,
      final: Boolean(final),
      inputPose: { ...issuedPose }
    };
    leaderFrameSnapshot = snapshot;
    const request = requestAdapter.leaderFrame(requestRobotId, payload, { signal: controller.signal });
    leaderFrameInFlight = request;
    try {
      const result = await request;
      if (!isCurrentBridgeRequest(requestRobotId, requestAdapter) || requestEpoch !== leaderResponseEpoch || requestConnectionEpoch !== connectionEpoch || leader.sessionId !== payload.sessionId) {
        return getState();
      }
      applyBridgeState(result);
      if (bridgeStateIsTerminal(result)) return getState();
      leader.latestAcceptedSequence = Number(result && result.leaderControl && result.leaderControl.acceptedSequence) || sequence;
      const rebased = rebaseLeaderInputAfterAcknowledgement(snapshot, result);
      if (final) {
        if (!applyHeldLeaderResult(result)) {
          const error = new Error("Virtual Leader measured hold was not confirmed.");
          error.code = "HOLD_FAILED";
          throw error;
        }
      } else if (rebased) {
        syncSimulationLeaderState();
        emitState();
      }
      return getState();
    } finally {
      const ownsCurrentRequest = leaderFrameInFlight === request;
      if (ownsCurrentRequest) {
        leaderFrameInFlight = null;
      }
      if (leaderFrameSnapshot === snapshot) {
        leaderFrameSnapshot = null;
      }
      if (ownsCurrentRequest && leaderBranch() && leaderBranch().sessionId === snapshot.sessionId) {
        leaderBranch().requestInFlight = false;
      }
      if (leaderAbortController === controller) {
        leaderAbortController = null;
      }
    }
  }

  async function finalizeLeaderSession(inputPose) {
    const leader = leaderBranch();
    if (!leader || !leader.sessionId) {
      return getState();
    }
    if (leader.phase === "engaging" && leaderStartPromise) {
      leaderReleaseDuringStart = "pointer_cancelled";
      await leaderStartPromise.catch(() => getState());
      return getState();
    }
    leaderPendingFrame = null;
    clearWindowTimeout(leaderFrameTimer);
    if (state.mode !== "local_bridge" || !state.connection.connected) {
      const pose = completePose(inputPose || leader.inputPose, leader.inputPose);
      if (simAdapter && typeof simAdapter.applyLeaderFrame === "function") {
        simAdapter.state = cloneJson(state);
        simAdapter.applyLeaderFrame(pose, { sequence: leader.nextSequence++, final: true });
        state = simAdapter.getState();
      }
      state.controlOwner = "idle";
      state.leaderControl.sessionId = "";
      state.leaderControl.phase = "ready";
      state.leaderControl.aligned = true;
      syncSimulationLeaderState();
      emitState();
      return getState();
    }
    leader.phase = "settling";
    emitState();
    if (leaderFrameInFlight) {
      const settled = await Promise.race([
        leaderFrameInFlight.then(() => true, () => true),
        new Promise((resolve) => window.setTimeout(() => resolve(false), LEADER_FINAL_WAIT_MS))
      ]);
      if (!settled) {
        if (leaderAbortController) leaderAbortController.abort();
        return cancelLeaderSession("client_error");
      }
    }
    try {
      return await issueLeaderFrame(completePose(inputPose || leader.inputPose, leader.inputPose), true);
    } catch (error) {
      return cancelLeaderSession("client_error").then(() => { throw error; });
    }
  }

  function applyHeldLeaderResult(result) {
    const leader = leaderBranch();
    const held = result && (result.heldJoints || result.joints || result.targetJoints);
    if (!leader || !result || result.holdConfirmed !== true || !isCompleteFinitePose(held)) {
      if (leader) {
        leader.aligned = false;
        leader.phase = "hold_failed";
        leader.lastErrorCode = "HOLD_FAILED";
      }
      return false;
    }
    const pose = completePose(held, leader.measuredPose);
    state.joints = { ...pose };
    state.measuredJoints = { ...pose };
    state.controlOwner = "idle";
    leader.inputPose = { ...pose };
    leader.acceptedTargetPose = { ...pose };
    leader.measuredPose = { ...pose };
    leader.alignmentPose = { ...pose };
    leader.sessionId = "";
    leader.phase = "ready";
    leader.aligned = findRangeRecoveryNeeds(pose).length === 0;
    if (!leader.aligned) leader.phase = "unaligned";
    if (leader.aligned) startLeaderObservationPolling();
    syncSimulationLeaderState();
    emitState();
    return true;
  }

  async function cancelLeaderSession(reason = "client_error", options = {}) {
    const leader = leaderBranch();
    if (!leader || !leader.sessionId) {
      return getState();
    }
    if (leader.phase === "engaging" && leaderStartPromise) {
      leaderReleaseDuringStart = reason;
      return leaderStartPromise.catch(() => getState());
    }
    const sessionId = leader.sessionId;
    const highestSequence = leader.latestIssuedSequence;
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    leader.phase = "holding";
    leaderPendingFrame = null;
    clearWindowTimeout(leaderFrameTimer);
    const payload = {
      schema: "robobuddy.virtual-leader.cancel.v1",
      sessionId,
      sequence: highestSequence,
      sourceMonotonicMs: performance.now(),
      reason
    };
    retireLeaderWork(reason);
    emitState();
    if (state.mode !== "local_bridge" || !state.connection.connected || !requestAdapter) {
      state.controlOwner = "idle";
      leader.sessionId = "";
      leader.phase = leader.aligned ? "ready" : "unaligned";
      syncSimulationLeaderState();
      emitState();
      return getState();
    }
    const cancelEpoch = leaderResponseEpoch;
    try {
      const result = await requestAdapter.leaderCancel(requestRobotId, payload, { keepalive: Boolean(options.keepalive) });
      if (!isCurrentBridgeRequest(requestRobotId, requestAdapter) || cancelEpoch !== leaderResponseEpoch) {
        return getState();
      }
      applyBridgeState(result);
      if (bridgeStateIsTerminal(result)) return getState();
      if (!applyHeldLeaderResult(result)) {
        const error = new Error("Virtual Leader measured hold was not confirmed.");
        error.code = "HOLD_FAILED";
        throw error;
      }
      return getState();
    } catch (error) {
      if (error && error.code === "SESSION_NOT_ACTIVE") {
        leader.sessionId = "";
        leader.aligned = false;
        leader.phase = "unaligned";
        state.controlOwner = "idle";
        emitState();
        return getState();
      }
      leader.aligned = false;
      leader.phase = "hold_failed";
      leader.lastError = error.message || "Measured hold failed.";
      leader.lastErrorCode = error.code || "HOLD_FAILED";
      emitState();
      throw error;
    }
  }

  async function startRangeRecovery(jointId) {
    const leader = leaderBranch();
    const need = leader && leader.rangeRecovery && leader.rangeRecovery.needs && leader.rangeRecovery.needs.find((item) => item.joint === jointId);
    if (!need) {
      throw new Error("Align first and select a joint that is outside the Leader range.");
    }
    const simulationRecovery = state.mode !== "local_bridge" || !state.connection.connected;
    if (!simulationRecovery && !isBridgeArmed()) {
      const error = new Error("Arm motion before bounded range recovery.");
      error.code = "ARM_REQUIRED";
      throw error;
    }
    if (recoveryStartPromise) {
      return recoveryStartPromise;
    }
    const sessionId = newSessionId("rr");
    const payload = {
      schema: "robobuddy.range-recovery.start.v1",
      sessionId,
      sequence: 0,
      sourceMonotonicMs: performance.now(),
      joint: jointId
    };
    if (simulationRecovery) {
      leader.rangeRecovery = { ...leader.rangeRecovery, active: true, sessionId, sequence: 0, joint: jointId, boundary: need.boundary };
      leader.phase = "range_recovery";
      state.controlOwner = "range_recovery";
      emitState();
      return getState();
    }
    recoveryReleaseDuringStart = "";
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    const requestConnectionEpoch = connectionEpoch;
    const requestEpoch = recoveryResponseEpoch;
    const controller = new AbortController();
    recoveryAbortController = controller;
    leader.rangeRecovery = {
      ...leader.rangeRecovery,
      active: false,
      starting: true,
      sessionId,
      sequence: 0,
      joint: jointId,
      boundary: need.boundary,
      requestInFlight: true
    };
    emitState();
    recoveryStartPromise = requestAdapter.rangeRecoveryStart(requestRobotId, payload, { signal: controller.signal })
      .then(async (result) => {
        if (
          !isCurrentBridgeRequest(requestRobotId, requestAdapter) ||
          requestConnectionEpoch !== connectionEpoch ||
          requestEpoch !== recoveryResponseEpoch ||
          !leaderBranch() ||
          !leaderBranch().rangeRecovery ||
          leaderBranch().rangeRecovery.sessionId !== sessionId
        ) {
          return getState();
        }
        applyBridgeState(result);
        if (bridgeStateIsTerminal(result)) return getState();
        const currentLeader = leaderBranch();
        currentLeader.rangeRecovery = {
          ...currentLeader.rangeRecovery,
          active: true,
          starting: false,
          sessionId,
          sequence: 0,
          joint: jointId,
          boundary: need.boundary,
          requestInFlight: false
        };
        currentLeader.phase = "range_recovery";
        state.controlOwner = "range_recovery";
        if (recoveryReleaseDuringStart) {
          const reason = recoveryReleaseDuringStart;
          recoveryReleaseDuringStart = "";
          return cancelRangeRecovery(reason);
        }
        emitState();
        return getState();
      })
      .catch((error) => {
        if (
          requestEpoch === recoveryResponseEpoch &&
          leaderBranch() &&
          leaderBranch().rangeRecovery &&
          leaderBranch().rangeRecovery.sessionId === sessionId
        ) {
          leaderBranch().rangeRecovery.active = false;
          leaderBranch().rangeRecovery.starting = false;
          leaderBranch().rangeRecovery.requestInFlight = false;
          leaderBranch().phase = "range_recovery_required";
          leaderBranch().lastError = error.message || "Range recovery could not start.";
          leaderBranch().lastErrorCode = error.code || "RANGE_RECOVERY_START_FAILED";
          state.controlOwner = "idle";
          emitState();
        }
        throw error;
      })
      .finally(() => {
        if (recoveryAbortController === controller) {
          recoveryAbortController = null;
        }
        recoveryStartPromise = null;
      });
    return recoveryStartPromise;
  }

  function stepRangeRecovery() {
    const recovery = leaderBranch() && leaderBranch().rangeRecovery;
    if (!recovery || !recovery.active) {
      return Promise.resolve(getState());
    }
    recoveryStepPending = true;
    if (recoveryStepDrainPromise) {
      return recoveryStepDrainPromise;
    }
    const drainEpoch = recoveryResponseEpoch;
    const drain = (async () => {
      while (recoveryStepPending && drainEpoch === recoveryResponseEpoch) {
        recoveryStepPending = false;
        const current = leaderBranch() && leaderBranch().rangeRecovery;
        if (!current || !current.active) break;
        await issueRangeRecoveryStep(drainEpoch);
      }
      return getState();
    })();
    const tracked = drain.finally(() => {
      if (recoveryStepDrainPromise === tracked) {
        recoveryStepDrainPromise = null;
      }
    });
    recoveryStepDrainPromise = tracked;
    return tracked;
  }

  async function issueRangeRecoveryStep(requestEpoch) {
    const recovery = leaderBranch() && leaderBranch().rangeRecovery;
    if (!recovery || !recovery.active || requestEpoch !== recoveryResponseEpoch) {
      return getState();
    }
    recovery.sequence += 1;
    if (state.mode !== "local_bridge" || !state.connection.connected) {
      const current = Number(state.measuredJoints[recovery.joint]);
      const boundary = Number(recovery.boundary);
      const direction = Math.sign(boundary - current);
      const step = recovery.joint === "gripper" ? 0.4 : 0.24;
      const value = direction === 0 || Math.abs(boundary - current) <= step ? boundary : current + direction * step;
      const pose = completePose(state.measuredJoints, state.joints);
      pose[recovery.joint] = value;
      state.joints = { ...pose };
      state.measuredJoints = { ...pose };
      leaderBranch().inputPose = { ...pose };
      leaderBranch().acceptedTargetPose = { ...pose };
      leaderBranch().measuredPose = { ...pose };
      if (value === boundary) {
        recovery.active = false;
        leaderBranch().phase = "unaligned";
        state.controlOwner = "idle";
      }
      syncSimulationLeaderState();
      emitState();
      return getState();
    }
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    const requestConnectionEpoch = connectionEpoch;
    const sessionId = recovery.sessionId;
    const payload = {
      schema: "robobuddy.range-recovery.step.v1",
      sessionId: recovery.sessionId,
      sequence: recovery.sequence,
      sourceMonotonicMs: performance.now(),
      intent: "toward_range"
    };
    const controller = new AbortController();
    recoveryAbortController = controller;
    recovery.requestInFlight = true;
    try {
      const result = await requestAdapter.rangeRecoveryStep(requestRobotId, payload, { signal: controller.signal });
      if (
        !isCurrentBridgeRequest(requestRobotId, requestAdapter) ||
        requestConnectionEpoch !== connectionEpoch ||
        requestEpoch !== recoveryResponseEpoch ||
        !leaderBranch() ||
        !leaderBranch().rangeRecovery ||
        !leaderBranch().rangeRecovery.active ||
        leaderBranch().rangeRecovery.sessionId !== sessionId
      ) {
        return getState();
      }
      applyBridgeState(result);
      if (bridgeStateIsTerminal(result)) return getState();
      if (result && result.holdConfirmed === true) {
        leaderBranch().rangeRecovery.active = false;
        leaderBranch().rangeRecovery.requestInFlight = false;
        leaderBranch().aligned = false;
        leaderBranch().phase = "unaligned";
        state.controlOwner = "idle";
      }
      emitState();
      return getState();
    } catch (error) {
      if (requestEpoch !== recoveryResponseEpoch || !isCurrentBridgeRequest(requestRobotId, requestAdapter)) {
        return getState();
      }
      throw error;
    } finally {
      if (recoveryAbortController === controller) {
        recoveryAbortController = null;
      }
      if (leaderBranch() && leaderBranch().rangeRecovery && leaderBranch().rangeRecovery.sessionId === sessionId) {
        leaderBranch().rangeRecovery.requestInFlight = false;
      }
    }
  }

  async function cancelRangeRecovery(reason = "pointer_cancelled", options = {}) {
    const leader = leaderBranch();
    const recovery = leader && leader.rangeRecovery;
    if (recoveryStartPromise && (!recovery || !recovery.active)) {
      recoveryReleaseDuringStart = reason;
      return recoveryStartPromise.catch(() => getState());
    }
    if (!recovery || !recovery.active) {
      return getState();
    }
    const payload = {
      schema: "robobuddy.range-recovery.cancel.v1",
      sessionId: recovery.sessionId,
      sequence: recovery.sequence,
      sourceMonotonicMs: performance.now(),
      reason
    };
    recovery.active = false;
    recovery.starting = false;
    recoveryStepPending = false;
    if (state.mode !== "local_bridge" || !state.connection.connected || !bridgeAdapter) {
      leader.aligned = false;
      leader.phase = "unaligned";
      state.controlOwner = "idle";
      syncSimulationLeaderState();
      emitState();
      return getState();
    }
    const requestRobotId = state.robotId;
    const requestAdapter = bridgeAdapter;
    const requestConnectionEpoch = connectionEpoch;
    retireRecoveryWork();
    const cancelEpoch = recoveryResponseEpoch;
    const controller = new AbortController();
    recoveryAbortController = controller;
    leader.phase = "holding";
    emitState();
    try {
      const result = await requestAdapter.rangeRecoveryCancel(requestRobotId, payload, {
        signal: controller.signal,
        keepalive: Boolean(options.keepalive)
      });
      if (
        !isCurrentBridgeRequest(requestRobotId, requestAdapter) ||
        requestConnectionEpoch !== connectionEpoch ||
        cancelEpoch !== recoveryResponseEpoch
      ) {
        return getState();
      }
      const held = result && (result.heldJoints || result.joints || result.targetJoints);
      if (!result || result.holdConfirmed !== true || !isCompleteFinitePose(held)) {
        const error = new Error("Range recovery measured hold was not confirmed.");
        error.code = "HOLD_FAILED";
        throw error;
      }
      applyBridgeState(result);
      if (bridgeStateIsTerminal(result)) return getState();
      leader.aligned = false;
      leader.phase = "unaligned";
      leader.rangeRecovery = { ...leader.rangeRecovery, active: false, starting: false, sessionId: "", requestInFlight: false };
      state.controlOwner = "idle";
      emitState();
      return getState();
    } catch (error) {
      if (cancelEpoch !== recoveryResponseEpoch || !isCurrentBridgeRequest(requestRobotId, requestAdapter)) {
        return getState();
      }
      leader.aligned = false;
      leader.phase = "hold_failed";
      leader.lastError = error.message || "Range recovery measured hold failed.";
      leader.lastErrorCode = error.code || "HOLD_FAILED";
      emitState();
      throw error;
    } finally {
      if (recoveryAbortController === controller) {
        recoveryAbortController = null;
      }
    }
  }

  function requestControlOwner(owner, reason = "takeover") {
    if (!state || state.controlOwner === "idle" || state.controlOwner === owner) {
      state.controlOwner = owner;
      emitState();
      return Promise.resolve(getState());
    }
    if (state.controlOwner === "virtual_leader") {
      return cancelLeaderSession(reason).then(() => {
        if (state.controlOwner !== "idle") throw new Error("Virtual Leader hold was not confirmed.");
        state.controlOwner = owner;
        emitState();
        return getState();
      });
    }
    return Promise.reject(new Error(`Motion is owned by ${state.controlOwner}.`));
  }

  function setLeaderLayerVisibility(visibility) {
    if (!leaderBranch()) return getState();
    state.leaderControl.layerVisibility = {
      input: visibility.input !== false,
      target: visibility.target !== false,
      measured: visibility.measured !== false
    };
    syncSimulationLeaderState();
    emitState();
    return getState();
  }

  function setLeaderInteractionCallbacks(callbacks) {
    if (simAdapter && typeof simAdapter.setLeaderInteractionCallbacks === "function") {
      simAdapter.setLeaderInteractionCallbacks(callbacks);
    }
  }

  function cancelLeaderInteraction(reason) {
    if (simAdapter && typeof simAdapter.cancelLeaderInteraction === "function") {
      simAdapter.cancelLeaderInteraction(reason);
    }
  }

  function getLeaderRendererDebugSnapshot() {
    return simAdapter && typeof simAdapter.getLeaderDebugSnapshot === "function" ? simAdapter.getLeaderDebugSnapshot() : null;
  }

  function syncSimulationLeaderState() {
    if (!simAdapter || !state) return;
    simAdapter.state = cloneJson(state);
    simAdapter.render(simContainer, state);
  }

  function cleanBridgeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function describeBridgeConnectionResult(payload = {}) {
    const status = String(payload.status || "").toUpperCase();
    const detail = cleanBridgeText(payload.lastError || payload.error || "");
    const calibrationCommand = cleanBridgeText(payload.calibrationCommand || "");

    if (status === "CONNECTED" && payload.connected === true && payload.calibrated === true && payload.limitStatus === "verified") {
      return {
        ok: true,
        tone: "ready",
        message: "SO-101 connected. Arm motion requires the session toggle."
      };
    }

    if (status === "CONNECTED" && payload.connected === true && payload.calibrated === true) {
      return {
        ok: false,
        tone: "error",
        message: "SO-101 connected, but verified hardware limits are unavailable. Motion remains blocked."
      };
    }

    if (status === "NEEDS_CALIBRATION") {
      return {
        ok: false,
        tone: "error",
        message: calibrationCommand
          ? `Needs calibration. Run: ${calibrationCommand}`
          : (detail || "Needs calibration. Run lerobot-calibrate before enabling arm motion.")
      };
    }

    if (status === "LEROBOT_NOT_INSTALLED") {
      return {
        ok: false,
        tone: "error",
        message: detail || "LeRobot is not installed in the bridge environment. Install the SO-101 bridge extras in the active Python environment."
      };
    }

    if (payload.ok === false || status === "ERROR" || payload.connected === false) {
      return {
        ok: false,
        tone: "error",
        message: detail || "SO-101 bridge connection failed."
      };
    }

    if (status === "STOPPED") {
      return {
        ok: false,
        tone: "warning",
        message: "SO-101 stopped."
      };
    }

    return {
      ok: Boolean(payload.connected && payload.calibrated),
      tone: payload.connected ? "warning" : "error",
      message: detail || "Bridge state updated."
    };
  }

  function bridgeCommandError(payload = {}, command = {}) {
    const status = String(payload.status || "").toUpperCase();
    const errorStatus = payload.ok === false || status === "ERROR" || status === "NEEDS_CALIBRATION" || status === "LEROBOT_NOT_INSTALLED";
    if (errorStatus) {
      const detail = cleanBridgeText(payload.lastError || payload.error || payload.status) || "bridge returned an error";
      return `SO-101 bridge rejected ${command.type || "command"}: ${detail}`;
    }
    if (command.type !== "stop" && payload.connected === false) {
      return `SO-101 bridge rejected ${command.type || "command"}: robot is not connected`;
    }
    if (command.type !== "stop" && payload.calibrated === false) {
      return `SO-101 bridge rejected ${command.type || "command"}: calibration is not verified`;
    }
    if (command.type !== "stop" && command.type !== "wait" && payload.armed === false) {
      return `SO-101 bridge rejected ${command.type || "command"}: robot is not armed`;
    }
    return "";
  }

  function emitState() {
    window.dispatchEvent(new CustomEvent("robobuddy:robot-state-change", { detail: getState() }));
  }

  NS.RobotRuntime = {
    init,
    setActive,
    setMode,
    getManifest,
    getState,
    getJointArray,
    updateJointsFromArray,
    applyCommand,
    applyCommands,
    home,
    stop,
    stopHardware,
    render,
    createBridgeAdapter,
    rememberBridgeSession,
    forgetBridgeSession,
    hasBridgeSession,
    readBridgeSession,
    reattachBridgeSession,
    disarmBridgeForPageExit,
    getBridgeAdapter,
    invalidateBridgeConnection,
    setBridgeConnected,
    setBridgeSafetyConfirmed,
    isBridgeSafetyConfirmed,
    isBridgeConnected,
    isBridgeArmed,
    applyBridgeState,
    sendManualTarget,
    cancelManualTarget,
    refreshBridgeState,
    getMeasuredJointArray,
    describeBridgeConnectionResult,
    applyBridgeCapabilities,
    getLeaderAvailability,
    getProgramAvailability,
    getLeaderOperatingLimits,
    setLeaderMode,
    alignLeaderToMeasured,
    observeLeader,
    startLeaderSession,
    engageLeader: startLeaderSession,
    setLeaderInputPose,
    sendLeaderFrame: setLeaderInputPose,
    finalizeLeaderSession,
    cancelLeaderSession,
    invalidateLeaderAlignment,
    getLeaderControlState: () => leaderBranch() ? cloneJson(leaderBranch()) : null,
    startRangeRecovery,
    stepRangeRecovery,
    cancelRangeRecovery,
    requestControlOwner,
    setLeaderLayerVisibility,
    setLeaderInteractionCallbacks,
    cancelLeaderInteraction,
    getLeaderRendererDebugSnapshot
  };
})();
