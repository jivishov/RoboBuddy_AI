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

    async connect(robotId, options = {}) {
      const result = await this._request(`/robots/${encodeURIComponent(robotId)}/connect`, {
        method: "POST",
        body: options
      });
      this.connected = Boolean(result && result.status === "CONNECTED");
      this.status = result.status || (this.connected ? "CONNECTED" : "DISCONNECTED");
      return result;
    }

    async disconnect(robotId) {
      const result = await this._request(`/robots/${encodeURIComponent(robotId)}/disconnect`, { method: "POST" });
      this.connected = false;
      this.status = result.status || "DISCONNECTED";
      return result;
    }

    async getState(robotId) {
      return this._request(`/robots/${encodeURIComponent(robotId)}/state`, { method: "GET" });
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
      let response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: options.method || "GET",
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
      } catch (error) {
        const offline = new Error(`BRIDGE_OFFLINE: ${error.message}`);
        offline.code = "BRIDGE_OFFLINE";
        throw offline;
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = { ok: response.ok };
      }
      if (!response.ok) {
        const message = payload && payload.error ? payload.error : `Bridge request failed (${response.status})`;
        const err = new Error(message);
        err.code = payload && payload.status ? payload.status : "ERROR";
        err.payload = payload;
        throw err;
      }
      return payload;
    }
  }

  NS.RobotHardware = {
    HardwareAdapter,
    ArduinoSerialAdapter,
    BridgeAdapter
  };
})();
