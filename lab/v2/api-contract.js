export const API_LEVELS = Object.freeze({ guided: 1, builder: 2, challenge: 3 });

export const V2_API_METHODS = Object.freeze({
  "lab.frames": { level: "guided" },
  "lab.observe": { level: "guided" },
  "lab.record_evidence": { level: "guided" },
  "skills.transport": { level: "guided" },
  "skills.fixture_operation": { level: "guided" },
  "robot.joint_state": { level: "builder" },
  "robot.plan_to_frame": { level: "builder" },
  "robot.execute": { level: "builder" },
  "robot.grasp": { level: "builder" },
  "robot.release": { level: "builder" },
  "robot.navigate": { level: "builder" },
  "robot.dock": { level: "builder" },
  "robot.replan": { level: "builder" },
  "robot.pause": { level: "guided" },
  "robot.resume": { level: "guided" },
  "robot.stop": { level: "guided" },
  "robot.reset": { level: "guided" },
  "challenge.solve_ik": { level: "challenge" },
  "challenge.plan_waypoints": { level: "challenge" },
  "challenge.execute_waypoints": { level: "challenge" }
});

export function methodAvailable(method, level) {
  const contract = V2_API_METHODS[method];
  return Boolean(contract && API_LEVELS[level] >= API_LEVELS[contract.level]);
}

export function assertApiMethod(method, level) {
  if (!V2_API_METHODS[method]) throw new Error(`Unknown RoboBuddy v2 API method: ${method}.`);
  if (!methodAvailable(method, level)) throw new Error(`${method} requires ${V2_API_METHODS[method].level} access; this scenario exposes ${level}.`);
}
