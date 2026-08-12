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
      this.leaderInteractionCallbacks = null;
      this.appliedLeaderInteractionCallbacks = null;
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

    applyLeaderFrame(joints, options = {}) {
      const next = {};
      this.manifest.joints.forEach((joint) => {
        const effectiveJoint = safety.getJointById(this.manifest, joint.id) || joint;
        next[joint.id] = safety.clampJointValue(effectiveJoint, joints && joints[joint.id]);
      });
      this.state.joints = { ...next };
      this.state.measuredJoints = { ...next };
      this.state.controlOwner = options.final ? "idle" : "virtual_leader";
      this.state.stopped = false;
      this.state.leaderControl = {
        ...(this.state.leaderControl || {}),
        mode: "leader",
        phase: options.final ? "ready" : "live",
        aligned: true,
        inputPose: { ...next },
        acceptedTargetPose: { ...next },
        measuredPose: { ...next },
        latestAcceptedSequence: Number(options.sequence) || 0,
        requestInFlight: false
      };
      this.state.lastCommand = { type: "virtual_leader_frame", final: Boolean(options.final) };
      this.render(this.container, this.state);
      return this.getState();
    }

    setLeaderInteractionCallbacks(callbacks) {
      this.leaderInteractionCallbacks = callbacks || null;
      if (this.preview3d && typeof this.preview3d.setLeaderInteractionCallbacks === "function") {
        this.preview3d.setLeaderInteractionCallbacks(this.leaderInteractionCallbacks);
        this.appliedLeaderInteractionCallbacks = this.leaderInteractionCallbacks;
      }
    }

    cancelLeaderInteraction(reason = "mode_switch") {
      if (this.preview3d && typeof this.preview3d.cancelLeaderInteraction === "function") {
        this.preview3d.cancelLeaderInteraction(reason);
      }
    }

    getLeaderDebugSnapshot() {
      return this.preview3d && typeof this.preview3d.getLeaderDebugSnapshot === "function"
        ? this.preview3d.getLeaderDebugSnapshot()
        : null;
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
      renderThreePreview(this, this.container, state);
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
      renderThreePreview(this, this.container, state);
    }
  }

  function renderThreePreview(adapter, container, state) {
    const previewRegistry = window.RoboBuddy3DPreview || {};
    const Preview3D = previewRegistry.RobotRigPreview3D;
    const configs = previewRegistry.robotRigPreviewConfigs || {};
    const config = configs[adapter.manifest.id];
    if (typeof Preview3D !== "function" || !config) {
      renderThreePreviewUnavailable(adapter, container);
      return true;
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
        const previewConfig = inspectionCameraConfig(config, container.dataset.robotCameraPreset);
        adapter.preview3d = new Preview3D(viewport, {
          manifest: adapter.manifest,
          state,
          config: previewConfig,
          onStatus(status) {
            adapter.preview3dStatus = status;
          },
          onUnavailable(error) {
            console.warn("Robot 3D simulator unavailable.", error);
            renderThreePreviewUnavailable(adapter, container);
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
      const leader = state && state.leaderControl;
      if (leader && typeof adapter.preview3d.setLeaderPoseLayers === "function") {
        adapter.preview3d.setLeaderPoseLayers({
          active: leader.mode === "leader",
          input: leader.inputPose || state.joints,
          target: leader.acceptedTargetPose || state.joints,
          measured: leader.measuredPose || state.measuredJoints || state.joints,
          visibility: leader.layerVisibility || { input: true, target: true, measured: true },
          handlesVisible: leader.mode === "leader"
        });
      }
      if (
        typeof adapter.preview3d.setLeaderInteractionCallbacks === "function" &&
        adapter.appliedLeaderInteractionCallbacks !== adapter.leaderInteractionCallbacks
      ) {
        adapter.preview3d.setLeaderInteractionCallbacks(adapter.leaderInteractionCallbacks || null);
        adapter.appliedLeaderInteractionCallbacks = adapter.leaderInteractionCallbacks;
      }

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
      console.warn("Robot 3D simulator unavailable.", error);
      renderThreePreviewUnavailable(adapter, container);
      return true;
    }
  }

  function inspectionCameraConfig(config, preset) {
    if (preset !== "inspection" || !config || !config.camera) {
      return config;
    }
    const position = Array.isArray(config.camera.position) ? config.camera.position : [360, 260, 500];
    const target = Array.isArray(config.camera.target) ? config.camera.target : [0, 90, 0];
    const inspectionPosition = position.map((value, index) => {
      const targetValue = Number(target[index]) || 0;
      return targetValue + ((Number(value) || 0) - targetValue) * 0.62;
    });
    return {
      ...config,
      camera: {
        ...config.camera,
        position: inspectionPosition,
        target: target.slice()
      }
    };
  }

  function renderThreePreviewUnavailable(adapter, container) {
    disposeThreePreview(adapter);
    container.innerHTML = createThreeUnavailableMarkup();
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

  function createThreeUnavailableMarkup() {
    return `
      <div class="robot-sim robot-sim--three robot-sim--unavailable" data-robot-sim-3d-unavailable>
        <p class="robot-sim-3d__fallback-status" role="status" aria-live="polite">3D preview unavailable.</p>
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
    adapter.appliedLeaderInteractionCallbacks = null;
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
