(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const freezeEntry = (entry) => Object.freeze({
    id: entry.id,
    provider: entry.provider,
    label: entry.label,
    capabilities: Object.freeze(entry.capabilities.slice())
  });

  const entries = Object.freeze([
    freezeEntry({
      id: "gemini-robotics-er-1.6-preview",
      provider: "google",
      label: "Gemini Robotics ER 1.6 Preview",
      capabilities: ["request", "vision", "robot_python", "object_detection"]
    }),
    freezeEntry({
      id: "gemini-3.1-flash-lite",
      provider: "google",
      label: "Gemini 3.1 Flash Lite",
      capabilities: ["request", "vision", "robot_python"]
    }),
    freezeEntry({
      id: "gemma-4-26b-a4b-it",
      provider: "google",
      label: "Gemma 4 26B A4B IT",
      capabilities: ["request", "robot_python"]
    }),
    freezeEntry({
      id: "gemma-4-31b-it",
      provider: "google",
      label: "Gemma 4 31B IT",
      capabilities: ["request", "robot_python"]
    }),
    freezeEntry({
      id: "gemini-3.5-flash",
      provider: "google",
      label: "Gemini 3.5 Flash",
      capabilities: ["request", "vision", "robot_python"]
    })
  ]);

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const catalog = {
    get(id) {
      return byId.get(String(id || "")) || null;
    },
    list(provider, capability) {
      const requestedProvider = String(provider || "").trim();
      const requestedCapability = String(capability || "").trim();
      return Object.freeze(entries.filter((entry) => (
        (!requestedProvider || entry.provider === requestedProvider) &&
        (!requestedCapability || entry.capabilities.includes(requestedCapability))
      )));
    },
    defaultFor(capability) {
      const requestedCapability = String(capability || "").trim();
      return entries.find((entry) => !requestedCapability || entry.capabilities.includes(requestedCapability)) || null;
    }
  };

  NS.ModelCatalog = Object.freeze(catalog);
})();
