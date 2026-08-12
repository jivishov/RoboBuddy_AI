(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  const runtimeJointLimits = new Map();

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
    const overrides = manifest ? runtimeJointLimits.get(manifest.id) : null;
    (manifest && Array.isArray(manifest.joints) ? manifest.joints : []).forEach((joint, index) => {
      const override = overrides && overrides[joint.id];
      map[joint.id] = override
        ? { ...joint, min: Number(override.min), max: Number(override.max), step: Number(override.step) || joint.step, limitSource: override.source || "hardware", index }
        : { ...joint, limitSource: "default", index };
    });
    return map;
  }

  function getJointById(manifest, jointId) {
    return getJointMap(manifest)[jointId] || null;
  }

  function getHomeJoints(manifest) {
    const joints = {};
    Object.values(getJointMap(manifest)).forEach((joint) => {
      joints[joint.id] = Number.isFinite(Number(joint.home)) ? Number(joint.home) : Number(joint.min) || 0;
    });
    return joints;
  }

  function getHomeAngles(manifest) {
    return Object.values(getJointMap(manifest))
      .map((joint) => Number.isFinite(Number(joint.home)) ? Number(joint.home) : Number(joint.min) || 0);
  }

  function getInitialJoints(manifest) {
    const joints = getHomeJoints(manifest);
    const jointMap = getJointMap(manifest);
    const initialJoints = manifest && manifest.initialPose && manifest.initialPose.joints && typeof manifest.initialPose.joints === "object"
      ? manifest.initialPose.joints
      : {};
    Object.entries(initialJoints).forEach(([jointId, value]) => {
      const joint = jointMap[jointId];
      if (joint) {
        joints[joint.id] = clampJointValue(joint, value);
      }
    });
    return joints;
  }

  function getInitialAngles(manifest) {
    const initialJoints = getInitialJoints(manifest);
    return Object.values(getJointMap(manifest))
      .map((joint) => initialJoints[joint.id]);
  }

  function getJointLimits(manifest) {
    return Object.values(getJointMap(manifest))
      .map((joint) => [Number(joint.min), Number(joint.max)]);
  }

  function getRuntimeJointLimits(robotId) {
    const limits = runtimeJointLimits.get(robotId);
    return limits ? cloneJson(limits) : null;
  }

  function setRuntimeJointLimits(robotId, limits) {
    if (!robotId || !limits || typeof limits !== "object" || Array.isArray(limits)) {
      return null;
    }
    const sanitized = {};
    Object.entries(limits).forEach(([jointId, limit]) => {
      const min = Number(limit && limit.min);
      const max = Number(limit && limit.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        return;
      }
      sanitized[jointId] = {
        ...limit,
        min,
        max,
        step: Number.isFinite(Number(limit.step)) && Number(limit.step) > 0 ? Number(limit.step) : 0.1
      };
    });
    if (Object.keys(sanitized).length === 0) {
      runtimeJointLimits.delete(robotId);
      return null;
    }
    runtimeJointLimits.set(robotId, sanitized);
    return cloneJson(sanitized);
  }

  function clearRuntimeJointLimits(robotId) {
    if (robotId) {
      runtimeJointLimits.delete(robotId);
    } else {
      runtimeJointLimits.clear();
    }
  }

  function createActiveRobotState(robotId, mode) {
    const manifest = getManifest(robotId);
    if (!manifest) {
      throw new Error(`Unknown robot: ${robotId || "(active)"}`);
    }
    const selectedMode = manifest.supportedModes.includes(mode) ? mode : manifest.defaultMode;
    const initialJoints = getInitialJoints(manifest);
    const state = {
      robotId: manifest.id,
      mode: selectedMode,
      connection: {
        status: selectedMode === "simulate" ? "simulated" : "disconnected",
        connected: false,
        calibrated: false,
        armedForMotion: false,
        moving: false,
        limitStatus: "unavailable",
        homeCompatible: true,
        homeLimitErrors: [],
        adapter: manifest.hardware ? manifest.hardware.adapter : null,
        portLabel: null,
        port: null,
        bridgeUrl: null,
        robotInstanceId: null,
        lastError: ""
      },
      controlOwner: "idle",
      joints: initialJoints,
      measuredJoints: cloneJson(initialJoints),
      jointLimits: getRuntimeJointLimits(manifest.id) || {},
      gripperMapping: "closed_at_max",
      homeControl: { phase: "idle", error: "" },
      manualControl: { sessionId: "", sequence: -1, joint: "", target: null, final: false, phase: "idle", error: "" },
      observation: { sequence: -1, sampledAtServerMs: 0, ageMs: null, fresh: false },
      leaderControl: {
        mode: "inactive",
        phase: "inactive",
        aligned: false,
        alignmentObservationSequence: -1,
        inputPose: cloneJson(initialJoints),
        acceptedTargetPose: cloneJson(initialJoints),
        measuredPose: cloneJson(initialJoints),
        selectedPair: "base",
        speedLevel: "normal",
        clutchActive: false,
        sessionId: "",
        nextSequence: 1,
        latestIssuedSequence: 0,
        latestAcceptedSequence: 0,
        requestInFlight: false,
        measuredAgeMs: null,
        clampedJoints: [],
        quantizedJoints: [],
        slewLimitedJoints: [],
        downstreamLimitedJoints: [],
        laggingJoints: [],
        rangeRecovery: null,
        lastCancelReason: "",
        lastError: "",
        lastErrorCode: "",
        ownerConflict: ""
      },
      bridgeApiVersion: "",
      bridgeCapabilities: [],
      hardwareFeatures: { virtualLeader: "disabled", gamepadLeader: "disabled" },
      mobileBase: manifest.mobileBase ? cloneJson(manifest.mobileBase.pose || { x: 0, y: 0, theta: 0 }) : null,
      queue: [],
      warnings: [],
      lastCommand: null,
      stopped: false
    };
    if (manifest.humanoid) {
      state.humanoidRoot = { x: 0, z: 0, theta: 0 };
      state.humanoidMotion = {
        active: false,
        id: "",
        phase: "idle",
        progress: 0,
        durationSeconds: 0,
        startedAtMs: 0,
        cancellationId: 0
      };
      state.endEffectors = {
        left_hand: { heldObjectId: "" },
        right_hand: { heldObjectId: "" }
      };
    }
    return state;
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
    Object.values(getJointMap(manifest)).forEach((joint) => {
      const raw = Number(rawJoints[joint.id]);
      const fallback = state.joints[joint.id];
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
    if (manifest.humanoid) {
      const rawRoot = rawState && rawState.humanoidRoot && typeof rawState.humanoidRoot === "object" ? rawState.humanoidRoot : {};
      state.humanoidRoot = {
        x: Number.isFinite(Number(rawRoot.x)) ? Number(rawRoot.x) : 0,
        z: Number.isFinite(Number(rawRoot.z)) ? Number(rawRoot.z) : 0,
        theta: Number.isFinite(Number(rawRoot.theta)) ? Number(rawRoot.theta) : 0
      };
      const rawEffectors = rawState && rawState.endEffectors && typeof rawState.endEffectors === "object" ? rawState.endEffectors : {};
      state.endEffectors = {
        left_hand: { heldObjectId: String(rawEffectors.left_hand && rawEffectors.left_hand.heldObjectId || "") },
        right_hand: { heldObjectId: String(rawEffectors.right_hand && rawEffectors.right_hand.heldObjectId || "") }
      };
      const rawMotion = rawState && rawState.humanoidMotion && typeof rawState.humanoidMotion === "object" ? rawState.humanoidMotion : {};
      state.humanoidMotion = {
        active: Boolean(rawMotion.active),
        id: String(rawMotion.id || ""),
        phase: String(rawMotion.phase || "idle"),
        progress: Math.min(1, Math.max(0, Number(rawMotion.progress) || 0)),
        durationSeconds: Math.max(0, Number(rawMotion.durationSeconds) || 0),
        startedAtMs: Math.max(0, Number(rawMotion.startedAtMs) || 0),
        cancellationId: Math.max(0, Math.round(Number(rawMotion.cancellationId) || 0))
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
    getInitialJoints,
    getInitialAngles,
    getJointLimits,
    getRuntimeJointLimits,
    setRuntimeJointLimits,
    clearRuntimeJointLimits,
    createActiveRobotState,
    sanitizeActiveRobotState,
    clampJointValue
  };
})();
