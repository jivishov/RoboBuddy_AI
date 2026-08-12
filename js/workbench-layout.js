(function () {
  "use strict";

  const NS = window.RoboAdmin = window.RoboAdmin || {};
  const LAYOUT_EVENT = "robobuddy:layoutchange";
  const PANEL_EVENT = "robobuddy:paneltoggle";
  const DEFAULT_SPLITTER_SIZE = 12;

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeRatios(values, fallback) {
    const parsed = values.map(finiteNumber);
    if (parsed.some((value) => value === null || value <= 0)) {
      return fallback.slice();
    }
    const sum = parsed.reduce((total, value) => total + value, 0);
    if (!Number.isFinite(sum) || sum <= 0) {
      return fallback.slice();
    }
    return parsed.map((value) => value / sum);
  }

  function readList(value, mapper) {
    return String(value || "")
      .split(",")
      .map((item) => mapper(item.trim()))
      .filter((item) => item !== null && item !== "");
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function allocateWidths(ratios, minimums, availableWidth) {
    const widths = new Array(ratios.length).fill(0);
    const open = new Set(ratios.map((_, index) => index));
    let remaining = availableWidth;

    while (open.size > 0) {
      const ratioTotal = Array.from(open).reduce((total, index) => total + ratios[index], 0);
      const constrained = Array.from(open).filter((index) => {
        const proposed = ratioTotal > 0 ? remaining * (ratios[index] / ratioTotal) : remaining / open.size;
        return proposed < minimums[index];
      });
      if (constrained.length > 0) {
        constrained.forEach((index) => {
          widths[index] = minimums[index];
          remaining -= minimums[index];
          open.delete(index);
        });
      } else {
        const remainingIndexes = Array.from(open);
        let remainingRatio = ratioTotal;
        remainingIndexes.forEach((index, position) => {
          if (position === remainingIndexes.length - 1) {
            widths[index] = remaining;
          } else {
            const width = remainingRatio > 0 ? remaining * (ratios[index] / remainingRatio) : remaining / (remainingIndexes.length - position);
            widths[index] = width;
            remaining -= width;
            remainingRatio -= ratios[index];
          }
        });
        open.clear();
      }
    }

    const roundingDifference = availableWidth - widths.reduce((total, width) => total + width, 0);
    widths[widths.length - 1] += roundingDifference;
    return widths;
  }

  class SplitLayoutController {
    constructor(root, options = {}) {
      if (!root) {
        throw new Error("SplitLayoutController requires a root element.");
      }
      this.root = root;
      this.panes = Array.from(root.querySelectorAll("[data-split-pane]"));
      this.splitters = Array.from(root.querySelectorAll("[data-splitter-index]"));
      this.names = options.names || readList(root.dataset.splitNames, (value) => value);
      this.labels = options.labels || readList(root.dataset.splitLabels, (value) => value);
      this.minimums = options.minimums || readList(root.dataset.splitMins, (value) => finiteNumber(value));
      this.defaults = normalizeRatios(
        options.defaults || readList(root.dataset.splitDefaults, (value) => finiteNumber(value)),
        new Array(this.panes.length).fill(1 / Math.max(1, this.panes.length))
      );
      this.storageKey = options.storageKey || root.dataset.splitStorageKey || "";
      this.version = finiteNumber(options.version || root.dataset.splitVersion) || 2;
      this.id = options.id || root.dataset.splitId || this.storageKey || "workbench";
      this.ratios = this.readStoredRatios();
      this.widths = [];
      this.activeDrag = null;
      this.resizeFrame = 0;
      this.dragFrame = 0;
      this.splitterHandlers = [];
      this.lastLayoutWidth = 0;
      this.ignoreDoubleClickUntil = 0;
      this.destroyed = false;

      if (this.panes.length < 2 || this.splitters.length !== this.panes.length - 1) {
        throw new Error(`${this.id} split layout has an invalid pane/splitter structure.`);
      }
      if (this.minimums.length !== this.panes.length || this.defaults.length !== this.panes.length) {
        throw new Error(`${this.id} split layout configuration does not match its pane count.`);
      }
      if (this.names.length !== this.panes.length) {
        this.names = this.panes.map((pane, index) => pane.dataset.splitPane || `pane${index + 1}`);
      }
      if (this.labels.length !== this.panes.length) {
        this.labels = this.names.map((name) => name.replace(/[-_]/g, " "));
      }

      this.handlePointerMove = (event) => this.onPointerMove(event);
      this.handlePointerEnd = (event) => this.endDrag(event);
      this.handleWindowBlur = () => this.endDrag(null);
      this.handlePageHide = () => this.endDrag(null);
      this.handleResize = () => this.queueLayout("container-resize");

      this.wireSplitters();
      window.addEventListener("pointermove", this.handlePointerMove);
      window.addEventListener("pointerup", this.handlePointerEnd);
      window.addEventListener("pointercancel", this.handlePointerEnd);
      window.addEventListener("blur", this.handleWindowBlur);
      window.addEventListener("pagehide", this.handlePageHide);

      if (typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(this.handleResize);
        this.resizeObserver.observe(root);
      } else {
        window.addEventListener("resize", this.handleResize);
      }

      root.__robobuddySplitLayout = this;
      this.layout("init");
    }

    readStoredRatios() {
      if (!this.storageKey) {
        return this.defaults.slice();
      }
      try {
        const stored = JSON.parse(localStorage.getItem(this.storageKey) || "null");
        if (!stored || Number(stored.version) !== this.version) {
          return this.defaults.slice();
        }
        const values = this.names.map((name) => stored[name]);
        const normalized = normalizeRatios(values, this.defaults);
        if (values.some((value) => finiteNumber(value) === null || Number(value) <= 0)) {
          localStorage.removeItem(this.storageKey);
        }
        return normalized;
      } catch (error) {
        try {
          localStorage.removeItem(this.storageKey);
        } catch (storageError) {
          // Optional persistence.
        }
        return this.defaults.slice();
      }
    }

    persist() {
      if (!this.storageKey || this.root.classList.contains("is-split-fallback")) {
        return;
      }
      const stored = { version: this.version };
      this.names.forEach((name, index) => {
        stored[name] = Number(this.ratios[index].toFixed(6));
      });
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(stored));
      } catch (error) {
        // Optional persistence.
      }
    }

    splitterSize() {
      const configured = finiteNumber(getComputedStyle(this.root).getPropertyValue("--workbench-splitter-size"));
      return configured && configured > 0 ? configured : DEFAULT_SPLITTER_SIZE;
    }

    queueLayout(reason) {
      if (this.resizeFrame || this.destroyed) {
        return;
      }
      this.resizeFrame = window.requestAnimationFrame(() => {
        this.resizeFrame = 0;
        this.layout(reason);
      });
    }

    layout(reason = "layout") {
      if (this.destroyed) {
        return;
      }
      const containerWidth = this.root.clientWidth;
      if (containerWidth <= 0) {
        return;
      }
      const splitterWidth = this.splitterSize();
      const splitterTotal = splitterWidth * this.splitters.length;
      const minimumTotal = this.minimums.reduce((total, minimum) => total + minimum, 0) + splitterTotal;
      const fallback = containerWidth + 0.5 < minimumTotal;
      this.lastLayoutWidth = containerWidth;
      this.root.classList.toggle("is-split-fallback", fallback);
      this.root.dataset.splitMode = fallback ? "fallback" : "split";

      this.splitters.forEach((splitter) => {
        splitter.hidden = fallback;
        splitter.tabIndex = fallback ? -1 : 0;
        splitter.setAttribute("aria-disabled", fallback ? "true" : "false");
      });

      if (fallback) {
        this.root.style.removeProperty("grid-template-columns");
        this.panes.forEach((_, index) => this.root.style.removeProperty(`--split-pane-${index}-width`));
        this.dispatchLayoutChange(reason, true);
        return;
      }

      const availableWidth = containerWidth - splitterTotal;
      this.ratios = normalizeRatios(this.ratios, this.defaults);
      this.applyWidths(allocateWidths(this.ratios, this.minimums, availableWidth), reason);
    }

    applyWidths(widths, reason = "resize") {
      const splitterWidth = this.splitterSize();
      const availableWidth = this.root.clientWidth - splitterWidth * this.splitters.length;
      this.widths = widths.slice();
      this.ratios = normalizeRatios(
        this.widths.map((width) => width / Math.max(1, availableWidth)),
        this.defaults
      );
      const columns = [];
      this.widths.forEach((width, index) => {
        this.root.style.setProperty(`--split-pane-${index}-width`, `${width.toFixed(3)}px`);
        columns.push(`var(--split-pane-${index}-width)`);
        if (index < this.splitters.length) {
          columns.push(`${splitterWidth}px`);
        }
      });
      this.root.style.gridTemplateColumns = columns.join(" ");
      this.updateSplitterAria();
      this.dispatchLayoutChange(reason, false);
    }

    dispatchLayoutChange(reason, fallback) {
      this.root.dispatchEvent(new CustomEvent(LAYOUT_EVENT, {
        bubbles: true,
        detail: {
          id: this.id,
          reason,
          fallback,
          ratios: this.ratios.slice(),
          widths: this.widths.slice()
        }
      }));
    }

    wireSplitters() {
      this.splitters.forEach((splitter, index) => {
        const handlers = {
          pointerdown: (event) => this.startDrag(index, event),
          lostpointercapture: (event) => this.endDrag(event),
          dblclick: (event) => {
            if (performance.now() < this.ignoreDoubleClickUntil) {
              return;
            }
            event.preventDefault();
            this.reset("double-click");
          },
          keydown: (event) => this.onSplitterKeydown(index, event)
        };
        splitter.dataset.splitterIndex = String(index);
        splitter.setAttribute("role", "separator");
        splitter.setAttribute("aria-orientation", "vertical");
        splitter.tabIndex = 0;
        splitter.addEventListener("pointerdown", handlers.pointerdown);
        splitter.addEventListener("lostpointercapture", handlers.lostpointercapture);
        splitter.addEventListener("dblclick", handlers.dblclick);
        splitter.addEventListener("keydown", handlers.keydown);
        this.splitterHandlers.push({ splitter, handlers });
      });
    }

    startDrag(index, event) {
      if (event.button !== 0 || this.root.classList.contains("is-split-fallback")) {
        return;
      }
      event.preventDefault();
      this.layout("pointer-start");
      const splitter = this.splitters[index];
      try {
        splitter.setPointerCapture(event.pointerId);
      } catch (error) {
        // Pointer capture is an enhancement; window listeners remain active.
      }
      this.activeDrag = {
        index,
        pointerId: event.pointerId,
        startX: event.clientX,
        latestX: event.clientX,
        startWidths: this.widths.slice(),
        moved: false,
        splitter
      };
      document.body.classList.add("is-resizing-workbench");
    }

    onPointerMove(event) {
      if (!this.activeDrag || event.pointerId !== this.activeDrag.pointerId) {
        return;
      }
      this.activeDrag.latestX = event.clientX;
      if (Math.abs(event.clientX - this.activeDrag.startX) >= 4) {
        this.activeDrag.moved = true;
      }
      if (this.dragFrame) {
        return;
      }
      this.dragFrame = window.requestAnimationFrame(() => {
        this.dragFrame = 0;
        this.applyDragPosition();
      });
    }

    applyDragPosition() {
      if (!this.activeDrag) {
        return;
      }
      const { index, startX, latestX, startWidths } = this.activeDrag;
      const pairTotal = startWidths[index] + startWidths[index + 1];
      const nextLeft = clamp(
        startWidths[index] + latestX - startX,
        this.minimums[index],
        pairTotal - this.minimums[index + 1]
      );
      const widths = startWidths.slice();
      widths[index] = nextLeft;
      widths[index + 1] = pairTotal - nextLeft;
      this.applyWidths(widths, "pointer-move");
    }

    endDrag(event) {
      if (!this.activeDrag) {
        return;
      }
      if (event && event.pointerId !== undefined && event.pointerId !== this.activeDrag.pointerId) {
        return;
      }
      if (this.dragFrame) {
        window.cancelAnimationFrame(this.dragFrame);
        this.dragFrame = 0;
        this.applyDragPosition();
      }
      const { pointerId, splitter, moved } = this.activeDrag;
      this.activeDrag = null;
      document.body.classList.remove("is-resizing-workbench");
      try {
        if (splitter.hasPointerCapture(pointerId)) {
          splitter.releasePointerCapture(pointerId);
        }
      } catch (error) {
        // The capture may already be released by pointer cancellation.
      }
      if (moved) {
        this.ignoreDoubleClickUntil = performance.now() + 350;
        this.persist();
        this.dispatchLayoutChange("pointer-end", false);
      }
    }

    onSplitterKeydown(index, event) {
      if (this.root.classList.contains("is-split-fallback")) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.reset("keyboard-reset");
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      this.layout("keyboard-start");
      const widths = this.widths.slice();
      const pairTotal = widths[index] + widths[index + 1];
      const minimum = this.minimums[index];
      const maximum = pairTotal - this.minimums[index + 1];
      let nextLeft = widths[index];
      if (event.key === "Home") {
        nextLeft = minimum;
      } else if (event.key === "End") {
        nextLeft = maximum;
      } else {
        const step = event.shiftKey ? 48 : 16;
        nextLeft += event.key === "ArrowLeft" ? -step : step;
      }
      nextLeft = clamp(nextLeft, minimum, maximum);
      widths[index] = nextLeft;
      widths[index + 1] = pairTotal - nextLeft;
      this.applyWidths(widths, "keyboard");
      this.persist();
    }

    updateSplitterAria() {
      this.splitters.forEach((splitter, index) => {
        const pairTotal = this.widths[index] + this.widths[index + 1];
        const minimum = Math.round((this.minimums[index] / pairTotal) * 100);
        const maximum = Math.round(((pairTotal - this.minimums[index + 1]) / pairTotal) * 100);
        const current = Math.round((this.widths[index] / pairTotal) * 100);
        splitter.setAttribute("aria-valuemin", String(minimum));
        splitter.setAttribute("aria-valuemax", String(maximum));
        splitter.setAttribute("aria-valuenow", String(current));
        splitter.setAttribute("aria-valuetext", `${this.labels[index]} ${current} percent, ${this.labels[index + 1]} ${100 - current} percent`);
      });
    }

    reset(reason = "reset") {
      this.ratios = this.defaults.slice();
      this.layout(reason);
      this.persist();
    }

    destroy() {
      if (this.destroyed) {
        return;
      }
      this.endDrag(null);
      this.destroyed = true;
      if (this.resizeFrame) window.cancelAnimationFrame(this.resizeFrame);
      if (this.dragFrame) window.cancelAnimationFrame(this.dragFrame);
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", this.handleResize);
      }
      window.removeEventListener("pointermove", this.handlePointerMove);
      window.removeEventListener("pointerup", this.handlePointerEnd);
      window.removeEventListener("pointercancel", this.handlePointerEnd);
      window.removeEventListener("blur", this.handleWindowBlur);
      window.removeEventListener("pagehide", this.handlePageHide);
      this.splitterHandlers.forEach(({ splitter, handlers }) => {
        splitter.removeEventListener("pointerdown", handlers.pointerdown);
        splitter.removeEventListener("lostpointercapture", handlers.lostpointercapture);
        splitter.removeEventListener("dblclick", handlers.dblclick);
        splitter.removeEventListener("keydown", handlers.keydown);
      });
      this.splitterHandlers = [];
      if (this.root.__robobuddySplitLayout === this) {
        delete this.root.__robobuddySplitLayout;
      }
    }
  }

  class CollapsiblePanel {
    constructor(options = {}) {
      this.root = options.root || null;
      this.toggle = options.toggle || null;
      this.body = options.body || null;
      this.storageKey = options.storageKey || "";
      this.label = options.label || "Panel";
      this.defaultExpanded = options.defaultExpanded !== false;
      this.readExpanded = options.readExpanded || null;
      this.writeExpanded = options.writeExpanded || null;
      this.onChange = options.onChange || null;
      if (!this.toggle || !this.body) {
        throw new Error(`CollapsiblePanel ${this.label} is missing its toggle or body.`);
      }
      this.handleClick = () => this.setExpanded(!this.expanded, { persist: true, reason: "toggle" });
      this.toggle.addEventListener("click", this.handleClick);
      this.setExpanded(this.loadExpanded(), { persist: false, emit: false, reason: "init" });
    }

    loadExpanded() {
      if (typeof this.readExpanded === "function") {
        try {
          const value = this.readExpanded();
          return typeof value === "boolean" ? value : this.defaultExpanded;
        } catch (error) {
          return this.defaultExpanded;
        }
      }
      if (!this.storageKey) {
        return this.defaultExpanded;
      }
      try {
        const value = localStorage.getItem(this.storageKey);
        if (["1", "true", "expanded"].includes(value)) return true;
        if (["0", "false", "collapsed"].includes(value)) return false;
      } catch (error) {
        return this.defaultExpanded;
      }
      return this.defaultExpanded;
    }

    setExpanded(expanded, options = {}) {
      this.expanded = Boolean(expanded);
      this.toggle.setAttribute("aria-expanded", String(this.expanded));
      this.toggle.setAttribute("aria-label", `${this.expanded ? "Hide" : "Show"} ${this.label}`);
      this.toggle.title = `${this.expanded ? "Hide" : "Show"} ${this.label}`;
      this.toggle.dataset.hint = this.toggle.title;
      this.body.hidden = !this.expanded;
      if (this.root) {
        this.root.dataset.expanded = String(this.expanded);
      }
      if (options.persist) {
        try {
          if (typeof this.writeExpanded === "function") {
            this.writeExpanded(this.expanded);
          } else if (this.storageKey) {
            localStorage.setItem(this.storageKey, this.expanded ? "true" : "false");
          }
        } catch (error) {
          // Optional persistence.
        }
      }
      if (options.emit !== false) {
        this.toggle.dispatchEvent(new CustomEvent(PANEL_EVENT, {
          bubbles: true,
          detail: { expanded: this.expanded, label: this.label, reason: options.reason || "api" }
        }));
        if (typeof this.onChange === "function") {
          this.onChange(this.expanded, options);
        }
      }
    }

    destroy() {
      this.toggle.removeEventListener("click", this.handleClick);
    }
  }

  function formatJointValue(value, unit) {
    const number = finiteNumber(value);
    if (number === null) {
      return "—";
    }
    const normalizedNumber = Math.abs(number) < 0.0001 ? 0 : number;
    const numericText = Math.abs(normalizedNumber - Math.round(normalizedNumber)) < 0.05
      ? String(Math.round(normalizedNumber))
      : normalizedNumber.toFixed(1);
    const normalizedUnit = String(unit || "").trim().toLowerCase();
    if (["deg", "degree", "degrees", "°"].includes(normalizedUnit)) {
      return `${numericText}°`;
    }
    if (["percent", "pct", "%"].includes(normalizedUnit)) {
      return `${numericText}%`;
    }
    return normalizedUnit ? `${numericText} ${unit}` : numericText;
  }

  function createJointStateAdapter(options = {}) {
    return Object.freeze({
      read() {
        const manifest = typeof options.getManifest === "function" ? options.getManifest() : null;
        return {
          robotId: manifest && manifest.id ? manifest.id : "",
          robotName: manifest && manifest.name ? manifest.name : "",
          joints: manifest && Array.isArray(manifest.joints) ? manifest.joints : [],
          values: typeof options.getValues === "function" ? options.getValues() : null,
          error: typeof options.getError === "function" ? options.getError() : null
        };
      },
      subscribe: typeof options.subscribe === "function" ? options.subscribe : null
    });
  }

  class JointStateView {
    constructor(options = {}) {
      this.root = options.root || null;
      this.list = options.list || null;
      this.count = options.count || null;
      this.adapter = options.adapter;
      this.rowSelector = options.rowSelector || "[data-joint-row]";
      this.rowAttribute = options.rowAttribute || "data-joint-row";
      this.valueIdPrefix = options.valueIdPrefix || "jointStateValue";
      this.signature = "";
      this.rows = [];
      this.lastFormatted = [];
      this.empty = null;
      if (!this.root || !this.list || !this.adapter || typeof this.adapter.read !== "function") {
        throw new Error("JointStateView requires a root, list, and adapter.");
      }
      this.collapsible = new CollapsiblePanel({
        root: this.root,
        toggle: options.toggle,
        body: options.body || this.list,
        storageKey: options.storageKey || "",
        label: "Joint State",
        defaultExpanded: options.defaultExpanded !== false,
        onChange: options.onExpandedChange || null
      });
      if (typeof this.adapter.subscribe === "function") {
        this.unsubscribe = this.adapter.subscribe(() => this.refresh());
      }
      this.refresh();
    }

    ensureRows(joints) {
      this.rows = Array.from(this.list.querySelectorAll(this.rowSelector));
      while (this.rows.length < joints.length) {
        const index = this.rows.length;
        const row = document.createElement("div");
        if (this.rowAttribute === "data-joint-index") {
          row.dataset.jointIndex = String(index);
        } else {
          row.setAttribute(this.rowAttribute, "");
        }
        row.dataset.generatedJointRow = "";
        const label = document.createElement("span");
        const value = document.createElement("strong");
        value.id = `${this.valueIdPrefix}${index}`;
        value.textContent = "—";
        row.append(label, value);
        this.list.appendChild(row);
        this.rows.push(row);
      }
      this.rows.forEach((row, index) => {
        const joint = joints[index];
        row.hidden = !joint;
        if (!joint) {
          return;
        }
        row.dataset.jointId = joint.id || "";
        row.dataset.unit = joint.unit || "";
        const label = row.querySelector("span");
        if (label) {
          label.textContent = joint.label || joint.name || joint.id || `Joint ${index + 1}`;
        }
      });
    }

    ensureEmptyState() {
      if (this.empty) {
        return this.empty;
      }
      this.empty = document.createElement("p");
      this.empty.className = "workbench-joint-state__empty";
      this.empty.hidden = true;
      this.list.prepend(this.empty);
      return this.empty;
    }

    refresh(override = {}) {
      const snapshot = this.adapter.read();
      const joints = Array.isArray(snapshot.joints) ? snapshot.joints : [];
      const signature = `${snapshot.robotId}|${joints.map((joint) => `${joint.id}:${joint.label || joint.name || ""}:${joint.unit || ""}`).join("|")}`;
      if (signature !== this.signature) {
        this.ensureRows(joints);
        this.signature = signature;
        this.lastFormatted = [];
      }
      if (this.count) {
        this.count.textContent = `${joints.length} ${joints.length === 1 ? "joint" : "joints"}`;
      }

      const values = Object.prototype.hasOwnProperty.call(override, "values") ? override.values : snapshot.values;
      const error = Object.prototype.hasOwnProperty.call(override, "error") ? override.error : snapshot.error;
      let availableCount = 0;
      joints.forEach((joint, index) => {
        const row = this.rows[index];
        if (!row) return;
        const valueElement = row.querySelector("strong");
        const rawValue = Array.isArray(values) ? values[index] : values && typeof values === "object" ? values[joint.id] : undefined;
        const formatted = error ? "—" : formatJointValue(rawValue, joint.unit);
        if (formatted !== "—") availableCount += 1;
        if (valueElement && this.lastFormatted[index] !== formatted) {
          valueElement.textContent = formatted;
          this.lastFormatted[index] = formatted;
        }
      });

      const empty = this.ensureEmptyState();
      if (error) {
        empty.textContent = "Joint data unavailable";
        empty.hidden = false;
      } else if (joints.length > 0 && availableCount === 0) {
        empty.textContent = "Waiting for joint data";
        empty.hidden = false;
      } else {
        empty.hidden = true;
      }
    }

    setExpanded(expanded, options) {
      this.collapsible.setExpanded(expanded, options);
    }

    destroy() {
      if (typeof this.unsubscribe === "function") {
        this.unsubscribe();
      }
      this.collapsible.destroy();
    }
  }

  function initializeSplitLayouts() {
    document.querySelectorAll("[data-split-layout]").forEach((root) => {
      if (!root.__robobuddySplitLayout) {
        new SplitLayoutController(root);
      }
    });
  }

  NS.WorkbenchUI = Object.freeze({
    LAYOUT_EVENT,
    PANEL_EVENT,
    SplitLayoutController,
    CollapsiblePanel,
    JointStateView,
    createJointStateAdapter,
    formatJointValue,
    initializeSplitLayouts,
    getSplitLayout(root) {
      return root ? root.__robobuddySplitLayout || null : null;
    }
  });

  document.addEventListener("DOMContentLoaded", initializeSplitLayouts);
})();
