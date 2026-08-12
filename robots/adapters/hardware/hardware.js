(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  class HardwareAdapter {
    constructor(manifest) {
      this.manifest = manifest;
      this.connected = false;
      this.status = "DISCONNECTED";
    }

    async connect() {
      this.connected = true;
      this.status = "CONNECTED";
      return this.getState();
    }

    async disconnect() {
      this.connected = false;
      this.status = "DISCONNECTED";
      return this.getState();
    }

    getState() {
      return {
        robotId: this.manifest ? this.manifest.id : "",
        connected: this.connected,
        status: this.status
      };
    }

    async execute() {
      throw new Error("Hardware adapter execute() is not implemented.");
    }

    async home() {
      return this.execute([{ type: "home", robotId: this.manifest.id }]);
    }

    async stop() {
      return { ok: true, status: "STOPPED" };
    }
  }

  class ArduinoSerialAdapter extends HardwareAdapter {
    constructor(manifest, serial) {
      super(manifest);
      this.serial = serial;
    }

    getState() {
      return {
        ...super.getState(),
        connected: Boolean(this.serial && this.serial.isConnected && this.serial.isConnected()),
        status: this.serial && this.serial.isConnected && this.serial.isConnected() ? "CONNECTED" : "DISCONNECTED"
      };
    }
  }

  class BridgeAdapter extends HardwareAdapter {
    constructor(options = {}) {
      super(options.manifest || { id: "so101_follower" });
      this.baseUrl = String(options.baseUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
      this.token = options.token || "";
      this.telemetrySocket = null;
    }

    async health() {
      return this._request("/health", { method: "GET" });
    }

    async listRobots() {
      return this._request("/robots", { method: "GET" });
    }

    async listPorts() {
      return this._request("/ports", { method: "GET" });
    }

    async connect(robotId, options = {}) {
      const result = await this._request(`/robots/${encodeURIComponent(robotId)}/connect`, {
        method: "POST",
        body: options
      });
      this.connected = Boolean(result && result.connected);
      this.status = result.status || (this.connected ? "CONNECTED" : "DISCONNECTED");
      return result;
    }

    async reattach(robotId) {
      const result = await this._request(`/robots/${encodeURIComponent(robotId)}/reattach`, {
        method: "POST",
        body: {}
      });
      this.connected = Boolean(result && result.connected);
      this.status = result.status || (this.connected ? "CONNECTED" : "DISCONNECTED");
      return result;
    }

    async disconnect(robotId) {
      const result = await this._request(`/robots/${encodeURIComponent(robotId)}/disconnect`, { method: "POST" });
      this.connected = false;
      this.status = result.status || "DISCONNECTED";
      return result;
    }

    async getState(robotId, options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/state`, { method: "GET", signal: options.signal });
    }

    async execute(robotId, commands) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/execute`, {
        method: "POST",
        body: { commands: Array.isArray(commands) ? commands : [] }
      });
    }

    async home(robotId) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/home`, { method: "POST" });
    }

    async stop(robotId) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/stop`, { method: "POST" });
    }

    async arm(robotId) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/arm`, { method: "POST" });
    }

    async disarm(robotId, options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/disarm`, {
        method: "POST",
        keepalive: Boolean(options.keepalive)
      });
    }

    async sendManualTarget(robotId, target) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/manual-target`, {
        method: "POST",
        body: target
      });
    }

    async cancelManualTarget(robotId, reason = "cancelled", sessionId = "", sequence = -1) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/manual-cancel`, {
        method: "POST",
        body: { reason, sessionId, sequence }
      });
    }

    async observe(robotId, purpose = "leader_ready", options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/observe`, {
        method: "POST",
        body: { schema: "robobuddy.observe.v1", purpose },
        signal: options.signal
      });
    }

    async leaderStart(robotId, payload, options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/leader-start`, {
        method: "POST",
        body: payload,
        signal: options.signal
      });
    }

    async leaderFrame(robotId, payload, options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/leader-frame`, {
        method: "POST",
        body: payload,
        signal: options.signal
      });
    }

    async leaderCancel(robotId, payload, options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/leader-cancel`, {
        method: "POST",
        body: payload,
        signal: options.signal,
        keepalive: Boolean(options.keepalive)
      });
    }

    async rangeRecoveryStart(robotId, payload, options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/range-recovery-start`, {
        method: "POST",
        body: payload,
        signal: options.signal
      });
    }

    async rangeRecoveryStep(robotId, payload, options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/range-recovery-step`, {
        method: "POST",
        body: payload,
        signal: options.signal
      });
    }

    async rangeRecoveryCancel(robotId, payload, options = {}) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/range-recovery-cancel`, {
        method: "POST",
        body: payload,
        signal: options.signal,
        keepalive: Boolean(options.keepalive)
      });
    }

    subscribeTelemetry(robotId, callback) {
      if (typeof WebSocket === "undefined") {
        return () => {};
      }
      const url = this.baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
      const socket = new WebSocket(`${url}/robots/${encodeURIComponent(robotId)}/telemetry`);
      socket.addEventListener("message", (event) => {
        try {
          callback(JSON.parse(event.data));
        } catch (error) {
          callback({ status: "ERROR", error: "Invalid telemetry payload" });
        }
      });
      this.telemetrySocket = socket;
      return () => {
        socket.close();
        if (this.telemetrySocket === socket) {
          this.telemetrySocket = null;
        }
      };
    }

    async _request(path, options = {}) {
      const headers = { "Content-Type": "application/json" };
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }
      const requestOptions = {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        keepalive: Boolean(options.keepalive)
      };
      const targetAddressSpace = getBridgeTargetAddressSpace(this.baseUrl);
      if (targetAddressSpace) {
        requestOptions.targetAddressSpace = targetAddressSpace;
      }
      let response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, requestOptions);
      } catch (error) {
        const offline = new Error(`Local bridge is not reachable at ${this.baseUrl}. Start the RoboBuddy bridge, allow local network access if the browser prompts, then click Test Bridge.`);
        offline.code = "BRIDGE_OFFLINE";
        offline.detail = error && error.message ? error.message : String(error || "");
        offline.bridgeUrl = this.baseUrl;
        throw offline;
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = { ok: response.ok };
      }
      if (!response.ok) {
        const errorBody = payload && payload.error;
        const errorCode = typeof errorBody === "object" && errorBody ? errorBody.code : "";
        const errorMessage = typeof errorBody === "object" && errorBody ? errorBody.message : errorBody;
        const message = response.status === 401
          ? "Bridge token required. Enter the token printed or configured for the local bridge, then retry."
          : (errorMessage || `Bridge request failed (${response.status})`);
        const err = new Error(message);
        err.code = errorCode || (payload && (payload.code || payload.status)) || "ERROR";
        err.status = response.status;
        err.details = (typeof errorBody === "object" && errorBody && errorBody.details) || (payload && payload.details) || {};
        err.payload = payload;
        throw err;
      }
      return payload;
    }
  }

  function getBridgeTargetAddressSpace(value) {
    try {
      const url = new URL(value, window.location && window.location.href ? window.location.href : undefined);
      const hostname = url.hostname.toLowerCase();
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
        return "loopback";
      }
      if (
        hostname.endsWith(".local") ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
      ) {
        return "local";
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  NS.RobotHardware = {
    HardwareAdapter,
    ArduinoSerialAdapter,
    BridgeAdapter
  };
})();
