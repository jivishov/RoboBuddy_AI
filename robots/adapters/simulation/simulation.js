(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const safety = NS.RobotSafety;

  class SimulationAdapter {
    constructor(manifest) {
      this.manifest = manifest;
      this.state = safety.createActiveRobotState(manifest.id, manifest.defaultMode);
      this.container = null;
      this.preview3d = null;
      this.preview3dContainer = null;
      this.preview3dRobotId = "";
      this.preview3dStatus = null;
    }

    reset() {
      this.state = safety.createActiveRobotState(this.manifest.id, "simulate");
      this.render(this.container, this.state);
      return this.getState();
    }

    home() {
      this.state.joints = safety.getHomeJoints(this.manifest);
      this.state.stopped = false;
      this.state.lastCommand = { type: "home", robotId: this.manifest.id };
      this.render(this.container, this.state);
      return this.getState();
    }

    stop() {
      this.state.queue = [];
      this.state.stopped = true;
      this.state.lastCommand = { type: "stop", robotId: this.manifest.id };
      this.render(this.container, this.state);
      return this.getState();
    }

    applyCommands(commands) {
      (Array.isArray(commands) ? commands : []).forEach((command) => this.applyCommand(command));
      return this.getState();
    }

    applyCommand(command) {
      if (!command || typeof command !== "object") {
        return this.getState();
      }
      this.state.stopped = false;
      switch (command.type) {
        case "home":
          return this.home();
        case "stop":
          return this.stop();
        case "move_joint":
          this._setJoint(command.joint, command.value);
          break;
        case "move_joints":
          Object.entries(command.joints || {}).forEach(([jointId, value]) => this._setJoint(jointId, value));
          break;
        case "set_gripper":
          this._setJoint("gripper", command.value);
          break;
        case "smooth_move":
          this._setJoint(command.joint, command.to);
          break;
        default:
          break;
      }
      this.state.lastCommand = { ...command };
      this.render(this.container, this.state);
      return this.getState();
    }

    getState() {
      return JSON.parse(JSON.stringify(this.state));
    }

    render(container, state = this.state) {
      this.container = container || this.container;
      if (!this.container) {
        return;
      }
      this.container.innerHTML = "";
      const shell = document.createElement("div");
      shell.className = "robot-sim robot-sim--generic";
      shell.innerHTML = `
        <div class="robot-sim__empty">
          <strong>${escapeHtml(this.manifest.name)}</strong>
          <span>Simulation adapter ready.</span>
        </div>
      `;
      this.container.appendChild(shell);
    }

    dispose() {
      disposeThreePreview(this);
      if (this.container) {
        this.container.innerHTML = "";
      }
      this.container = null;
    }

    _setJoint(jointId, value) {
      const joint = safety.getJointById(this.manifest, jointId);
      if (!joint) {
        return;
      }
      this.state.joints[joint.id] = safety.clampJointValue(joint, value);
    }
  }

  class ExistingArduinoSimulationAdapter extends SimulationAdapter {
    render(container, state = this.state) {
      this.container = container || this.container;
      if (!this.container) {
        return;
      }
      this.container.innerHTML = `
        <div class="robot-sim robot-sim--arduino">
          <strong>Existing Arduino arm preview active</strong>
          <span>The calibrated SVG/3D preview remains the source of truth for this robot.</span>
        </div>
      `;
    }
  }

  class KinematicArmSimulationAdapter extends SimulationAdapter {
    render(container, state = this.state) {
      this.container = container || this.container;
      if (!this.container) {
        return;
      }
      if (renderThreePreview(this, this.container, state)) {
        return;
      }
      const joints = this.manifest.joints || [];
      const values = joints.map((joint) => Number(state.joints[joint.id] ?? joint.home ?? 0));
      const p = armPoints(values);
      const labels = joints.map((joint) => `
        <div><span>${escapeHtml(joint.label)}</span><strong>${formatValue(state.joints[joint.id], joint.unit)}</strong></div>
      `).join("");
      this.container.innerHTML = `
        <div class="robot-sim robot-sim--arm">
          <svg viewBox="0 0 360 260" role="img" aria-label="${escapeHtml(this.manifest.name)} kinematic preview">
            <rect x="0" y="0" width="360" height="260" rx="12" fill="#f7fbff"></rect>
            <line x1="30" y1="220" x2="330" y2="220" stroke="#d7deea" stroke-width="2"></line>
            <circle cx="${p.base.x}" cy="${p.base.y}" r="28" fill="#dbeafe" stroke="#5271ff" stroke-width="4"></circle>
            <line x1="${p.base.x}" y1="${p.base.y}" x2="${p.shoulder.x}" y2="${p.shoulder.y}" stroke="#f59e0b" stroke-width="16" stroke-linecap="round"></line>
            <line x1="${p.shoulder.x}" y1="${p.shoulder.y}" x2="${p.elbow.x}" y2="${p.elbow.y}" stroke="#8e44ad" stroke-width="13" stroke-linecap="round"></line>
            <line x1="${p.elbow.x}" y1="${p.elbow.y}" x2="${p.wrist.x}" y2="${p.wrist.y}" stroke="#0ea5e9" stroke-width="10" stroke-linecap="round"></line>
            <line x1="${p.wrist.x}" y1="${p.wrist.y}" x2="${p.tipA.x}" y2="${p.tipA.y}" stroke="#ef4444" stroke-width="6" stroke-linecap="round"></line>
            <line x1="${p.wrist.x}" y1="${p.wrist.y}" x2="${p.tipB.x}" y2="${p.tipB.y}" stroke="#ef4444" stroke-width="6" stroke-linecap="round"></line>
            ${[p.base, p.shoulder, p.elbow, p.wrist].map((point) => `<circle cx="${point.x}" cy="${point.y}" r="8" fill="#fff" stroke="#1e2430" stroke-width="2"></circle>`).join("")}
          </svg>
          <div class="robot-sim__readout">${labels}</div>
          <p class="robot-sim__note">Educational kinematic preview; hardware calibration may differ.</p>
        </div>
      `;
    }
  }

  class LekiwiSimulationAdapter extends SimulationAdapter {
    stop() {
      if (this.preview3d && typeof this.preview3d.cancelMobileMotion === "function") {
        this.state.mobileBase = this.preview3d.cancelMobileMotion({ lockToVisual: true });
      }
      return super.stop();
    }

    applyCommand(command) {
      if (command && command.type === "drive") {
        const visualPose = this.preview3d && typeof this.preview3d.getVisualMobileBasePose === "function"
          ? this.preview3d.getVisualMobileBasePose()
          : null;
        const startPose = sanitizeMobilePose(visualPose || this.state.mobileBase);
        const durationSeconds = Math.max(0, Number(command.seconds) || 0);
        const targetPose = integrateDrivePose(startPose, command, durationSeconds);
        this.state.mobileBase = targetPose;
        this.state.stopped = false;
        this.state.lastCommand = { ...command };
        this.pendingVisualMotion = {
          id: `drive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          command: { ...command },
          startPose,
          targetPose,
          durationSeconds
        };
        this.render(this.container, this.state);
        return this.getState();
      }
      return super.applyCommand(command);
    }

    render(container, state = this.state) {
      this.container = container || this.container;
      if (!this.container) {
        return;
      }
      if (renderThreePreview(this, this.container, state)) {
        return;
      }
      const base = state.mobileBase || { x: 0, y: 0, theta: 0 };
      const x = 180 + Number(base.x || 0) * 44;
      const y = 150 - Number(base.y || 0) * 44;
      const theta = Number(base.theta || 0);
      const gripper = state.joints.gripper ?? 50;
      const labels = (this.manifest.joints || []).map((joint) => `
        <div><span>${escapeHtml(joint.label)}</span><strong>${formatValue(state.joints[joint.id], joint.unit)}</strong></div>
      `).join("");
      this.container.innerHTML = `
        <div class="robot-sim robot-sim--lekiwi">
          <svg viewBox="0 0 360 300" role="img" aria-label="LeKiwi mobile base simulator">
            <defs>
              <pattern id="lekiwiGrid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#d8dfeb" stroke-width="1"/>
              </pattern>
            </defs>
            <rect x="0" y="0" width="360" height="300" rx="12" fill="#f7fbff"></rect>
            <rect x="0" y="0" width="360" height="300" rx="12" fill="url(#lekiwiGrid)"></rect>
            <g transform="translate(${x} ${y}) rotate(${-theta})">
              <circle cx="0" cy="0" r="34" fill="#dff8ff" stroke="#0b7a75" stroke-width="4"></circle>
              <path d="M 0 -42 L 12 -18 L -12 -18 Z" fill="#0b7a75"></path>
              <line x1="0" y1="0" x2="42" y2="-42" stroke="#8e44ad" stroke-width="8" stroke-linecap="round"></line>
              <line x1="42" y1="-42" x2="76" y2="-28" stroke="#f59e0b" stroke-width="7" stroke-linecap="round"></line>
              <line x1="76" y1="-28" x2="96" y2="-28" stroke="#ef4444" stroke-width="${gripper > 50 ? 8 : 4}" stroke-linecap="round"></line>
            </g>
          </svg>
          <div class="robot-sim__readout">
            <div><span>Base X</span><strong>${base.x.toFixed(2)} m</strong></div>
            <div><span>Base Y</span><strong>${base.y.toFixed(2)} m</strong></div>
            <div><span>Heading</span><strong>${Math.round(base.theta)} deg</strong></div>
            ${labels}
          </div>
        </div>
      `;
    }
  }

  function renderThreePreview(adapter, container, state) {
    const previewRegistry = window.RoboBuddy3DPreview || {};
    const Preview3D = previewRegistry.RobotRigPreview3D;
    const configs = previewRegistry.robotRigPreviewConfigs || {};
    const config = configs[adapter.manifest.id];
    if (typeof Preview3D !== "function" || !config) {
      disposeThreePreview(adapter);
      return false;
    }

    try {
      if (
        !adapter.preview3d ||
        adapter.preview3dContainer !== container ||
        adapter.preview3dRobotId !== adapter.manifest.id
      ) {
        disposeThreePreview(adapter);
        container.innerHTML = createThreePreviewMarkup(adapter.manifest, config);
        const viewport = container.querySelector("[data-robot-sim-3d-viewport]");
        adapter.preview3d = new Preview3D(viewport, {
          manifest: adapter.manifest,
          state,
          config,
          onStatus(status) {
            adapter.preview3dStatus = status;
          }
        });
        adapter.preview3dContainer = container;
        adapter.preview3dRobotId = adapter.manifest.id;
        const resetButton = container.querySelector("[data-robot-sim-3d-reset]");
        if (resetButton) {
          resetButton.addEventListener("click", () => {
            if (adapter.preview3d && typeof adapter.preview3d.resetCamera === "function") {
              adapter.preview3d.resetCamera();
            }
          });
        }
        if (window.lucide) {
          lucide.createIcons({ nodes: container.querySelectorAll("[data-lucide]") });
        }
      }
      adapter.preview3d.updateState(state);

      if (
        adapter.pendingVisualMotion &&
        adapter.preview3d &&
        typeof adapter.preview3d.startMobileMotion === "function"
      ) {
        adapter.preview3d.startMobileMotion(adapter.pendingVisualMotion);
        adapter.pendingVisualMotion = null;
      }

      return true;
    } catch (error) {
      console.warn("Robot 3D simulator unavailable; using SVG fallback.", error);
      disposeThreePreview(adapter);
      return false;
    }
  }

  function createThreePreviewMarkup(manifest, config) {
    return `
      <div class="robot-sim robot-sim--three" data-robot-sim-3d-shell>
        <div class="robot-sim-3d__viewport" data-robot-sim-3d-viewport aria-label="${escapeHtml(manifest.name)} 3D simulator"></div>
        <div class="robot-sim-3d__toolbar">
          <button class="robot-sim-3d__reset" type="button" data-robot-sim-3d-reset title="Reset 3D camera" data-hint="Reset 3D camera">
            <i data-lucide="rotate-ccw" aria-hidden="true"></i>
            <span>Camera</span>
          </button>
        </div>
      </div>
    `;
  }

  function disposeThreePreview(adapter) {
    if (adapter.preview3d && typeof adapter.preview3d.dispose === "function") {
      adapter.preview3d.dispose();
    }
    adapter.preview3d = null;
    adapter.preview3dContainer = null;
    adapter.preview3dRobotId = "";
    adapter.preview3dStatus = null;
    adapter.pendingVisualMotion = null;
  }

  function createSimulationAdapter(manifest) {
    if (!manifest) {
      return null;
    }
    if (manifest.id === "arduino_arm") {
      return new ExistingArduinoSimulationAdapter(manifest);
    }
    if (manifest.id === "lekiwi_sim") {
      return new LekiwiSimulationAdapter(manifest);
    }
    return new KinematicArmSimulationAdapter(manifest);
  }

  function armPoints(values) {
    const shoulder = degToRad((values[1] ?? 0) - 20);
    const elbow = degToRad((values[2] ?? 0) / 2 - 40);
    const wrist = degToRad((values[3] ?? 0) / 3 - 20);
    const base = { x: 104, y: 206 };
    const p1 = pointFrom(base, 74, -shoulder);
    const p2 = pointFrom(p1, 68, -(shoulder + elbow));
    const p3 = pointFrom(p2, 48, -(shoulder + elbow + wrist));
    return {
      base,
      shoulder: p1,
      elbow: p2,
      wrist: p3,
      tipA: { x: p3.x + 24, y: p3.y - 8 },
      tipB: { x: p3.x + 24, y: p3.y + 8 }
    };
  }

  function pointFrom(origin, length, radians) {
    return {
      x: Math.round(origin.x + Math.cos(radians) * length),
      y: Math.round(origin.y + Math.sin(radians) * length)
    };
  }

  function degToRad(degrees) {
    return Number(degrees || 0) * Math.PI / 180;
  }

  function normalizeDegrees(value) {
    let next = Number(value) || 0;
    while (next > 180) next -= 360;
    while (next < -180) next += 360;
    return next;
  }

  function sanitizeMobilePose(value) {
    const pose = value && typeof value === "object" ? value : {};
    return {
      x: Number.isFinite(Number(pose.x)) ? Number(pose.x) : 0,
      y: Number.isFinite(Number(pose.y)) ? Number(pose.y) : 0,
      theta: normalizeDegrees(Number.isFinite(Number(pose.theta)) ? Number(pose.theta) : 0)
    };
  }

  function integrateDrivePose(startPose, command, elapsedSeconds) {
    const start = sanitizeMobilePose(startPose);
    const seconds = Math.max(0, Number(elapsedSeconds) || 0);
    const vx = Number(command && command.vx) || 0;
    const vy = Number(command && command.vy) || 0;
    const omegaDeg = Number(command && command.omega) || 0;
    const theta0 = start.theta * Math.PI / 180;
    const omegaRad = omegaDeg * Math.PI / 180;
    let dx = 0;
    let dy = 0;

    if (command && command.frame === "world") {
      dx = vx * seconds;
      dy = vy * seconds;
    } else if (Math.abs(omegaRad) <= 0.000001) {
      dx = (vx * Math.cos(theta0) - vy * Math.sin(theta0)) * seconds;
      dy = (vx * Math.sin(theta0) + vy * Math.cos(theta0)) * seconds;
    } else {
      const theta1 = theta0 + omegaRad * seconds;
      const integralCos = (Math.sin(theta1) - Math.sin(theta0)) / omegaRad;
      const integralSin = (Math.cos(theta0) - Math.cos(theta1)) / omegaRad;
      dx = vx * integralCos - vy * integralSin;
      dy = vx * integralSin + vy * integralCos;
    }

    return {
      x: start.x + dx,
      y: start.y + dy,
      theta: normalizeDegrees(start.theta + omegaDeg * seconds)
    };
  }

  function formatValue(value, unit) {
    const numeric = Number(value);
    const suffix = unit === "percent" ? "%" : " deg";
    return `${Number.isFinite(numeric) ? Math.round(numeric * 10) / 10 : 0}${suffix}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  NS.RobotSimulation = {
    SimulationAdapter,
    ExistingArduinoSimulationAdapter,
    KinematicArmSimulationAdapter,
    LekiwiSimulationAdapter,
    integrateDrivePose,
    createSimulationAdapter
  };
})();
