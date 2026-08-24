export const API_LEVELS = Object.freeze({ guided: 1, builder: 2, challenge: 3 });

export const V2_API_METHODS = Object.freeze({
  "lab.frames": { level: "guided" },
  "lab.observe": { level: "guided" },
  "lab.record_evidence": { level: "guided" },
  "skills.transport": { level: "guided" },
  "skills.fixture_operation": { level: "guided" },
  "robot.command_model": { level: "guided" },
  "robot.get_observation": { level: "guided" },
  "robot.send_action": { level: "guided" },
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
  "compat.catalog": { level: "guided" },
  "compat.connect": { level: "guided" },
  "compat.disconnect": { level: "guided" },
  "compat.send_action": { level: "guided" },
  "compat.get_observation": { level: "guided" },
  "compat.clock.now": { level: "guided" },
  "compat.clock.sleep": { level: "guided" },
  "compat.hardware_unsupported": { level: "guided" },
  "compat.ros.create": { level: "guided" },
  "compat.ros.publish": { level: "guided" },
  "compat.ros.joint_states": { level: "guided" },
  "compat.ros.goal": { level: "guided" },
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
