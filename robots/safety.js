(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;

  const SAFETY_LIMITS = Object.freeze({
    maxCommands: 1000,
    speedMin: 1,
    speedMax: 100,
    waitMinSeconds: 0,
    waitMaxSeconds: 30,
    smoothMoveMinSeconds: 0.2,
    smoothMoveMaxSeconds: 10,
    pythonTimeoutMs: 8000
  });

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getManifest(robotId) {
    if (!registry) {
      return null;
    }
    return robotId ? registry.get(robotId) : registry.getActive();
  }

  function getJointMap(manifest) {
    const map = {};
    (manifest && Array.isArray(manifest.joints) ? manifest.joints : []).forEach((joint, index) => {
      map[joint.id] = { ...joint, index };
    });
    return map;
  }

  function getJointById(manifest, jointId) {
    return getJointMap(manifest)[jointId] || null;
  }

  function getHomeJoints(manifest) {
    const joints = {};
    (manifest && Array.isArray(manifest.joints) ? manifest.joints : []).forEach((joint) => {
      joints[joint.id] = Number.isFinite(Number(joint.home)) ? Number(joint.home) : Number(joint.min) || 0;
    });
    return joints;
  }

  function getHomeAngles(manifest) {
    return (manifest && Array.isArray(manifest.joints) ? manifest.joints : [])
      .map((joint) => Number.isFinite(Number(joint.home)) ? Number(joint.home) : Number(joint.min) || 0);
  }

  function getJointLimits(manifest) {
    return (manifest && Array.isArray(manifest.joints) ? manifest.joints : [])
      .map((joint) => [Number(joint.min), Number(joint.max)]);
  }

  function createActiveRobotState(robotId, mode) {
    const manifest = getManifest(robotId);
    if (!manifest) {
      throw new Error(`Unknown robot: ${robotId || "(active)"}`);
    }
    const selectedMode = manifest.supportedModes.includes(mode) ? mode : manifest.defaultMode;
    return {
      robotId: manifest.id,
      mode: selectedMode,
      connection: {
        status: selectedMode === "simulate" ? "simulated" : "disconnected",
        adapter: manifest.hardware ? manifest.hardware.adapter : null,
        portLabel: null,
        bridgeUrl: null
      },
      joints: getHomeJoints(manifest),
      mobileBase: manifest.mobileBase ? cloneJson(manifest.mobileBase.pose || { x: 0, y: 0, theta: 0 }) : null,
      queue: [],
      warnings: [],
      lastCommand: null,
      stopped: false
    };
  }

  function sanitizeActiveRobotState(rawState) {
    const requestedId = rawState && rawState.robotId ? rawState.robotId : (registry ? registry.getDefaultRobotId() : "arduino_arm");
    const manifest = getManifest(requestedId);
    if (!manifest) {
      return createActiveRobotState(registry.getDefaultRobotId());
    }
    const mode = rawState && manifest.supportedModes.includes(rawState.mode) ? rawState.mode : manifest.defaultMode;
    const state = createActiveRobotState(manifest.id, mode);
    const rawJoints = rawState && rawState.joints && typeof rawState.joints === "object" ? rawState.joints : {};
    manifest.joints.forEach((joint) => {
      const raw = Number(rawJoints[joint.id]);
      const fallback = Number.isFinite(Number(joint.home)) ? Number(joint.home) : Number(joint.min) || 0;
      const value = Number.isFinite(raw) ? raw : fallback;
      state.joints[joint.id] = Math.min(Number(joint.max), Math.max(Number(joint.min), value));
    });
    if (manifest.mobileBase) {
      const rawBase = rawState && rawState.mobileBase && typeof rawState.mobileBase === "object" ? rawState.mobileBase : {};
      state.mobileBase = {
        x: Number.isFinite(Number(rawBase.x)) ? Number(rawBase.x) : 0,
        y: Number.isFinite(Number(rawBase.y)) ? Number(rawBase.y) : 0,
        theta: Number.isFinite(Number(rawBase.theta)) ? Number(rawBase.theta) : 0
      };
    }
    return state;
  }

  function clampJointValue(joint, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return Number.isFinite(Number(joint.home)) ? Number(joint.home) : Number(joint.min) || 0;
    }
    return Math.min(Number(joint.max), Math.max(Number(joint.min), numeric));
  }

  NS.RobotSafety = {
    SAFETY_LIMITS,
    getManifest,
    getJointMap,
    getJointById,
    getHomeJoints,
    getHomeAngles,
    getJointLimits,
    createActiveRobotState,
    sanitizeActiveRobotState,
    clampJointValue
  };
})();
