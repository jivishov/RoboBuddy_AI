(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const DEFAULT_ROBOT_ID = "arduino_arm";
  const ACTIVE_ROBOT_STORAGE_KEY = "robobuddy.activeRobotId";
  const LEGACY_ROBOT_IDS = {
    arduino_howto_arm: DEFAULT_ROBOT_ID,
    howto_arm: DEFAULT_ROBOT_ID,
    howtomechatronics_arm: DEFAULT_ROBOT_ID
  };

  const registry = new Map();
  let activeRobotId = DEFAULT_ROBOT_ID;

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeRobotId(robotId) {
    const raw = String(robotId || "").trim();
    return LEGACY_ROBOT_IDS[raw] || raw || DEFAULT_ROBOT_ID;
  }

  function readStoredActiveRobotId() {
    try {
      return normalizeRobotId(window.localStorage.getItem(ACTIVE_ROBOT_STORAGE_KEY));
    } catch (error) {
      return DEFAULT_ROBOT_ID;
    }
  }

  function persistActiveRobotId(robotId) {
    try {
      window.localStorage.setItem(ACTIVE_ROBOT_STORAGE_KEY, robotId);
    } catch (error) {
      // Local storage persistence is optional; the in-memory active robot still works.
    }
  }

  function isValidManifest(manifest) {
    return Boolean(
      manifest &&
      typeof manifest === "object" &&
      typeof manifest.id === "string" &&
      typeof manifest.name === "string" &&
      Array.isArray(manifest.supportedModes) &&
      Array.isArray(manifest.capabilities) &&
      Array.isArray(manifest.joints)
    );
  }

  function register(manifest) {
    if (!isValidManifest(manifest)) {
      throw new Error("Robot manifest must include id, name, supportedModes, capabilities, and joints.");
    }
    const normalized = cloneJson(manifest);
    normalized.id = normalizeRobotId(normalized.id);
    registry.set(normalized.id, Object.freeze(normalized));

    const stored = readStoredActiveRobotId();
    activeRobotId = registry.has(stored) ? stored : DEFAULT_ROBOT_ID;
    if (!registry.has(activeRobotId) && registry.has(DEFAULT_ROBOT_ID)) {
      activeRobotId = DEFAULT_ROBOT_ID;
      persistActiveRobotId(DEFAULT_ROBOT_ID);
    }
  }

  function list() {
    return Array.from(registry.values()).map(cloneJson);
  }

  function get(robotId) {
    const id = normalizeRobotId(robotId);
    const manifest = registry.get(id);
    return manifest ? cloneJson(manifest) : null;
  }

  function getDefaultRobotId() {
    return DEFAULT_ROBOT_ID;
  }

  function getActive() {
    const id = registry.has(activeRobotId) ? activeRobotId : DEFAULT_ROBOT_ID;
    return get(id);
  }

  function setActive(robotId, options = {}) {
    const requested = normalizeRobotId(robotId);
    const next = registry.has(requested) ? requested : DEFAULT_ROBOT_ID;
    const previous = activeRobotId;
    activeRobotId = next;
    persistActiveRobotId(next);

    if (previous !== next || options.forceEvent) {
      window.dispatchEvent(new CustomEvent("robobuddy:active-robot-change", {
        detail: {
          robotId: next,
          previousRobotId: previous,
          manifest: get(next)
        }
      }));
    }
    return get(next);
  }

  function resolveRobotId(robotId) {
    const normalized = normalizeRobotId(robotId);
    return registry.has(normalized) ? normalized : DEFAULT_ROBOT_ID;
  }

  function migrateSavedRobotId(robotId) {
    return normalizeRobotId(robotId);
  }

  function initialize() {
    const stored = readStoredActiveRobotId();
    activeRobotId = registry.has(stored) ? stored : DEFAULT_ROBOT_ID;
    if (stored !== activeRobotId) {
      persistActiveRobotId(activeRobotId);
    }
  }

  NS.RobotRegistry = {
    ACTIVE_ROBOT_STORAGE_KEY,
    LEGACY_ROBOT_IDS,
    register,
    list,
    get,
    getActive,
    setActive,
    getDefaultRobotId,
    resolveRobotId,
    migrateSavedRobotId,
    initialize
  };
})();
