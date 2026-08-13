export const LAB_BOUNDARY_COPY = Object.freeze({
  short: "Simulation only",
  full: "This workbench teaches robot programming and laboratory handling sequences in simulation. It does not control hardware and is not authorization to perform a physical laboratory procedure.",
  model: "Robot, apparatus, liquid transfer, walking, and collisions are discrete kinematic educational states. No fluid dynamics, torque safety, autonomous planning, rigid-body physics, or dynamic humanoid balance is claimed."
});

export function assistanceCopy(level) {
  if (level === "Guided") return "Named task poses and starter commands are available.";
  if (level === "Builder") return "A reduced starter and task poses are available; checkpoint feedback remains active.";
  return "Only home, dock, and safety pose helpers are available. Reach task poses with joint, drive, or walking commands.";
}

export function nextStepCopy(checkpoint) {
  if (!checkpoint) return "All observable checkpoints are complete. Review the evidence log or reset for another attempt.";
  return `${checkpoint.label}. ${checkpoint.recovery}`;
}
