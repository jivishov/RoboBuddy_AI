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

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
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

  function getManifest() {
    return registry.getActive();
  }

  function setActive(robotId, options = {}) {
    const manifest = registry.setActive(robotId, options);
    state = safety.createActiveRobotState(manifest.id, manifest.defaultMode);
    simAdapter = simulation.createSimulationAdapter(manifest);
    bridgeAdapter = null;
    bridgeSafetyConfirmed = false;
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
        state.joints[joint.id] = safety.clampJointValue(joint, angles[index]);
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
    if (safeCommand.robotId !== state.robotId && safeCommand.type !== "wait") {
      throw new Error(`Active robot is ${state.robotId}; command targets ${safeCommand.robotId}.`);
    }

    if (state.mode === "local_bridge" && state.robotId === "so101_follower") {
      if (!bridgeAdapter) {
        throw new Error("BRIDGE_OFFLINE: connect to the local bridge first.");
      }
      if (!bridgeSafetyConfirmed && safeCommand.type !== "stop") {
        throw new Error("SO-101 hardware safety confirmation is required before movement.");
      }
      if (safeCommand.type === "stop") {
        await bridgeAdapter.stop(state.robotId);
      } else if (safeCommand.type === "home") {
        await bridgeAdapter.home(state.robotId);
      } else if (safeCommand.type !== "wait") {
        await bridgeAdapter.execute(state.robotId, [safeCommand]);
      }
    }

    if (simAdapter) {
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
    if (simAdapter) {
      simAdapter.state = cloneJson(state);
      simAdapter.stop();
      state = simAdapter.getState();
    } else if (state) {
      state.queue = [];
      state.stopped = true;
    }
    emitState();
    return getState();
  }

  function render(container) {
    simContainer = container || simContainer;
    if (simAdapter && simContainer) {
      simAdapter.render(simContainer, state);
    }
  }

  function createBridgeAdapter(options = {}) {
    const manifest = getManifest();
    bridgeAdapter = new hardware.BridgeAdapter({
      manifest,
      baseUrl: options.baseUrl,
      token: options.token
    });
    state.connection.bridgeUrl = bridgeAdapter.baseUrl;
    return bridgeAdapter;
  }

  function getBridgeAdapter() {
    return bridgeAdapter;
  }

  function setBridgeConnected(statusPayload) {
    state.mode = "local_bridge";
    state.connection.status = statusPayload && statusPayload.status ? statusPayload.status : "CONNECTED";
    emitState();
  }

  function setBridgeSafetyConfirmed(value) {
    bridgeSafetyConfirmed = Boolean(value);
  }

  function isBridgeSafetyConfirmed() {
    return bridgeSafetyConfirmed;
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
    render,
    createBridgeAdapter,
    getBridgeAdapter,
    setBridgeConnected,
    setBridgeSafetyConfirmed,
    isBridgeSafetyConfirmed
  };
})();
