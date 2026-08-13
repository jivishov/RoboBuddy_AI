import { deepClone } from "./math.js";

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function buildContactSequence(phases) {
  const required = ["pre_contact", "contact", "lift", "transfer", "place", "retreat"];
  const byPhase = new Map((phases || []).map((phase) => [phase.phase, phase]));
  const missing = required.filter((phase) => !byPhase.has(phase));
  if (missing.length) throw new Error(`Contact sequence is missing phases: ${missing.join(", ")}.`);
  const samples = [];
  required.forEach((phaseName) => {
    const phase = byPhase.get(phaseName);
    (phase.samples || []).forEach((sample) => samples.push({ ...deepClone(sample), phase: phaseName }));
    const sampleIndex = Math.max(0, samples.length - 1);
    (phase.events || []).forEach((event) => samples[sampleIndex].events = [...(samples[sampleIndex].events || []), deepClone(event)]);
  });
  return { schema: "robobuddy.trajectory.v2", kind: "contact-sequence", samples };
}

export class TrajectoryExecutor {
  constructor(options = {}) {
    this.sleep = options.sleep || defaultSleep;
    this.onSample = options.onSample || (() => {});
    this.onEvent = options.onEvent || (() => {});
    this.baseline = deepClone(options.baseline || null);
    this.reset();
  }

  load(trajectory) {
    if (!trajectory || trajectory.schema !== "robobuddy.trajectory.v2" || !Array.isArray(trajectory.samples)) {
      throw new Error("TrajectoryExecutor requires a robobuddy.trajectory.v2 trajectory.");
    }
    this.trajectory = deepClone(trajectory);
    this.index = 0;
    this.status = "ready";
    this.lastSample = null;
    this.stopReason = "";
    return this.snapshot();
  }

  snapshot() {
    return deepClone({
      status: this.status,
      index: this.index,
      sampleCount: this.trajectory?.samples?.length || 0,
      lastSample: this.lastSample,
      stopReason: this.stopReason
    });
  }

  pause() {
    if (this.status === "running") this.status = "paused";
    return this.snapshot();
  }

  resume() {
    if (this.status === "paused") this.status = "running";
    return this.snapshot();
  }

  stop(reason = "user") {
    if (["running", "paused", "ready"].includes(this.status)) {
      this.status = "stopped";
      this.stopReason = String(reason || "user");
    }
    return this.snapshot();
  }

  reset() {
    this.trajectory = null;
    this.index = 0;
    this.status = "idle";
    this.lastSample = deepClone(this.baseline);
    this.stopReason = "";
    return this.snapshot();
  }

  async step() {
    if (!this.trajectory) throw new Error("No trajectory is loaded.");
    if (this.status === "stopped" || this.status === "complete") return false;
    if (this.status === "paused") return false;
    if (this.status === "ready") this.status = "running";
    const sample = this.trajectory.samples[this.index];
    if (!sample) { this.status = "complete"; return false; }
    this.lastSample = deepClone(sample);
    await this.onSample(deepClone(sample), this.index);
    for (const event of sample.events || []) {
      if (this.status === "stopped") break;
      await this.onEvent(deepClone(event), deepClone(sample), this.index);
    }
    if (this.status === "stopped") return false;
    this.index += 1;
    if (this.index >= this.trajectory.samples.length) this.status = "complete";
    return true;
  }

  async run(options = {}) {
    if (!this.trajectory) throw new Error("No trajectory is loaded.");
    if (this.status === "ready") this.status = "running";
    const intervalMs = Math.max(0, Number(options.intervalMs ?? 0));
    while (!["complete", "stopped"].includes(this.status)) {
      if (this.status === "paused") { await this.sleep(Math.max(10, intervalMs || 10)); continue; }
      const advanced = await this.step();
      if (!advanced && this.status !== "paused") break;
      if (intervalMs && this.status === "running") await this.sleep(intervalMs);
    }
    return this.snapshot();
  }
}
