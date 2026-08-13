(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const DEFAULT_LIMITS = [
    [0, 180],
    [15, 165],
    [0, 180],
    [0, 180],
    [0, 180],
    [25, 130]
  ];

  class ArmPreview {
    constructor(svgElement, options = {}) {
      this.svg = svgElement;
      this.options = options;
      this.colors = ["#5271ff", "#f59e0b", "#8e44ad", "#16a34a", "#0ea5e9", "#ef4444"];
      this.labels = ["Base", "Shoulder", "Elbow", "Wrist Rot", "Wrist Tilt", "Gripper"];
      this.jointLimits = Array.isArray(options.jointLimits) ? options.jointLimits : DEFAULT_LIMITS;
      this.angles = this._sanitizeAngles(options.initialAngles || [90, 90, 90, 90, 90, 90]);
      this.interactive = true;
      this.dragState = null;
      this.nodes = {};

      this._boundPointerMove = (event) => this._onPointerMove(event);
      this._boundPointerUp = (event) => this._onPointerUp(event);

      this._buildScene();
      this.render();
    }

    setAngles(nextAngles) {
      if (!Array.isArray(nextAngles) || nextAngles.length < 6) {
        return;
      }

      this.angles = this._sanitizeAngles(nextAngles);
      this.render();
    }

    setAngle(index, value) {
      if (!Number.isInteger(index) || index < 0 || index > 5) {
        return;
      }

      const next = this.angles.slice();
      next[index] = value;
      this.angles = this._sanitizeAngles(next);
      this.render();
    }

    getAngles() {
      return this.angles.slice();
    }

    setInteractive(enabled) {
      this.interactive = Boolean(enabled);
      this.svg.classList.toggle("is-interactive-disabled", !this.interactive);
      if (!this.interactive) {
        this._cancelDrag();
      }
    }

    render() {
      const width = this._getViewBoxWidth();
      const height = this._getViewBoxHeight();
      const geometry = this._computeGeometry(width, height, this.angles);

      // Ground shadow
      this._setAttributes(this.nodes.groundShadow, {
        cx: width * 0.42,
        cy: height * 0.90,
        rx: width * 0.28,
        ry: 6
      });

      // Ground
      this._setAttributes(this.nodes.ground, {
        x: width * 0.12,
        y: height * 0.84,
        width: width * 0.60,
        height: height * 0.10,
        rx: 10
      });

      // Pedestal
      const pedX = geometry.base.x - width * 0.09;
      const pedY = geometry.base.y - height * 0.10;
      const pedW = width * 0.18;
      const pedH = height * 0.12;
      this._setAttributes(this.nodes.pedestal, {
        x: pedX,
        y: pedY,
        width: pedW,
        height: pedH,
        rx: 6
      });

      // Pedestal highlight
      this._setAttributes(this.nodes.pedestalHighlight, {
        x: pedX + 2,
        y: pedY,
        width: pedW - 4,
        height: 4,
        rx: 2
      });

      // Main arm links
      this._setLine(this.nodes.linkShoulder, geometry.base, geometry.p1);
      this._setLine(this.nodes.linkElbow, geometry.p1, geometry.p2);
      this._setLine(this.nodes.linkWrist, geometry.p2, geometry.p3);

      // Shadow lines (offset +1,+2)
      this._setLine(this.nodes.linkShoulderShadow,
        { x: geometry.base.x + 1, y: geometry.base.y + 2 },
        { x: geometry.p1.x + 1, y: geometry.p1.y + 2 }
      );
      this._setLine(this.nodes.linkElbowShadow,
        { x: geometry.p1.x + 1, y: geometry.p1.y + 2 },
        { x: geometry.p2.x + 1, y: geometry.p2.y + 2 }
      );
      this._setLine(this.nodes.linkWristShadow,
        { x: geometry.p2.x + 1, y: geometry.p2.y + 2 },
        { x: geometry.p3.x + 1, y: geometry.p3.y + 2 }
      );

      // Highlight lines (offset -1,-1)
      this._setLine(this.nodes.linkShoulderHighlight,
        { x: geometry.base.x - 1, y: geometry.base.y - 1 },
        { x: geometry.p1.x - 1, y: geometry.p1.y - 1 }
      );
      this._setLine(this.nodes.linkElbowHighlight,
        { x: geometry.p1.x - 1, y: geometry.p1.y - 1 },
        { x: geometry.p2.x - 1, y: geometry.p2.y - 1 }
      );
      this._setLine(this.nodes.linkWristHighlight,
        { x: geometry.p2.x - 1, y: geometry.p2.y - 1 },
        { x: geometry.p3.x - 1, y: geometry.p3.y - 1 }
      );

      // Gripper body
      this._setAttributes(this.nodes.gripperBody, {
        x: geometry.p3.x - 7,
        y: geometry.p3.y - 4,
        width: 14,
        height: 8,
        transform: `rotate(${-radToDeg(geometry.wristTheta)}, ${geometry.p3.x}, ${geometry.p3.y})`
      });

      // Claws and tips
      this._setLine(this.nodes.clawA, geometry.p3, geometry.clawA);
      this._setLine(this.nodes.clawB, geometry.p3, geometry.clawB);
      this._setPoint(this.nodes.clawTipA, geometry.clawA);
      this._setPoint(this.nodes.clawTipB, geometry.clawB);

      // Base ring and direction
      this._setAttributes(this.nodes.baseRing, {
        cx: geometry.base.x,
        cy: geometry.base.y,
        r: 30
      });
      this._setLine(this.nodes.baseDirection, geometry.base, geometry.baseDirection);

      // Wrist rotation indicator
      this._setAttributes(this.nodes.wristRotRing, {
        cx: geometry.p3.x,
        cy: geometry.p3.y,
        r: 12
      });
      this._setLine(this.nodes.wristRotMarker, geometry.p3, geometry.wristRotMarker);

      // Joints
      this._setPoint(this.nodes.baseJoint, geometry.base);
      this._setPoint(this.nodes.shoulderJoint, geometry.p1);
      this._setPoint(this.nodes.elbowJoint, geometry.p2);
      this._setPoint(this.nodes.wristJoint, geometry.p3);

      // Joint center dots
      this._setPoint(this.nodes.baseJointDot, geometry.base);
      this._setPoint(this.nodes.shoulderJointDot, geometry.p1);
      this._setPoint(this.nodes.elbowJointDot, geometry.p2);
      this._setPoint(this.nodes.wristJointDot, geometry.p3);

      // Handles
      this._setPoint(this.nodes.shoulderHandle, geometry.p1);
      this._setPoint(this.nodes.elbowHandle, geometry.p2);
      this._setPoint(this.nodes.wristHandle, geometry.p3);
      this._setPoint(this.nodes.endEffectorHandle, geometry.tip);

      this._updateTrackLayout(width, height);
      this._updateTrackKnobs(width, height);
      this._updateDragStyles();
    }

    _buildScene() {
      const width = this._getViewBoxWidth();
      const height = this._getViewBoxHeight();

      while (this.svg.firstChild) {
        this.svg.removeChild(this.svg.firstChild);
      }

      this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      this.svg.style.touchAction = "none";

      // ---- SVG Defs: filters and gradients ----
      const defs = this._svgEl("defs");

      // Arm shadow
      const armShadowFilter = this._svgEl("filter", { id: "armShadow", x: "-20%", y: "-20%", width: "140%", height: "140%" });
      armShadowFilter.appendChild(this._svgEl("feDropShadow", { dx: "2", dy: "3", stdDeviation: "3", "flood-color": "#1e293b", "flood-opacity": "0.18" }));
      defs.appendChild(armShadowFilter);

      // Ground gradient
      const groundGrad = this._svgEl("linearGradient", { id: "groundGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
      groundGrad.appendChild(this._svgEl("stop", { offset: "0%", "stop-color": "#e2eaf7" }));
      groundGrad.appendChild(this._svgEl("stop", { offset: "100%", "stop-color": "#b8c4d8" }));
      defs.appendChild(groundGrad);

      // Pedestal gradient
      const pedestalGrad = this._svgEl("linearGradient", { id: "pedestalGrad", x1: "0", y1: "0", x2: "0", y2: "1" });
      pedestalGrad.appendChild(this._svgEl("stop", { offset: "0%", "stop-color": "#c2cee0" }));
      pedestalGrad.appendChild(this._svgEl("stop", { offset: "40%", "stop-color": "#8a9ab5" }));
      pedestalGrad.appendChild(this._svgEl("stop", { offset: "100%", "stop-color": "#7585a0" }));
      defs.appendChild(pedestalGrad);

      // Handle glow filter
      const handleGlowFilter = this._svgEl("filter", { id: "handleGlow", x: "-50%", y: "-50%", width: "200%", height: "200%" });
      handleGlowFilter.appendChild(this._svgEl("feGaussianBlur", { stdDeviation: "3", result: "glow" }));
      const hgMerge = this._svgEl("feMerge");
      hgMerge.appendChild(this._svgEl("feMergeNode", { in: "glow" }));
      hgMerge.appendChild(this._svgEl("feMergeNode", { in: "SourceGraphic" }));
      handleGlowFilter.appendChild(hgMerge);
      defs.appendChild(handleGlowFilter);

      // Pedestal shadow filter
      const pedestalShadowFilter = this._svgEl("filter", { id: "pedestalShadow", x: "-30%", y: "-10%", width: "160%", height: "150%" });
      pedestalShadowFilter.appendChild(this._svgEl("feDropShadow", { dx: "0", dy: "2", stdDeviation: "4", "flood-color": "#1e293b", "flood-opacity": "0.12" }));
      defs.appendChild(pedestalShadowFilter);

      this.svg.appendChild(defs);

      // ---- Layers ----
      this.nodes.layerStatic = this._svgEl("g", { class: "arm-layer-static" });
      this.nodes.layerArm = this._svgEl("g", { class: "arm-layer-dynamic", filter: "url(#armShadow)" });
      this.nodes.layerOverlay = this._svgEl("g", { class: "arm-layer-overlay" });

      // ---- Layer: Static (ground + pedestal) ----
      this.nodes.groundShadow = this._svgEl("ellipse", {
        fill: "#1e293b",
        opacity: "0.06"
      });
      this.nodes.ground = this._svgEl("rect", {
        fill: "url(#groundGrad)",
        rx: "10",
        ry: "10"
      });
      this.nodes.pedestal = this._svgEl("rect", {
        fill: "url(#pedestalGrad)",
        rx: "6",
        ry: "6",
        filter: "url(#pedestalShadow)"
      });
      this.nodes.pedestalHighlight = this._svgEl("rect", {
        fill: "rgba(255,255,255,0.25)",
        rx: "6",
        ry: "6"
      });

      this.nodes.layerStatic.appendChild(this.nodes.groundShadow);
      this.nodes.layerStatic.appendChild(this.nodes.ground);
      this.nodes.layerStatic.appendChild(this.nodes.pedestal);
      this.nodes.layerStatic.appendChild(this.nodes.pedestalHighlight);

      // ---- Layer: Arm ----

      // Base ring and direction marker
      this.nodes.baseRing = this._svgEl("circle", {
        fill: "none",
        stroke: this.colors[0],
        "stroke-width": "2.5",
        "stroke-dasharray": "5 4",
        opacity: "0.65"
      });
      this.nodes.baseDirection = this._svgEl("line", {
        stroke: this.colors[0],
        "stroke-width": "3",
        "stroke-linecap": "round",
        opacity: "0.8"
      });
      this.nodes.layerArm.appendChild(this.nodes.baseRing);
      this.nodes.layerArm.appendChild(this.nodes.baseDirection);

      // Shadow lines (behind main links)
      this.nodes.linkShoulderShadow = this._svgEl("line", {
        stroke: "#d48e08",
        "stroke-width": "17",
        "stroke-linecap": "round",
        opacity: "0.3"
      });
      this.nodes.linkElbowShadow = this._svgEl("line", {
        stroke: "#6b2f85",
        "stroke-width": "14",
        "stroke-linecap": "round",
        opacity: "0.3"
      });
      this.nodes.linkWristShadow = this._svgEl("line", {
        stroke: "#0b7ec4",
        "stroke-width": "11",
        "stroke-linecap": "round",
        opacity: "0.3"
      });
      this.nodes.layerArm.appendChild(this.nodes.linkShoulderShadow);
      this.nodes.layerArm.appendChild(this.nodes.linkElbowShadow);
      this.nodes.layerArm.appendChild(this.nodes.linkWristShadow);

      // Main links
      this.nodes.linkShoulder = this._svgEl("line", {
        stroke: this.colors[1],
        "stroke-width": "15",
        "stroke-linecap": "round"
      });
      this.nodes.linkElbow = this._svgEl("line", {
        stroke: this.colors[2],
        "stroke-width": "12",
        "stroke-linecap": "round"
      });
      this.nodes.linkWrist = this._svgEl("line", {
        stroke: this.colors[4],
        "stroke-width": "9",
        "stroke-linecap": "round"
      });
      this.nodes.layerArm.appendChild(this.nodes.linkShoulder);
      this.nodes.layerArm.appendChild(this.nodes.linkElbow);
      this.nodes.layerArm.appendChild(this.nodes.linkWrist);

      // Highlight lines (on top of main links)
      this.nodes.linkShoulderHighlight = this._svgEl("line", {
        stroke: "rgba(255,255,255,0.35)",
        "stroke-width": "4",
        "stroke-linecap": "round"
      });
      this.nodes.linkElbowHighlight = this._svgEl("line", {
        stroke: "rgba(255,255,255,0.30)",
        "stroke-width": "3",
        "stroke-linecap": "round"
      });
      this.nodes.linkWristHighlight = this._svgEl("line", {
        stroke: "rgba(255,255,255,0.25)",
        "stroke-width": "2",
        "stroke-linecap": "round"
      });
      this.nodes.layerArm.appendChild(this.nodes.linkShoulderHighlight);
      this.nodes.layerArm.appendChild(this.nodes.linkElbowHighlight);
      this.nodes.layerArm.appendChild(this.nodes.linkWristHighlight);

      // Gripper body
      this.nodes.gripperBody = this._svgEl("rect", {
        fill: this.colors[5],
        rx: "3",
        ry: "3",
        opacity: "0.85"
      });
      this.nodes.layerArm.appendChild(this.nodes.gripperBody);

      // Claws
      this.nodes.clawA = this._svgEl("line", {
        stroke: this.colors[5],
        "stroke-width": "6",
        "stroke-linecap": "round"
      });
      this.nodes.clawB = this._svgEl("line", {
        stroke: this.colors[5],
        "stroke-width": "6",
        "stroke-linecap": "round"
      });
      this.nodes.layerArm.appendChild(this.nodes.clawA);
      this.nodes.layerArm.appendChild(this.nodes.clawB);

      // Claw tips
      this.nodes.clawTipA = this._svgEl("circle", {
        r: "3",
        fill: this.colors[5],
        stroke: "#ffffff",
        "stroke-width": "1"
      });
      this.nodes.clawTipB = this._svgEl("circle", {
        r: "3",
        fill: this.colors[5],
        stroke: "#ffffff",
        "stroke-width": "1"
      });
      this.nodes.layerArm.appendChild(this.nodes.clawTipA);
      this.nodes.layerArm.appendChild(this.nodes.clawTipB);

      // Wrist rotation ring and marker
      this.nodes.wristRotRing = this._svgEl("circle", {
        fill: "none",
        stroke: this.colors[3],
        "stroke-width": "2",
        opacity: "0.8"
      });
      this.nodes.wristRotMarker = this._svgEl("line", {
        stroke: this.colors[3],
        "stroke-width": "3",
        "stroke-linecap": "round"
      });
      this.nodes.layerArm.appendChild(this.nodes.wristRotRing);
      this.nodes.layerArm.appendChild(this.nodes.wristRotMarker);

      // Joints (colored circles with white stroke)
      this.nodes.baseJoint = this._svgEl("circle", {
        r: "9",
        fill: this.colors[0],
        stroke: "#ffffff",
        "stroke-width": "2.5"
      });
      this.nodes.shoulderJoint = this._svgEl("circle", {
        r: "9",
        fill: this.colors[1],
        stroke: "#ffffff",
        "stroke-width": "2.5"
      });
      this.nodes.elbowJoint = this._svgEl("circle", {
        r: "8",
        fill: this.colors[2],
        stroke: "#ffffff",
        "stroke-width": "2.5"
      });
      this.nodes.wristJoint = this._svgEl("circle", {
        r: "7",
        fill: this.colors[4],
        stroke: "#ffffff",
        "stroke-width": "2.5"
      });
      this.nodes.layerArm.appendChild(this.nodes.baseJoint);
      this.nodes.layerArm.appendChild(this.nodes.shoulderJoint);
      this.nodes.layerArm.appendChild(this.nodes.elbowJoint);
      this.nodes.layerArm.appendChild(this.nodes.wristJoint);

      // Joint center dots (white bullseye)
      this.nodes.baseJointDot = this._svgEl("circle", { r: "3", fill: "#ffffff", "pointer-events": "none" });
      this.nodes.shoulderJointDot = this._svgEl("circle", { r: "3", fill: "#ffffff", "pointer-events": "none" });
      this.nodes.elbowJointDot = this._svgEl("circle", { r: "2.5", fill: "#ffffff", "pointer-events": "none" });
      this.nodes.wristJointDot = this._svgEl("circle", { r: "2", fill: "#ffffff", "pointer-events": "none" });
      this.nodes.layerArm.appendChild(this.nodes.baseJointDot);
      this.nodes.layerArm.appendChild(this.nodes.shoulderJointDot);
      this.nodes.layerArm.appendChild(this.nodes.elbowJointDot);
      this.nodes.layerArm.appendChild(this.nodes.wristJointDot);

      // Interactive handles (visible dashed rings)
      this.nodes.shoulderHandle = this._makeHandle(14, "shoulder");
      this.nodes.elbowHandle = this._makeHandle(13, "elbow");
      this.nodes.wristHandle = this._makeHandle(12, "wrist_tilt");
      this.nodes.endEffectorHandle = this._makeHandle(14, "end_effector");

      // Pulse animation on end-effector
      this.nodes.endEffectorHandle.appendChild(this._svgEl("animate", {
        attributeName: "r",
        values: "18;21;18",
        dur: "2s",
        repeatCount: "indefinite"
      }));
      this.nodes.endEffectorHandle.appendChild(this._svgEl("animate", {
        attributeName: "stroke-opacity",
        values: "0.6;1;0.6",
        dur: "2s",
        repeatCount: "indefinite"
      }));

      this.nodes.layerArm.appendChild(this.nodes.shoulderHandle);
      this.nodes.layerArm.appendChild(this.nodes.elbowHandle);
      this.nodes.layerArm.appendChild(this.nodes.wristHandle);
      this.nodes.layerArm.appendChild(this.nodes.endEffectorHandle);

      // ---- Layer: Overlay (controls + help) ----

      // Direct Controls header
      this.nodes.controlsHeader = this._svgEl("text", {
        fill: "#94a3b8",
        "font-size": "10",
        "font-family": "DM Sans, sans-serif",
        "font-weight": "700"
      }, "Direct Controls");

      // Base track
      this.nodes.baseTrackLabel = this._svgEl("text", {
        fill: "#334155",
        "font-size": "11",
        "font-family": "DM Sans, sans-serif",
        "font-weight": "700"
      }, "Base");
      this.nodes.baseTrack = this._svgEl("line", {
        class: "arm-track",
        stroke: "#b8c2d8",
        "stroke-width": "6",
        "stroke-linecap": "round"
      });
      this.nodes.baseTrackHandle = this._svgEl("circle", {
        class: "arm-handle arm-track-handle",
        r: "8",
        fill: this.colors[0],
        stroke: "#ffffff",
        "stroke-width": "2"
      });
      this._bindDragTarget(this.nodes.baseTrack, "base");
      this._bindDragTarget(this.nodes.baseTrackHandle, "base");

      // Wrist Rot track
      this.nodes.wristRotTrackLabel = this._svgEl("text", {
        fill: "#334155",
        "font-size": "11",
        "font-family": "DM Sans, sans-serif",
        "font-weight": "700"
      }, "Wrist Rot");
      this.nodes.wristRotTrack = this._svgEl("line", {
        class: "arm-track",
        stroke: "#b8c2d8",
        "stroke-width": "6",
        "stroke-linecap": "round"
      });
      this.nodes.wristRotTrackHandle = this._svgEl("circle", {
        class: "arm-handle arm-track-handle",
        r: "8",
        fill: this.colors[3],
        stroke: "#ffffff",
        "stroke-width": "2"
      });
      this._bindDragTarget(this.nodes.wristRotTrack, "wrist_rotate");
      this._bindDragTarget(this.nodes.wristRotTrackHandle, "wrist_rotate");

      // Help text
      this.nodes.helpText = this._svgEl("text", {
        fill: "#94a3b8",
        "font-size": "10",
        "font-family": "DM Sans, sans-serif",
        "text-anchor": "middle",
        "font-style": "italic",
        opacity: "0.8"
      }, "Drag joints to move the arm");

      // Drag tooltip
      this.nodes.dragTooltipBg = this._svgEl("rect", {
        fill: "rgba(255,255,255,0.92)",
        stroke: "#d8dfeb",
        "stroke-width": "1",
        rx: "4",
        ry: "4",
        visibility: "hidden",
        "pointer-events": "none"
      });
      this.nodes.dragTooltip = this._svgEl("text", {
        fill: "#1e293b",
        "font-size": "11",
        "font-family": "DM Sans, sans-serif",
        "font-weight": "700",
        "text-anchor": "middle",
        visibility: "hidden",
        "pointer-events": "none"
      });

      // Append overlay elements
      this.nodes.layerOverlay.appendChild(this.nodes.controlsHeader);
      this.nodes.layerOverlay.appendChild(this.nodes.baseTrackLabel);
      this.nodes.layerOverlay.appendChild(this.nodes.baseTrack);
      this.nodes.layerOverlay.appendChild(this.nodes.baseTrackHandle);
      this.nodes.layerOverlay.appendChild(this.nodes.wristRotTrackLabel);
      this.nodes.layerOverlay.appendChild(this.nodes.wristRotTrack);
      this.nodes.layerOverlay.appendChild(this.nodes.wristRotTrackHandle);
      this.nodes.layerOverlay.appendChild(this.nodes.helpText);
      this.nodes.layerOverlay.appendChild(this.nodes.dragTooltipBg);
      this.nodes.layerOverlay.appendChild(this.nodes.dragTooltip);

      // Append layers
      this.svg.appendChild(this.nodes.layerStatic);
      this.svg.appendChild(this.nodes.layerArm);
      this.svg.appendChild(this.nodes.layerOverlay);

      // Auto-fade help text
      setTimeout(() => {
        if (this.nodes.helpText) {
          this.nodes.helpText.style.transition = "opacity 1.5s ease";
          this.nodes.helpText.style.opacity = "0";
        }
      }, 5000);
    }

    _makeHandle(radius, mode) {
      const colorMap = {
        shoulder: this.colors[1],
        elbow: this.colors[2],
        wrist_tilt: this.colors[4],
        end_effector: this.colors[5]
      };
      const color = colorMap[mode] || this.colors[0];

      const handle = this._svgEl("circle", {
        class: "arm-handle arm-joint-handle",
        r: String(radius + 4),
        fill: "rgba(255, 255, 255, 0.15)",
        stroke: color,
        "stroke-width": "2",
        "stroke-opacity": "0.6",
        "stroke-dasharray": mode === "end_effector" ? "none" : "3 3"
      });
      this._bindDragTarget(handle, mode);
      return handle;
    }

    _bindDragTarget(node, mode) {
      node.addEventListener("pointerdown", (event) => this._onPointerDown(event, mode));
    }

    _onPointerDown(event, mode) {
      if (!this.interactive) {
        return;
      }

      event.preventDefault();

      this.dragState = {
        mode,
        pointerId: event.pointerId
      };

      this.svg.setPointerCapture(event.pointerId);
      this.svg.addEventListener("pointermove", this._boundPointerMove);
      this.svg.addEventListener("pointerup", this._boundPointerUp);
      this.svg.addEventListener("pointercancel", this._boundPointerUp);

      this._notifyDragState(true);
      this._updateDragStyles();
      this._applyPointer(event);
    }

    _onPointerMove(event) {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
        return;
      }

      this._applyPointer(event);
    }

    _onPointerUp(event) {
      if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
        return;
      }

      this._cancelDrag();
    }

    _cancelDrag() {
      if (!this.dragState) {
        return;
      }

      const pointerId = this.dragState.pointerId;
      this.dragState = null;

      try {
        this.svg.releasePointerCapture(pointerId);
      } catch (error) {
        // Ignore capture release errors.
      }

      this.svg.removeEventListener("pointermove", this._boundPointerMove);
      this.svg.removeEventListener("pointerup", this._boundPointerUp);
      this.svg.removeEventListener("pointercancel", this._boundPointerUp);

      this._notifyDragState(false);
      this._updateDragStyles();
    }

    _applyPointer(event) {
      if (!this.dragState) {
        return;
      }

      const pointer = this._toSvgPoint(event);
      if (!pointer) {
        return;
      }

      const geometry = this._computeGeometry(this._getViewBoxWidth(), this._getViewBoxHeight(), this.angles);
      const next = this.angles.slice();
      const changedIndices = [];

      switch (this.dragState.mode) {
        case "shoulder": {
          next[1] = this._solveShoulderAngle(geometry.base, pointer);
          changedIndices.push(1);
          break;
        }
        case "elbow": {
          next[2] = this._solveElbowAngle(geometry.p1, pointer, geometry.shoulderTheta);
          changedIndices.push(2);
          break;
        }
        case "wrist_tilt": {
          next[4] = this._solveWristTiltAngle(geometry.p2, pointer, geometry.elbowTheta);
          changedIndices.push(4);
          break;
        }
        case "end_effector": {
          const solved = this._solveEndEffector(pointer, geometry);
          next[1] = solved.shoulderAngle;
          next[2] = solved.elbowAngle;
          next[4] = solved.wristTiltAngle;
          changedIndices.push(1, 2, 4);
          break;
        }
        case "base": {
          next[0] = this._solveTrackAngle(pointer.x, this.nodes.baseTrack);
          changedIndices.push(0);
          break;
        }
        case "wrist_rotate": {
          next[3] = this._solveTrackAngle(pointer.x, this.nodes.wristRotTrack);
          changedIndices.push(3);
          break;
        }
        default:
          return;
      }

      this._applyAngles(next, {
        emit: true,
        changedIndices
      });
    }

    _applyAngles(nextAngles, options = {}) {
      const sanitized = this._sanitizeAngles(nextAngles);
      const changed = [];

      for (let index = 0; index < sanitized.length; index += 1) {
        if (sanitized[index] !== this.angles[index]) {
          changed.push(index);
        }
      }

      if (changed.length === 0) {
        return;
      }

      this.angles = sanitized;
      this.render();

      if (options.emit && typeof this.options.onAnglesChange === "function") {
        const explicit = Array.isArray(options.changedIndices) ? options.changedIndices : changed;
        this.options.onAnglesChange(this.angles.slice(), {
          changedIndices: explicit
        });
      }
    }

    _computeGeometry(width, height, angles) {
      const base = { x: width * 0.42, y: height * 0.82 };
      const lengths = {
        shoulder: height * 0.22,
        elbow: height * 0.20,
        wrist: height * 0.15
      };

      const shoulderTheta = degToRad(180 - angles[1]);
      // Elbow servo is reversed in firmware; preview uses the mirrored delta so
      // visual bend direction matches physical forward/backward motion.
      const elbowTheta = shoulderTheta + degToRad(90 - angles[2]);
      const wristTheta = elbowTheta + degToRad(angles[4] - 90);

      const baseYawNorm = clamp((angles[0] - 90) / 90, -1, 1);
      const yawScaleX = 1 - Math.abs(baseYawNorm) * 0.35;
      const yawShiftX = baseYawNorm * width * 0.18;
      const yawDropY = Math.abs(baseYawNorm) * height * 0.03;

      const project = (localPoint, depth) => ({
        x: base.x + localPoint.x * yawScaleX + yawShiftX * depth,
        y: base.y + localPoint.y + yawDropY * depth
      });

      const shoulderLocal = {
        x: lengths.shoulder * Math.cos(shoulderTheta),
        y: -lengths.shoulder * Math.sin(shoulderTheta)
      };
      const elbowLocal = {
        x: shoulderLocal.x + lengths.elbow * Math.cos(elbowTheta),
        y: shoulderLocal.y - lengths.elbow * Math.sin(elbowTheta)
      };
      const wristLocal = {
        x: elbowLocal.x + lengths.wrist * Math.cos(wristTheta),
        y: elbowLocal.y - lengths.wrist * Math.sin(wristTheta)
      };

      const p1 = project(shoulderLocal, 0.45);
      const p2 = project(elbowLocal, 0.75);
      const p3 = project(wristLocal, 1.0);

      const gripperMin = (this.jointLimits[5] && Number.isFinite(this.jointLimits[5][0])) ? this.jointLimits[5][0] : 25;
      const gripperMax = (this.jointLimits[5] && Number.isFinite(this.jointLimits[5][1])) ? this.jointLimits[5][1] : 130;
      // Lower gripper angles are treated as "open" by block presets, so preview spread is inverted.
      const gripperSpread = map(angles[5], gripperMin, gripperMax, 16, 4);
      const clawLength = 22;
      const clawThetaA = wristTheta + degToRad(90);
      const clawThetaB = wristTheta - degToRad(90);

      const clawALocal = {
        x: wristLocal.x + gripperSpread * Math.cos(clawThetaA) + clawLength * Math.cos(wristTheta),
        y: wristLocal.y - gripperSpread * Math.sin(clawThetaA) - clawLength * Math.sin(wristTheta)
      };
      const clawBLocal = {
        x: wristLocal.x + gripperSpread * Math.cos(clawThetaB) + clawLength * Math.cos(wristTheta),
        y: wristLocal.y - gripperSpread * Math.sin(clawThetaB) - clawLength * Math.sin(wristTheta)
      };
      const clawA = project(clawALocal, 1.08);
      const clawB = project(clawBLocal, 1.08);
      const tip = {
        x: (clawA.x + clawB.x) / 2,
        y: (clawA.y + clawB.y) / 2
      };

      const baseTheta = degToRad(map(angles[0], 0, 180, 210, -30));
      const baseDirection = {
        x: base.x + 28 * Math.cos(baseTheta),
        y: base.y - 28 * Math.sin(baseTheta)
      };

      const wristRotTheta = degToRad(map(angles[3], 0, 180, 210, -30));
      const wristRotMarker = {
        x: p3.x + 14 * Math.cos(wristRotTheta),
        y: p3.y - 14 * Math.sin(wristRotTheta)
      };

      return {
        base,
        p1,
        p2,
        p3,
        tip,
        clawA,
        clawB,
        baseDirection,
        wristRotMarker,
        lengths,
        shoulderTheta,
        elbowTheta,
        wristTheta
      };
    }

    _updateTrackLayout(width, height) {
      const baseY = height - 16;

      // Header
      this._setAttributes(this.nodes.controlsHeader, {
        x: 8,
        y: height - 28
      });

      // Base track (left half)
      const baseTrackLeft = width * 0.10;
      const baseTrackRight = width * 0.42;
      this._setAttributes(this.nodes.baseTrack, {
        x1: baseTrackLeft,
        y1: baseY,
        x2: baseTrackRight,
        y2: baseY
      });
      this._setAttributes(this.nodes.baseTrackLabel, {
        x: baseTrackLeft,
        y: baseY - 10
      });

      // Wrist Rot track (right half)
      const wristTrackLeft = width * 0.55;
      const wristTrackRight = width * 0.87;
      this._setAttributes(this.nodes.wristRotTrack, {
        x1: wristTrackLeft,
        y1: baseY,
        x2: wristTrackRight,
        y2: baseY
      });
      this._setAttributes(this.nodes.wristRotTrackLabel, {
        x: wristTrackLeft,
        y: baseY - 10
      });

      // Help text (centered above tracks)
      this._setAttributes(this.nodes.helpText, {
        x: width * 0.42,
        y: height - 46
      });
    }

    _updateTrackKnobs(width, height) {
      const baseY = height - 16;

      const baseTrackLeft = width * 0.10;
      const baseTrackRight = width * 0.42;
      const baseX = map(this.angles[0], 0, 180, baseTrackLeft, baseTrackRight);
      this._setAttributes(this.nodes.baseTrackHandle, {
        cx: baseX,
        cy: baseY
      });

      const wristTrackLeft = width * 0.55;
      const wristTrackRight = width * 0.87;
      const wristRotX = map(this.angles[3], 0, 180, wristTrackLeft, wristTrackRight);
      this._setAttributes(this.nodes.wristRotTrackHandle, {
        cx: wristRotX,
        cy: baseY
      });
    }

    _updateDragStyles() {
      const mode = this.dragState ? this.dragState.mode : "";
      const isActive = (value) => mode === value;

      this.nodes.shoulderHandle.classList.toggle("is-active", isActive("shoulder"));
      this.nodes.elbowHandle.classList.toggle("is-active", isActive("elbow"));
      this.nodes.wristHandle.classList.toggle("is-active", isActive("wrist_tilt"));
      this.nodes.endEffectorHandle.classList.toggle("is-active", isActive("end_effector"));
      this.nodes.baseTrackHandle.classList.toggle("is-active", isActive("base"));
      this.nodes.wristRotTrackHandle.classList.toggle("is-active", isActive("wrist_rotate"));
      this.svg.classList.toggle("is-dragging", Boolean(this.dragState));

      // Drag tooltip
      if (this.dragState) {
        const geometry = this._computeGeometry(this._getViewBoxWidth(), this._getViewBoxHeight(), this.angles);
        const modeToIndex = {
          base: 0, shoulder: 1, elbow: 2, wrist_rotate: 3, wrist_tilt: 4, end_effector: null
        };
        const modeToPoint = {
          base: geometry.base,
          shoulder: geometry.p1,
          elbow: geometry.p2,
          wrist_rotate: geometry.p3,
          wrist_tilt: geometry.p3,
          end_effector: geometry.tip
        };

        const idx = modeToIndex[this.dragState.mode];
        const point = modeToPoint[this.dragState.mode];

        if (point) {
          let labelText;
          if (idx !== null && idx !== undefined) {
            labelText = `${this.labels[idx]}: ${this.angles[idx]}\u00B0`;
          } else {
            labelText = `S:${this.angles[1]}\u00B0 E:${this.angles[2]}\u00B0 W:${this.angles[4]}\u00B0`;
          }

          const tooltipX = point.x;
          const tooltipY = point.y - 24;

          this.nodes.dragTooltip.textContent = labelText;
          this._setAttributes(this.nodes.dragTooltip, { x: tooltipX, y: tooltipY, visibility: "visible" });

          const textLen = labelText.length * 6.5;
          this._setAttributes(this.nodes.dragTooltipBg, {
            x: tooltipX - textLen / 2 - 4,
            y: tooltipY - 12,
            width: textLen + 8,
            height: 16,
            visibility: "visible"
          });
        }
      } else {
        this._setAttributes(this.nodes.dragTooltip, { visibility: "hidden" });
        this._setAttributes(this.nodes.dragTooltipBg, { visibility: "hidden" });
      }
    }

    _notifyDragState(isDragging) {
      if (typeof this.options.onDragStateChange === "function") {
        this.options.onDragStateChange(Boolean(isDragging));
      }
    }

    _solveShoulderAngle(base, target) {
      const theta = Math.atan2(base.y - target.y, target.x - base.x);
      return this._clampAngle(1, 180 - radToDeg(theta));
    }

    _solveElbowAngle(p1, target, shoulderTheta) {
      const theta = Math.atan2(p1.y - target.y, target.x - p1.x);
      return this._clampAngle(2, 90 - radToDeg(theta - shoulderTheta));
    }

    _solveWristTiltAngle(p2, target, elbowTheta) {
      const theta = Math.atan2(p2.y - target.y, target.x - p2.x);
      return this._clampAngle(4, radToDeg(theta - elbowTheta) + 90);
    }

    _solveEndEffector(target, geometry) {
      const base = geometry.base;
      const l1 = geometry.lengths.shoulder;
      const l2 = geometry.lengths.elbow;
      const wristLen = geometry.lengths.wrist;

      const wristX = wristLen * Math.cos(geometry.wristTheta);
      const wristY = wristLen * Math.sin(geometry.wristTheta);
      const wristBase = {
        x: target.x - wristX,
        y: target.y + wristY
      };

      const dx = wristBase.x - base.x;
      const dy = base.y - wristBase.y;
      const distanceRaw = Math.hypot(dx, dy);
      const minReach = Math.abs(l1 - l2) + 0.001;
      const maxReach = l1 + l2 - 0.001;
      const distance = clamp(distanceRaw, minReach, maxReach);

      const theta = Math.atan2(dy, dx);
      const cosDeltaRaw = (distance * distance - l1 * l1 - l2 * l2) / (2 * l1 * l2);
      const cosDelta = clamp(cosDeltaRaw, -1, 1);

      const deltaA = Math.atan2(Math.sqrt(Math.max(0, 1 - cosDelta * cosDelta)), cosDelta);
      const deltaB = Math.atan2(-Math.sqrt(Math.max(0, 1 - cosDelta * cosDelta)), cosDelta);
      const currentDelta = geometry.elbowTheta - geometry.shoulderTheta;
      const delta = Math.abs(deltaA - currentDelta) < Math.abs(deltaB - currentDelta) ? deltaA : deltaB;

      const phi = Math.atan2(l2 * Math.sin(delta), l1 + l2 * Math.cos(delta));
      const shoulderTheta = theta - phi;
      const elbowTheta = shoulderTheta + delta;
      const shoulderAngle = this._clampAngle(1, 180 - radToDeg(shoulderTheta));
      const elbowAngle = this._clampAngle(2, 90 - radToDeg(delta));
      const wristTiltAngle = this._clampAngle(4, radToDeg(geometry.wristTheta - elbowTheta) + 90);

      return {
        shoulderAngle,
        elbowAngle,
        wristTiltAngle
      };
    }

    _solveTrackAngle(pointerX, trackNode) {
      const x1 = Number.parseFloat(trackNode.getAttribute("x1"));
      const x2 = Number.parseFloat(trackNode.getAttribute("x2"));
      const clampedX = clamp(pointerX, Math.min(x1, x2), Math.max(x1, x2));
      return Math.round(map(clampedX, x1, x2, 0, 180));
    }

    _sanitizeAngles(values) {
      const next = values.slice(0, 6);
      while (next.length < 6) {
        next.push(0);
      }
      return next.map((value, index) => this._clampAngle(index, value));
    }

    _clampAngle(index, value) {
      const bounds = this.jointLimits[index] || [0, 180];
      return Math.round(clamp(Number(value), bounds[0], bounds[1]));
    }

    _toSvgPoint(event) {
      if (!this.svg.createSVGPoint) {
        return null;
      }
      const point = this.svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const ctm = this.svg.getScreenCTM();
      if (!ctm) {
        return null;
      }
      return point.matrixTransform(ctm.inverse());
    }

    _setLine(node, from, to) {
      this._setAttributes(node, {
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y
      });
    }

    _setPoint(node, point) {
      this._setAttributes(node, {
        cx: point.x,
        cy: point.y
      });
    }

    _setAttributes(node, attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, String(value));
      }
    }

    _svgEl(tag, attrs, text) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      if (attrs) {
        this._setAttributes(node, attrs);
      }
      if (typeof text === "string") {
        node.textContent = text;
      }
      return node;
    }

    _getViewBoxWidth() {
      const viewBox = this.svg.viewBox && this.svg.viewBox.baseVal;
      return viewBox && viewBox.width > 0 ? viewBox.width : 310;
    }

    _getViewBoxHeight() {
      const viewBox = this.svg.viewBox && this.svg.viewBox.baseVal;
      return viewBox && viewBox.height > 0 ? viewBox.height : 460;
    }
  }

  class ArmPreviewSketch3D {
    constructor(svgElement, options = {}) {
      this.svg = svgElement;
      this.options = options;
      this.colors = ["#5271ff", "#f59e0b", "#8e44ad", "#16a34a", "#0ea5e9", "#ef4444"];
      this.jointLimits = Array.isArray(options.jointLimits) ? options.jointLimits : DEFAULT_LIMITS;
      this.angles = this._sanitizeAngles(options.initialAngles || [90, 90, 90, 90, 90, 90]);
      this.uid = `armSketch3d${Math.random().toString(36).slice(2)}`;
      this.interactive = false;
      this.nodes = {};

      this._buildScene();
      this.render();
    }

    setAngles(nextAngles) {
      if (!Array.isArray(nextAngles) || nextAngles.length < 6) {
        return;
      }
      this.angles = this._sanitizeAngles(nextAngles);
      this.render();
    }

    setAngle(index, value) {
      if (!Number.isInteger(index) || index < 0 || index > 5) {
        return;
      }
      const next = this.angles.slice();
      next[index] = value;
      this.angles = this._sanitizeAngles(next);
      this.render();
    }

    getAngles() {
      return this.angles.slice();
    }

    setInteractive(enabled) {
      this.interactive = Boolean(enabled);
      this.svg.classList.toggle("is-interactive-disabled", !this.interactive);
    }

    render() {
      const width = this._getViewBoxWidth();
      const height = this._getViewBoxHeight();
      const geometry = this._computeGeometry(width, height, this.angles);
      const depth = geometry.depth;

      this._setAttributes(this.nodes.floorShadow, {
        cx: geometry.base.x + depth.x * 0.8,
        cy: height * 0.88,
        rx: width * 0.26,
        ry: 18
      });

      this._setAttributes(this.nodes.baseBody, {
        x: geometry.base.x - 44 + depth.x * 0.25,
        y: geometry.base.y + 10,
        width: 88,
        height: 42,
        rx: 13
      });
      this._setAttributes(this.nodes.baseBottom, {
        cx: geometry.base.x + depth.x * 0.25,
        cy: geometry.base.y + 51,
        rx: 44,
        ry: 12
      });
      this._setAttributes(this.nodes.baseTop, {
        cx: geometry.base.x,
        cy: geometry.base.y + 11,
        rx: 46,
        ry: 13
      });
      this._setAttributes(this.nodes.turntable, {
        cx: geometry.base.x,
        cy: geometry.base.y,
        rx: 34,
        ry: 11
      });
      this._setAttributes(this.nodes.turntableRim, {
        cx: geometry.base.x,
        cy: geometry.base.y,
        rx: 38,
        ry: 14
      });

      this._updateLink(this.nodes.linkShoulder, geometry.base, geometry.p1, 20, depth, this.colors[1]);
      this._updateLink(this.nodes.linkElbow, geometry.p1, geometry.p2, 17, depth, this.colors[2]);
      this._updateLink(this.nodes.linkWrist, geometry.p2, geometry.p3, 13, depth, this.colors[4]);

      this._updateGripper(geometry, depth);

      this._updateJointHub(this.nodes.baseHub, geometry.base, 14, this.colors[0], depth);
      this._updateJointHub(this.nodes.shoulderHub, geometry.p1, 13, this.colors[1], depth);
      this._updateJointHub(this.nodes.elbowHub, geometry.p2, 12, this.colors[2], depth);
      this._updateJointHub(this.nodes.wristHub, geometry.p3, 10, this.colors[4], depth);

      this._setAttributes(this.nodes.baseYawArc, {
        cx: geometry.base.x,
        cy: geometry.base.y + 2,
        rx: 55,
        ry: 18
      });
      this._setLine(this.nodes.baseYawMarker, geometry.base, geometry.baseDirection);
      this._setAttributes(this.nodes.wristRotRing, {
        cx: geometry.p3.x,
        cy: geometry.p3.y,
        rx: 19,
        ry: 7,
        transform: `rotate(${-radToDeg(geometry.wristTheta)}, ${geometry.p3.x}, ${geometry.p3.y})`
      });
      this._setLine(this.nodes.wristRotMarker, geometry.p3, geometry.wristRotMarker);
    }

    _buildScene() {
      const width = this._getViewBoxWidth();
      const height = this._getViewBoxHeight();

      while (this.svg.firstChild) {
        this.svg.removeChild(this.svg.firstChild);
      }

      this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      this.svg.style.touchAction = "none";

      const defs = this._svgEl("defs");

      const softShadow = this._svgEl("filter", { id: this._id("softShadow"), x: "-30%", y: "-30%", width: "160%", height: "170%" });
      softShadow.appendChild(this._svgEl("feDropShadow", { dx: "4", dy: "7", stdDeviation: "5", "flood-color": "#102033", "flood-opacity": "0.18" }));
      defs.appendChild(softShadow);

      const baseGrad = this._svgEl("linearGradient", { id: this._id("baseGrad"), x1: "0", y1: "0", x2: "0", y2: "1" });
      baseGrad.appendChild(this._svgEl("stop", { offset: "0%", "stop-color": "#eef5ff" }));
      baseGrad.appendChild(this._svgEl("stop", { offset: "42%", "stop-color": "#aab9d2" }));
      baseGrad.appendChild(this._svgEl("stop", { offset: "100%", "stop-color": "#7586a3" }));
      defs.appendChild(baseGrad);

      const baseTopGrad = this._svgEl("linearGradient", { id: this._id("baseTopGrad"), x1: "0", y1: "0", x2: "1", y2: "1" });
      baseTopGrad.appendChild(this._svgEl("stop", { offset: "0%", "stop-color": "#ffffff" }));
      baseTopGrad.appendChild(this._svgEl("stop", { offset: "100%", "stop-color": "#c5d1e6" }));
      defs.appendChild(baseTopGrad);

      this.svg.appendChild(defs);

      this.nodes.layerGround = this._svgEl("g", { class: "arm-sketch-layer-ground" });
      this.nodes.layerLinks = this._svgEl("g", { class: "arm-sketch-layer-links", filter: this._url("softShadow") });
      this.nodes.layerJoints = this._svgEl("g", { class: "arm-sketch-layer-joints" });
      this.nodes.layerOverlay = this._svgEl("g", { class: "arm-sketch-layer-overlay" });

      this.nodes.floorShadow = this._svgEl("ellipse", { fill: "#172033", opacity: "0.10" });
      this.nodes.baseBody = this._svgEl("rect", { fill: this._url("baseGrad") });
      this.nodes.baseBottom = this._svgEl("ellipse", { fill: "#71839f", opacity: "0.86" });
      this.nodes.baseTop = this._svgEl("ellipse", { fill: this._url("baseTopGrad"), stroke: "#e9f1ff", "stroke-width": "2" });
      this.nodes.turntableRim = this._svgEl("ellipse", { fill: "none", stroke: "#7f8fa8", "stroke-width": "3", opacity: "0.65" });
      this.nodes.turntable = this._svgEl("ellipse", { fill: "#f8fbff", stroke: "#aebbd2", "stroke-width": "1.5" });

      this.nodes.layerGround.appendChild(this.nodes.floorShadow);
      this.nodes.layerGround.appendChild(this.nodes.baseBottom);
      this.nodes.layerGround.appendChild(this.nodes.baseBody);
      this.nodes.layerGround.appendChild(this.nodes.baseTop);
      this.nodes.layerGround.appendChild(this.nodes.turntableRim);
      this.nodes.layerGround.appendChild(this.nodes.turntable);

      this.nodes.linkShoulder = this._makeLink();
      this.nodes.linkElbow = this._makeLink();
      this.nodes.linkWrist = this._makeLink();

      this.nodes.gripperShadowA = this._svgEl("line", { stroke: "#8f1220", "stroke-width": "8", "stroke-linecap": "round", opacity: "0.28" });
      this.nodes.gripperShadowB = this._svgEl("line", { stroke: "#8f1220", "stroke-width": "8", "stroke-linecap": "round", opacity: "0.28" });
      this.nodes.gripperBodyShadow = this._svgEl("rect", { fill: "#8f1220", opacity: "0.22", rx: "4", ry: "4" });
      this.nodes.gripperBody = this._svgEl("rect", { fill: "#ef4444", stroke: "#fff1f2", "stroke-width": "1.5", rx: "4", ry: "4" });
      this.nodes.gripperClawA = this._svgEl("line", { stroke: "#ef4444", "stroke-width": "6", "stroke-linecap": "round" });
      this.nodes.gripperClawB = this._svgEl("line", { stroke: "#ef4444", "stroke-width": "6", "stroke-linecap": "round" });
      this.nodes.gripperTipA = this._svgEl("circle", { r: "3.5", fill: "#ffffff", stroke: "#ef4444", "stroke-width": "2" });
      this.nodes.gripperTipB = this._svgEl("circle", { r: "3.5", fill: "#ffffff", stroke: "#ef4444", "stroke-width": "2" });
      this.nodes.layerLinks.appendChild(this.nodes.gripperShadowA);
      this.nodes.layerLinks.appendChild(this.nodes.gripperShadowB);
      this.nodes.layerLinks.appendChild(this.nodes.gripperBodyShadow);
      this.nodes.layerLinks.appendChild(this.nodes.gripperBody);
      this.nodes.layerLinks.appendChild(this.nodes.gripperClawA);
      this.nodes.layerLinks.appendChild(this.nodes.gripperClawB);
      this.nodes.layerLinks.appendChild(this.nodes.gripperTipA);
      this.nodes.layerLinks.appendChild(this.nodes.gripperTipB);

      this.nodes.baseHub = this._makeJointHub();
      this.nodes.shoulderHub = this._makeJointHub();
      this.nodes.elbowHub = this._makeJointHub();
      this.nodes.wristHub = this._makeJointHub();

      this.nodes.baseYawArc = this._svgEl("ellipse", {
        fill: "none",
        stroke: this.colors[0],
        "stroke-width": "2",
        "stroke-dasharray": "5 4",
        opacity: "0.55"
      });
      this.nodes.baseYawMarker = this._svgEl("line", {
        stroke: this.colors[0],
        "stroke-width": "3",
        "stroke-linecap": "round",
        opacity: "0.75"
      });
      this.nodes.wristRotRing = this._svgEl("ellipse", {
        fill: "rgba(255,255,255,0.2)",
        stroke: this.colors[3],
        "stroke-width": "2",
        opacity: "0.85"
      });
      this.nodes.wristRotMarker = this._svgEl("line", {
        stroke: this.colors[3],
        "stroke-width": "3",
        "stroke-linecap": "round"
      });

      this.nodes.layerOverlay.appendChild(this.nodes.baseYawArc);
      this.nodes.layerOverlay.appendChild(this.nodes.baseYawMarker);
      this.nodes.layerOverlay.appendChild(this.nodes.wristRotRing);
      this.nodes.layerOverlay.appendChild(this.nodes.wristRotMarker);

      this.svg.appendChild(this.nodes.layerGround);
      this.svg.appendChild(this.nodes.layerLinks);
      this.svg.appendChild(this.nodes.layerJoints);
      this.svg.appendChild(this.nodes.layerOverlay);
    }

    _makeLink() {
      const link = {
        shadow: this._svgEl("line", { "stroke-linecap": "round", opacity: "0.16" }),
        side: this._svgEl("line", { "stroke-linecap": "round", opacity: "0.72" }),
        main: this._svgEl("line", { "stroke-linecap": "round" }),
        highlight: this._svgEl("line", { stroke: "rgba(255,255,255,0.55)", "stroke-linecap": "round", opacity: "0.9" })
      };
      this.nodes.layerLinks.appendChild(link.shadow);
      this.nodes.layerLinks.appendChild(link.side);
      this.nodes.layerLinks.appendChild(link.main);
      this.nodes.layerLinks.appendChild(link.highlight);
      return link;
    }

    _makeJointHub() {
      const hub = {
        group: this._svgEl("g"),
        shadow: this._svgEl("ellipse", { fill: "#172033", opacity: "0.16" }),
        side: this._svgEl("circle", { opacity: "0.78" }),
        main: this._svgEl("circle", { stroke: "#ffffff", "stroke-width": "2.5" }),
        ring: this._svgEl("circle", { fill: "none", stroke: "rgba(255,255,255,0.75)", "stroke-width": "2" }),
        bolts: []
      };
      hub.group.appendChild(hub.shadow);
      hub.group.appendChild(hub.side);
      hub.group.appendChild(hub.main);
      hub.group.appendChild(hub.ring);
      for (let index = 0; index < 4; index += 1) {
        const bolt = this._svgEl("circle", { r: "1.7", fill: "#ffffff", opacity: "0.9" });
        hub.bolts.push(bolt);
        hub.group.appendChild(bolt);
      }
      this.nodes.layerJoints.appendChild(hub.group);
      return hub;
    }

    _updateLink(link, from, to, width, depth, color) {
      const sideColor = shade(color, -36);
      const shadowFrom = this._offsetPoint(from, depth, 1.0);
      const shadowTo = this._offsetPoint(to, depth, 1.0);
      const sideFrom = this._offsetPoint(from, depth, 0.48);
      const sideTo = this._offsetPoint(to, depth, 0.48);
      const highlight = this._highlightLine(from, to, width);

      this._setAttributes(link.shadow, { stroke: "#172033", "stroke-width": width + 5 });
      this._setAttributes(link.side, { stroke: sideColor, "stroke-width": width });
      this._setAttributes(link.main, { stroke: color, "stroke-width": width });
      this._setAttributes(link.highlight, { "stroke-width": Math.max(2, width * 0.22) });
      this._setLine(link.shadow, shadowFrom, shadowTo);
      this._setLine(link.side, sideFrom, sideTo);
      this._setLine(link.main, from, to);
      this._setLine(link.highlight, highlight.from, highlight.to);
    }

    _updateJointHub(hub, point, radius, color, depth) {
      const sidePoint = this._offsetPoint(point, depth, 0.42);
      const shadowPoint = this._offsetPoint(point, depth, 0.78);
      this._setAttributes(hub.shadow, {
        cx: shadowPoint.x,
        cy: shadowPoint.y + radius * 0.4,
        rx: radius * 1.35,
        ry: radius * 0.58
      });
      this._setAttributes(hub.side, {
        cx: sidePoint.x,
        cy: sidePoint.y,
        r: radius,
        fill: shade(color, -34)
      });
      this._setAttributes(hub.main, {
        cx: point.x,
        cy: point.y,
        r: radius,
        fill: color
      });
      this._setAttributes(hub.ring, {
        cx: point.x,
        cy: point.y,
        r: radius * 0.58
      });

      const boltAngles = [45, 135, 225, 315];
      boltAngles.forEach((angle, index) => {
        const theta = degToRad(angle);
        this._setAttributes(hub.bolts[index], {
          cx: point.x + Math.cos(theta) * radius * 0.62,
          cy: point.y + Math.sin(theta) * radius * 0.44
        });
      });
    }

    _updateGripper(geometry, depth) {
      const shadowCenter = this._offsetPoint(geometry.p3, depth, 0.55);
      const shadowA = this._offsetPoint(geometry.clawA, depth, 0.55);
      const shadowB = this._offsetPoint(geometry.clawB, depth, 0.55);
      this._setLine(this.nodes.gripperShadowA, shadowCenter, shadowA);
      this._setLine(this.nodes.gripperShadowB, shadowCenter, shadowB);

      const bodyLength = 19;
      const bodyHeight = 11;
      const bodyX = geometry.p3.x - bodyLength / 2;
      const bodyY = geometry.p3.y - bodyHeight / 2;
      const angle = -radToDeg(geometry.wristTheta);
      this._setAttributes(this.nodes.gripperBodyShadow, {
        x: bodyX + depth.x * 0.35,
        y: bodyY + depth.y * 0.35,
        width: bodyLength,
        height: bodyHeight,
        transform: `rotate(${angle}, ${shadowCenter.x}, ${shadowCenter.y})`
      });
      this._setAttributes(this.nodes.gripperBody, {
        x: bodyX,
        y: bodyY,
        width: bodyLength,
        height: bodyHeight,
        transform: `rotate(${angle}, ${geometry.p3.x}, ${geometry.p3.y})`
      });
      this._setLine(this.nodes.gripperClawA, geometry.p3, geometry.clawA);
      this._setLine(this.nodes.gripperClawB, geometry.p3, geometry.clawB);
      this._setPoint(this.nodes.gripperTipA, geometry.clawA);
      this._setPoint(this.nodes.gripperTipB, geometry.clawB);
    }

    _computeGeometry(width, height, angles) {
      const base = { x: width * 0.48, y: height * 0.76 };
      const lengths = {
        shoulder: height * 0.23,
        elbow: height * 0.20,
        wrist: height * 0.14
      };

      const shoulderTheta = degToRad(180 - angles[1]);
      const elbowTheta = shoulderTheta + degToRad(90 - angles[2]);
      const wristTheta = elbowTheta + degToRad(angles[4] - 90);

      const baseYawNorm = clamp((angles[0] - 90) / 90, -1, 1);
      const yawScaleX = 1 - Math.abs(baseYawNorm) * 0.30;
      const yawShiftX = baseYawNorm * width * 0.17;
      const yawDropY = Math.abs(baseYawNorm) * height * 0.035;
      const depth = {
        x: 9 + baseYawNorm * 7,
        y: 12
      };

      const project = (localPoint, depthRatio) => ({
        x: base.x + localPoint.x * yawScaleX + yawShiftX * depthRatio,
        y: base.y + localPoint.y + yawDropY * depthRatio
      });

      const shoulderLocal = {
        x: lengths.shoulder * Math.cos(shoulderTheta),
        y: -lengths.shoulder * Math.sin(shoulderTheta)
      };
      const elbowLocal = {
        x: shoulderLocal.x + lengths.elbow * Math.cos(elbowTheta),
        y: shoulderLocal.y - lengths.elbow * Math.sin(elbowTheta)
      };
      const wristLocal = {
        x: elbowLocal.x + lengths.wrist * Math.cos(wristTheta),
        y: elbowLocal.y - lengths.wrist * Math.sin(wristTheta)
      };

      const p1 = project(shoulderLocal, 0.45);
      const p2 = project(elbowLocal, 0.75);
      const p3 = project(wristLocal, 1.0);

      const gripperMin = (this.jointLimits[5] && Number.isFinite(this.jointLimits[5][0])) ? this.jointLimits[5][0] : 25;
      const gripperMax = (this.jointLimits[5] && Number.isFinite(this.jointLimits[5][1])) ? this.jointLimits[5][1] : 130;
      const gripperSpread = map(angles[5], gripperMin, gripperMax, 17, 5);
      const clawLength = 25;
      const clawThetaA = wristTheta + degToRad(82);
      const clawThetaB = wristTheta - degToRad(82);
      const clawALocal = {
        x: wristLocal.x + gripperSpread * Math.cos(clawThetaA) + clawLength * Math.cos(wristTheta),
        y: wristLocal.y - gripperSpread * Math.sin(clawThetaA) - clawLength * Math.sin(wristTheta)
      };
      const clawBLocal = {
        x: wristLocal.x + gripperSpread * Math.cos(clawThetaB) + clawLength * Math.cos(wristTheta),
        y: wristLocal.y - gripperSpread * Math.sin(clawThetaB) - clawLength * Math.sin(wristTheta)
      };
      const clawA = project(clawALocal, 1.08);
      const clawB = project(clawBLocal, 1.08);

      const baseTheta = degToRad(map(angles[0], 0, 180, 210, -30));
      const baseDirection = {
        x: base.x + 32 * Math.cos(baseTheta),
        y: base.y - 12 + 12 * Math.sin(baseTheta)
      };

      const wristRotTheta = degToRad(map(angles[3], 0, 180, 210, -30));
      const wristRotMarker = {
        x: p3.x + 17 * Math.cos(wristRotTheta),
        y: p3.y - 7 * Math.sin(wristRotTheta)
      };

      return {
        base,
        p1,
        p2,
        p3,
        clawA,
        clawB,
        baseDirection,
        wristRotMarker,
        depth,
        shoulderTheta,
        elbowTheta,
        wristTheta
      };
    }

    _highlightLine(from, to, width) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const offsetX = (-dy / length) * width * 0.18;
      const offsetY = (dx / length) * width * 0.18;
      return {
        from: { x: from.x + offsetX, y: from.y + offsetY },
        to: { x: to.x + offsetX, y: to.y + offsetY }
      };
    }

    _offsetPoint(point, depth, scale) {
      return {
        x: point.x + depth.x * scale,
        y: point.y + depth.y * scale
      };
    }

    _sanitizeAngles(values) {
      const next = values.slice(0, 6);
      while (next.length < 6) {
        next.push(0);
      }
      return next.map((value, index) => this._clampAngle(index, value));
    }

    _clampAngle(index, value) {
      const bounds = this.jointLimits[index] || [0, 180];
      return Math.round(clamp(Number(value), bounds[0], bounds[1]));
    }

    _setLine(node, from, to) {
      this._setAttributes(node, {
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y
      });
    }

    _setPoint(node, point) {
      this._setAttributes(node, {
        cx: point.x,
        cy: point.y
      });
    }

    _setAttributes(node, attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, String(value));
      }
    }

    _svgEl(tag, attrs, text) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      if (attrs) {
        this._setAttributes(node, attrs);
      }
      if (typeof text === "string") {
        node.textContent = text;
      }
      return node;
    }

    _id(name) {
      return `${this.uid}-${name}`;
    }

    _url(name) {
      return `url(#${this._id(name)})`;
    }

    _getViewBoxWidth() {
      const viewBox = this.svg.viewBox && this.svg.viewBox.baseVal;
      return viewBox && viewBox.width > 0 ? viewBox.width : 310;
    }

    _getViewBoxHeight() {
      const viewBox = this.svg.viewBox && this.svg.viewBox.baseVal;
      return viewBox && viewBox.height > 0 ? viewBox.height : 460;
    }
  }

  function map(value, inMin, inMax, outMin, outMax) {
    if (inMax === inMin) {
      return outMin;
    }
    const ratio = (value - inMin) / (inMax - inMin);
    return outMin + ratio * (outMax - outMin);
  }

  function degToRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function radToDeg(rad) {
    return (rad * 180) / Math.PI;
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(max, Math.max(min, value));
  }

  function shade(hex, amount) {
    const raw = String(hex || "").replace("#", "");
    if (raw.length !== 6) {
      return hex;
    }
    const channels = [0, 2, 4].map((index) => {
      const value = Number.parseInt(raw.slice(index, index + 2), 16);
      return clamp(value + amount, 0, 255);
    });
    return `#${channels.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
  }

  NS.ArmPreview = ArmPreview;
  NS.ArmPreviewSketch3D = ArmPreviewSketch3D;
})();
