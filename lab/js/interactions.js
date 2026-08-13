import { snakeToCamel } from "./calculations.js";

const METHOD_ALIASES = Object.freeze({
  insert: "insert_into",
  pour: "pour_into",
  read: "read_instrument",
  record: "record_observation",
  release: "release_object",
  walk: "humanoid_walk",
  turn: "humanoid_turn"
});

const POSITIONAL_KEYS = Object.freeze({
  move_to_pose: ["poseId", "seconds"],
  grasp: ["objectId", "effector"],
  place: ["zoneId", "effector"],
  pour_into: ["targetId", "amount", "effector"],
  insert_into: ["targetId", "effector"],
  operate: ["controlId", "mode", "value", "effector"],
  read_instrument: ["instrumentId"],
  record_observation: ["fieldId", "value"],
  move_joint: ["joint", "value", "speed"],
  move_joints: ["joints", "speed"],
  set_gripper: ["value", "effector"],
  drive: ["vx", "vy", "omega", "seconds"],
  humanoid_walk: ["direction", "steps", "stepLengthM", "speed"],
  humanoid_turn: ["angleDeg", "seconds"],
  set_posture: ["posture", "seconds"],
  pick_nearest: ["hand"],
  release_object: ["hand"],
  wait: ["seconds"]
});

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const previous = value[index - 1];
    if (quote) {
      if (character === quote && previous !== "\\") quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if ("[{(".includes(character)) depth += 1;
    else if ("]})".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function assignmentIndex(value) {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const previous = value[index - 1];
    if (quote) {
      if (character === quote && previous !== "\\") quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if ("[{(".includes(character)) depth += 1;
    else if ("]})".includes(character)) depth -= 1;
    else if (character === "=" && depth === 0) return index;
  }
  return -1;
}

function parseLiteral(raw) {
  const value = raw.trim();
  if (!value) return "";
  if (value === "True") return true;
  if (value === "False") return false;
  if (value === "None") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith("\"")) return JSON.parse(value);
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  if (value.startsWith("{") || value.startsWith("[")) {
    const jsonCompatible = value.replace(/'/g, "\"").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
    return JSON.parse(jsonCompatible);
  }
  throw new Error(`Unsupported Python literal: ${value}`);
}

export function parsePythonProgram(source) {
  const commands = [];
  const lines = String(source || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^robot\.([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)\s*$/);
    if (!match) throw new Error(`Line ${index + 1}: use one robot.command(...) call per line.`);
    const method = METHOD_ALIASES[match[1]] || match[1];
    if (!Object.prototype.hasOwnProperty.call(POSITIONAL_KEYS, method) && !["home", "stop"].includes(method)) {
      throw new Error(`Line ${index + 1}: unsupported robot method ${match[1]}.`);
    }
    const command = { type: method };
    const positional = POSITIONAL_KEYS[method] || [];
    let positionalIndex = 0;
    splitTopLevel(match[2]).forEach((argument) => {
      const equals = assignmentIndex(argument);
      if (equals >= 0) {
        const key = snakeToCamel(argument.slice(0, equals).trim());
        command[key] = parseLiteral(argument.slice(equals + 1));
      } else {
        const key = positional[positionalIndex];
        if (!key) throw new Error(`Line ${index + 1}: too many positional arguments for ${method}.`);
        command[key] = parseLiteral(argument);
        positionalIndex += 1;
      }
    });
    commands.push(command);
  });
  if (!commands.length) throw new Error("The Python draft does not contain any robot commands.");
  return commands;
}

function snake(value) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function commandsToPython(commands) {
  return (commands || []).map((command) => {
    const args = Object.entries(command)
      .filter(([key, value]) => key !== "type" && value !== undefined && value !== "")
      .map(([key, value]) => `${snake(key)}=${JSON.stringify(value)}`)
      .join(", ");
    return `robot.${command.type}(${args})`;
  }).join("\n");
}

function storageKey(taskId, language) {
  return `robobuddy:lab-draft:v1:${taskId}:${language}`;
}

export function loadDraft(taskId, language, fallback = "") {
  try {
    return window.localStorage.getItem(storageKey(taskId, language)) ?? fallback;
  } catch (error) {
    return fallback;
  }
}

export function saveDraft(taskId, language, value) {
  try {
    window.localStorage.setItem(storageKey(taskId, language), String(value || ""));
    return true;
  } catch (error) {
    return false;
  }
}

export function readCameraPreferences() {
  try {
    return {
      movement: window.localStorage.getItem("robobuddy:lab-camera-movement") !== "false",
      zoom: window.localStorage.getItem("robobuddy:lab-camera-zoom") !== "false"
    };
  } catch (error) {
    return { movement: true, zoom: true };
  }
}

export function saveCameraPreference(name, enabled) {
  try {
    window.localStorage.setItem(`robobuddy:lab-camera-${name}`, String(Boolean(enabled)));
  } catch (error) {
    // Camera preferences are optional; current-session behavior remains available.
  }
}
