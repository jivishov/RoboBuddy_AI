(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  function jointMap(manifest) {
    return Object.fromEntries((manifest?.joints || []).map((joint) => [joint.id, joint]));
  }

  function clampJointValue(joint, value) {
    const numeric = Number(value);
    const fallback = Number.isFinite(Number(joint?.home)) ? Number(joint.home) : Number(joint?.min) || 0;
    if (!joint || !Number.isFinite(numeric)) return fallback;
    return Math.min(Number(joint.max), Math.max(Number(joint.min), numeric));
  }

  function getHomeJoints(manifest) {
    return Object.fromEntries((manifest?.joints || []).map((joint) => [joint.id, clampJointValue(joint, joint.home)]));
  }

  function initialJoints(manifest) {
    const joints = getHomeJoints(manifest);
    Object.entries(manifest?.initialPose?.joints || {}).forEach(([jointId, value]) => {
      const joint = getJointById(manifest, jointId);
      if (joint) joints[jointId] = clampJointValue(joint, value);
    });
    return joints;
  }

  function getJointById(manifest, jointId) {
    return jointMap(manifest)[jointId] || null;
  }

  function createActiveRobotState(robotId) {
    const manifest = NS.RobotRegistry?.get(robotId);
    if (!manifest) throw new Error(`Unknown simulation robot: ${robotId || "(none)"}.`);
    const joints = initialJoints(manifest);
    const state = {
      robotId: manifest.id,
      mode: "simulate",
      joints,
      measuredJoints: { ...joints },
      mobileBase: manifest.mobileBase ? { ...(manifest.mobileBase.pose || { x: 0, y: 0, theta: 0 }) } : null,
      queue: [],
      warnings: [],
      lastCommand: null,
      stopped: false
    };
    if (manifest.humanoid) {
      state.humanoidRoot = { x: 0, z: 0, theta: 0 };
      state.humanoidMotion = { active: false, id: "", phase: "idle", progress: 0, durationSeconds: 0, startedAtMs: 0, cancellationId: 0 };
      state.endEffectors = { left_hand: { heldObjectId: "" }, right_hand: { heldObjectId: "" } };
    }
    return state;
  }

  NS.RobotSafety = Object.freeze({ clampJointValue, createActiveRobotState, getHomeJoints, getJointById });
})();
