(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const HOME_ANGLES = [90, 90, 90, 90, 90, 90];
  const JOINT_LIMITS = NS.Generator ? NS.Generator.JOINT_LIMITS : [[20, 130], [15, 165], [0, 180], [0, 180], [0, 180], [25, 130]];
  const MOTORS_STORAGE_KEY = "roboadmin.motorsEnabled.v1";
  const GEMINI_SPLIT_LEFT_STORAGE_KEY = "roboadmin.geminiDraftSplitLeftPercent.v1";
  const GEMINI_SPLIT_RIGHT_STORAGE_KEY = "roboadmin.geminiDraftSplitRightPercent.v1";
  const GEMINI_IMAGE_SOURCE_TAB_STORAGE_KEY = "roboadmin.geminiDraftImageSourceTab.v1";
  const EXPECTED_FIRMWARE_PROFILE_ID = "RA1";
  const MAX_PYTHON_COMMANDS = 1000;
  const GEMINI_PYTHON_TIMEOUT_MS = 8000;
  const ROBOT_PYTHON_TIMEOUT_MS = 8000;
  const GEMINI_API_TIMEOUT_MS = 45000;
  const PYTHON_FILE_ACCEPT = ".py,.txt";
  const PYTHON_IMPORT_MAX_BYTES = 1024 * 1024;
  const MAX_INLINE_IMAGE_BYTES = 18 * 1024 * 1024;
  const OBJECT_DETECTION_MODEL = "gemini-robotics-er-1.6-preview";
  const CAMERA_CAPTURE_MIME = "image/jpeg";
  const CAMERA_CAPTURE_QUALITY = 0.86;
  const DIGITAL_CAMERA_ZOOM_MIN = 1;
  const DIGITAL_CAMERA_ZOOM_MAX = 3;
  const DIGITAL_CAMERA_ZOOM_STEP = 0.25;
  const GEMINI_SPLIT_PANEL_MIN_PERCENT = 18;
  const GEMINI_SPLIT_PANEL_MAX_PERCENT = 55;
  const GEMINI_SPLIT_DEFAULT_LEFT = 38;
  const GEMINI_SPLIT_DEFAULT_RIGHT_SPLIT = 78;
  const DISCONNECT_PARK_SPEED = 50;
  const CONTROL_OWNER = {
    IDLE: "idle",
    PROGRAM: "program"
  };

  const ROBOT_RESPONSE_SCHEMA = {
    type: "object",
    properties: {
      robotPython: {
        type: "string",
        description: "Safe RoboBuddy classroom Python using only the robot object."
      },
      summary: {
        type: "string",
        description: "Short student-readable summary of the planned motion."
      },
      safetyNotes: {
        type: "array",
        items: { type: "string" },
        description: "Concrete safety notes for the operator to review before running."
      },
      requiresHumanReview: {
        type: "boolean",
        description: "Always true when hardware motion is possible."
      }
    },
    required: ["robotPython", "summary", "safetyNotes", "requiresHumanReview"]
  };

  const DETECTION_RESPONSE_SCHEMA = {
    type: "object",
    properties: {
      sceneSummary: {
        type: "string",
        description: "Brief summary of the visible scene and the most relevant objects."
      },
      requestedObjects: {
        type: "array",
        items: { type: "string" },
        description: "Object names or classes requested by the user."
      },
      detections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Short visible object label."
            },
            matchedRequestedObject: {
              type: "string",
              description: "Requested object name this detection matches, or an empty string."
            },
            requested: {
              type: "boolean",
              description: "True when this detection is one of the requested objects."
            },
            box_2d: {
              type: "array",
              items: { type: "number", minimum: 0, maximum: 1000 },
              minItems: 4,
              maxItems: 4,
              description: "Bounding box as [ymin, xmin, ymax, xmax] normalized to 0..1000."
            },
            center_2d: {
              type: "array",
              items: { type: "number", minimum: 0, maximum: 1000 },
              minItems: 2,
              maxItems: 2,
              description: "Object center as [y, x] normalized to 0..1000."
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Estimated visual confidence from 0 to 1."
            },
            attributes: {
              type: "array",
              items: { type: "string" },
              description: "Observed color, size, material, state, or other visual attributes."
            },
            spatialNotes: {
              type: "string",
              description: "Short spatial relationship note."
            },
            evidence: {
              type: "string",
              description: "Brief visual evidence for the detection."
            }
          },
          required: ["label", "matchedRequestedObject", "requested", "box_2d", "center_2d", "confidence", "attributes", "spatialNotes", "evidence"]
        }
      },
      notFound: {
        type: "array",
        items: { type: "string" },
        description: "Requested objects that were not found."
      },
      safetyNotes: {
        type: "array",
        items: { type: "string" },
        description: "Privacy, ambiguity, or physical-world safety notes."
      }
    },
    required: ["sceneSummary", "requestedObjects", "detections", "notFound", "safetyNotes"]
  };

  const DETECTION_BOX_COLORS = ["#d62839", "#0b7a75", "#5271ff", "#b76b00", "#7c3aed", "#0f766e"];

  const ROBOT_PLANNER_PROMPT = `You are generating classroom RoboBuddy robot Python for the active robot selected in the UI.

Return JSON only with this exact object shape:
{
  "robotPython": "Python code using only the provided robot object",
  "summary": "one short summary",
  "safetyNotes": ["operator checks"],
  "requiresHumanReview": true
}

The robotPython field must use only these common methods:
robot.home()
robot.wait(seconds)
robot.move_joint(joint, value, speed=50)
robot.move_joints({"joint_id": value}, speed=50)
robot.open_gripper(speed=55)
robot.close_gripper(speed=55)
robot.smooth_move(joint, start, end, seconds=1.5)
robot.save_pose(name)
robot.go_to_pose(name, speed=50)
robot.stop()
robot.emergency_stop()

Use only the active robot context below for joint IDs, limits, capabilities, and drive support. Speed must be 1..100. Waits must be 0..30 seconds. Smooth moves must be 0.2..10 seconds.

Prefer short, conservative programs. Start from robot.home() unless the user explicitly asks to continue from the current pose. Do not use imports, files, network, serial, hardware APIs, browser APIs, or infinite loops. Do not include markdown fences.`;

  const state = {
    angles: HOME_ANGLES.slice(),
    poses: {},
    serial: null,
    preview3d: null,
    runner: null,
    motorsEnabled: false,
    controlOwner: CONTROL_OWNER.IDLE,
    firmwareMismatch: null,
    outputLines: [],
    serialLines: [],
    geminiWorker: null,
    geminiWorkerReady: false,
    geminiRequestId: 0,
    pendingGeminiPython: null,
    robotWorker: null,
    robotWorkerReady: false,
    robotRequestId: 0,
    pendingRobotPython: null,
    apiAbortController: null,
    apiBusy: false,
    selectedImage: null,
    selectedImageVersion: 0,
    detectionResult: null,
    detectionCanvasReady: false,
    activeReviewTab: "robot",
    activeImageSourceTab: "image",
    armConsoleCollapsed: true,
    geminiSplitLeftPercent: GEMINI_SPLIT_DEFAULT_LEFT,
    geminiSplitRightPercent: GEMINI_SPLIT_DEFAULT_RIGHT_SPLIT,
    activeSplitter: null,
    splitResizeRefreshQueued: false,
    cameraStream: null,
    cameraActive: false,
    cameraDevices: [],
    cameraDevicesBusy: false,
    selectedCameraDeviceId: "",
    cameraZoom: {
      value: DIGITAL_CAMERA_ZOOM_MIN,
      min: DIGITAL_CAMERA_ZOOM_MIN,
      max: DIGITAL_CAMERA_ZOOM_MAX,
      step: DIGITAL_CAMERA_ZOOM_STEP,
      mode: "digital"
    },
    editor: null,
    robotEditor: null,
    validatedCommands: null,
    validatedCode: ""
  };

  const ui = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheUi();
    if (NS.RobotRuntime) {
      NS.RobotRuntime.init({ container: ui.robotSimPreview });
    }
    setupEditor();
    syncEditorModelFromSelect();
    state.geminiSplitLeftPercent = readStoredGeminiSplitLeft(GEMINI_SPLIT_DEFAULT_LEFT);
    state.geminiSplitRightPercent = readStoredGeminiSplitRight(GEMINI_SPLIT_DEFAULT_RIGHT_SPLIT);
    state.activeImageSourceTab = readStoredImageSourceTab(state.activeImageSourceTab);
    state.armConsoleCollapsed = true;
    applyGeminiSplitLayout({ persist: false });
    showReviewTab("robot");
    showImageSourceTab(state.activeImageSourceTab);
    setArmConsoleCollapsed(state.armConsoleCollapsed);

    state.serial = new NS.SerialManager({ baudRate: 9600 });
    const previewRegistry = window.RoboBuddy3DPreview || {};
    const ArmPreview3D = previewRegistry.ArmPreview3D || NS.ArmPreview;
    if (typeof ArmPreview3D === "function" && ui.arm3dFallbackSvg) {
      state.preview3d = new ArmPreview3D(ui.arm3dFallbackSvg, {
        jointLimits: JOINT_LIMITS,
        initialAngles: state.angles,
        cameraPreset: "compact"
      });
    } else {
      mark3dPreviewUnavailable();
    }

    NS.getPoseNames = () => Object.keys(state.poses).sort((a, b) => a.localeCompare(b));

    state.runner = new NS.ProgramRunner({
      serial: state.serial,
      getAngles: () => state.angles.slice(),
      applyAngles: (angles) => applyAngles(angles, { source: "runner" }),
      getPose: (name) => (state.poses[name] ? state.poses[name].slice() : null),
      savePose: (name, angles) => {
        state.poses[name] = angles.slice();
        setStatus(`Pose saved: ${name}`);
      }
    });

    state.motorsEnabled = readMotorsEnabled();
    initRobotUi();

    wireSerialEvents();
    wireRunnerEvents();
    wireButtons();
    wireSplitters();
    createGeminiWorker();
    createRobotWorker();
    applyAngles(state.angles, { source: "init" });
    syncPreviewVisibility();
    syncMotorsToggleUi();
    updateRunControls();
    syncCameraControls();
    void refreshCameraDevices({ silent: true });
    if (!supportsCameraCapture()) {
      setImageStatus("No image selected. Camera capture requires localhost or HTTPS with browser camera support.", "ready");
    }
    appendOutput("Gemini ready. Enter a session API key before calling Gemini.");

    window.addEventListener("resize", refreshEditor);
    window.addEventListener("pagehide", () => {
      stopCamera({ silent: true });
    });
    window.addEventListener("beforeunload", () => {
      stopCamera({ silent: true });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (ui.outputDialog && ui.outputDialog.open) {
          return;
        }
        event.preventDefault();
        void handleEmergencyStop();
      }
    });

    if (!state.serial.supportsWebSerial()) {
      ui.btnConnect.disabled = true;
      setConnectionStatus(false, "Web Serial unavailable");
    }
  }

  function cacheUi() {
    ui.statusDot = document.getElementById("statusDot");
    ui.statusText = document.getElementById("statusText");
    ui.programStatus = document.getElementById("programStatus");
    ui.programStatusIcon = document.getElementById("programStatusIcon");
    ui.btnConnect = document.getElementById("btnConnect");
    ui.btnHome = document.getElementById("btnHome");
    ui.btnEmergencyStop = document.getElementById("btnEmergencyStop");
    ui.robotChooser = document.getElementById("geminiRobotChooser");
    ui.apiKey = document.getElementById("geminiApiKey");
    ui.modelSelect = document.getElementById("geminiModelSelect");
    ui.imageInput = document.getElementById("geminiImageInput");
    ui.imageStatus = document.getElementById("geminiImageStatus");
    ui.imageSourceTabInput = document.getElementById("btnGeminiImageInputTab");
    ui.imageSourceTabCamera = document.getElementById("btnGeminiImageCameraTab");
    ui.imageSourceInputPanel = document.getElementById("geminiImageInputPanel");
    ui.imageSourceCameraPanel = document.getElementById("geminiImageCameraPanel");
    ui.clearImageButtons = Array.from(document.querySelectorAll("[data-gemini-clear-image]"));
    ui.btnDetectObjects = document.getElementById("btnDetectObjects");
    ui.btnDownloadAnnotatedImage = document.getElementById("btnDownloadAnnotatedImage");
    ui.detectionStatus = document.getElementById("geminiDetectionStatus");
    ui.detectionResult = document.getElementById("geminiDetectionResult");
    ui.detectionCanvas = document.getElementById("geminiDetectionCanvas");
    ui.detectionSummary = document.getElementById("geminiDetectionSummary");
    ui.detectionDetails = document.getElementById("geminiDetectionDetails");
    ui.cameraSelect = document.getElementById("geminiCameraSelect");
    ui.btnOpenCamera = document.getElementById("btnOpenCamera");
    ui.btnCaptureCamera = document.getElementById("btnCaptureCamera");
    ui.btnStopCamera = document.getElementById("btnStopCamera");
    ui.btnCameraZoomOut = document.getElementById("btnCameraZoomOut");
    ui.btnCameraZoomIn = document.getElementById("btnCameraZoomIn");
    ui.cameraZoomValue = document.getElementById("geminiCameraZoomValue");
    ui.cameraPreviewFrame = document.getElementById("geminiCameraPreviewFrame");
    ui.cameraPreview = document.getElementById("geminiCameraPreview");
    ui.pythonEditor = document.getElementById("geminiPythonEditor");
    ui.robotPython = document.getElementById("geminiRobotPython");
    ui.btnReviewTabRobot = document.getElementById("btnGeminiReviewRobotTab");
    ui.btnReviewTabVision = document.getElementById("btnGeminiReviewVisionTab");
    ui.reviewRobotPanel = document.getElementById("geminiReviewRobotPanel");
    ui.reviewVisionPanel = document.getElementById("geminiReviewVisionPanel");
    ui.geminiRuntimeStatus = document.getElementById("geminiRuntimeStatus");
    ui.robotRuntimeStatus = document.getElementById("robotRuntimeStatus");
    ui.effectStatus = document.getElementById("geminiEffectStatus");
    ui.armConsoleToggle = document.getElementById("btnGeminiArmConsoleToggle");
    ui.armConsolePanel = document.getElementById("geminiArmConsolePanel");
    ui.armConsoleToggleIcon = ui.armConsoleToggle
      ? ui.armConsoleToggle.querySelector(".gemini-draft__console-toggle-icon [data-lucide]")
      : null;
    ui.geminiSplitContainer = document.querySelector(".gemini-draft");
    ui.leftSplitter = document.getElementById("geminiSplitSdkRobot");
    ui.rightSplitter = document.getElementById("geminiSplitRobotSide");
    ui.commandSummary = document.getElementById("geminiCommandSummary");
    ui.outputLog = document.getElementById("geminiOutputLog");
    ui.commandPreview = document.getElementById("geminiCommandPreview");
    ui.serialLog = document.getElementById("geminiSerialLog");
    ui.motorsEnabled = document.getElementById("geminiMotorsEnabled");
    ui.arm3dFallbackSvg = document.getElementById("geminiArm3dFallbackSvg");
    ui.previewSketchPanel = document.getElementById("geminiPreviewSketchPanel");
    ui.previewBody = document.querySelector(".gemini-draft__preview-body");
    ui.robotSimPreview = document.getElementById("geminiRobotSimPreview");
    ui.runSpinner = document.getElementById("geminiRunSpinner");
    ui.btnRunGemini = document.getElementById("btnRunGemini");
    ui.btnGenerateRobotPython = document.getElementById("btnGenerateRobotPython");
    ui.btnCancelGemini = document.getElementById("btnCancelGemini");
    ui.btnSaveGeminiPython = document.getElementById("btnSaveGeminiPython");
    ui.btnLoadGeminiPython = document.getElementById("btnLoadGeminiPython");
    ui.btnClearGeminiOutput = document.getElementById("btnClearGeminiOutput");
    ui.btnOpenGeminiOutput = document.getElementById("btnOpenGeminiOutput");
    ui.btnCopyGeminiOutput = document.getElementById("btnCopyGeminiOutput");
    ui.outputDialog = document.getElementById("geminiOutputDialog");
    ui.outputDialogContent = document.getElementById("geminiOutputDialogContent");
    ui.btnCloseGeminiOutput = document.getElementById("btnCloseGeminiOutput");
    ui.btnCloseGeminiOutputFooter = document.getElementById("btnCloseGeminiOutputFooter");
    ui.btnCopyGeminiOutputDialog = document.getElementById("btnCopyGeminiOutputDialog");
    ui.btnValidateRobotPython = document.getElementById("btnValidateRobotPython");
    ui.btnRunRobotPython = document.getElementById("btnRunRobotPython");
    ui.btnPause = document.getElementById("btnGeminiPause");
    ui.btnStop = document.getElementById("btnGeminiStop");
    ui.btnSaveRobotPython = document.getElementById("btnSaveRobotPython");
    ui.btnLoadRobotPython = document.getElementById("btnLoadRobotPython");
    ui.btnCopyRobotPython = document.getElementById("btnCopyRobotPython");
    ui.jointValues = [];
    for (let servo = 0; servo < 6; servo += 1) {
      ui.jointValues.push(document.getElementById(`geminiJointValue${servo}`));
    }
  }

  function setupEditor() {
    if (!window.CodeMirror || !ui.pythonEditor) {
      return;
    }

    state.editor = window.CodeMirror.fromTextArea(ui.pythonEditor, {
      mode: "python",
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      lineWrapping: true,
      viewportMargin: Infinity
    });
    state.editor.setSize("100%", "100%");
    if (ui.robotPython) {
      state.robotEditor = window.CodeMirror.fromTextArea(ui.robotPython, {
        mode: "python",
        lineNumbers: true,
        indentUnit: 2,
        tabSize: 2,
        lineWrapping: true,
        viewportMargin: Infinity
      });
      state.robotEditor.setSize("100%", "100%");
      state.robotEditor.on("change", handleRobotPythonChanged);
    }
  }

  function refreshEditor() {
    if (state.editor) {
      window.requestAnimationFrame(() => state.editor.refresh());
    }
    if (state.robotEditor) {
      window.requestAnimationFrame(() => state.robotEditor.refresh());
    }
    if (state.preview3d && typeof state.preview3d.resize === "function") {
      window.requestAnimationFrame(() => state.preview3d.resize());
    }
  }

  function getEditorValue() {
    return state.editor ? state.editor.getValue() : (ui.pythonEditor.value || "");
  }

  function setEditorValue(code) {
    if (state.editor) {
      state.editor.setValue(code || "");
      window.requestAnimationFrame(() => state.editor.refresh());
      return;
    }
    ui.pythonEditor.value = code || "";
  }

  function getRobotEditorValue() {
    return state.robotEditor ? state.robotEditor.getValue() : (ui.robotPython.value || "");
  }

  function setRobotEditorValue(code) {
    if (state.robotEditor) {
      state.robotEditor.setValue(code || "");
      window.requestAnimationFrame(() => state.robotEditor.refresh());
      return;
    }
    ui.robotPython.value = code || "";
  }

  function initRobotUi() {
    renderRobotChooser();
    wireRobotUi();
    syncRobotUi({ clearValidation: false, resetPose: true });
  }

  function renderRobotChooser() {
    if (!ui.robotChooser || !NS.RobotRegistry) {
      return;
    }
    const active = activeRobotId();
    ui.robotChooser.innerHTML = "";
    NS.RobotRegistry.list().forEach((manifest) => {
      const option = document.createElement("option");
      option.value = manifest.id;
      option.textContent = manifest.name;
      option.selected = manifest.id === active;
      ui.robotChooser.appendChild(option);
    });
  }

  function wireRobotUi() {
    if (ui.robotChooser) {
      ui.robotChooser.addEventListener("change", () => {
        if (isBusy()) {
          ui.robotChooser.value = activeRobotId();
          setStatus("Wait for the active run to finish before switching robots.");
          return;
        }
        if (NS.RobotRuntime) {
          NS.RobotRuntime.setActive(ui.robotChooser.value);
        } else if (NS.RobotRegistry) {
          NS.RobotRegistry.setActive(ui.robotChooser.value);
        }
      });
    }
    window.addEventListener("robobuddy:active-robot-change", () => {
      syncRobotUi({
        clearValidation: true,
        resetPose: true,
        message: `Robot switched to ${activeManifest().name}. Validate reviewed Python again.`
      });
    });
  }

  function syncRobotUi(options = {}) {
    const manifest = activeManifest();
    if (ui.robotChooser && manifest) {
      ui.robotChooser.value = manifest.id;
    }
    if (!isArduinoActive()) {
      state.motorsEnabled = false;
    }
    syncConnectButton();
    syncMotorsToggleUi();
    if (options.resetPose) {
      applyAngles(getActiveHomeAngles());
    }
    syncPreviewVisibility();
    if (options.clearValidation) {
      clearReviewedRobotValidation(options.message || "Robot changed. Validate reviewed Python again.");
    }
  }

  function clearReviewedRobotValidation(message) {
    state.validatedCommands = null;
    state.validatedCode = "";
    updateCommandSummary("-");
    if (ui.commandPreview) {
      ui.commandPreview.textContent = "";
    }
    if (message) {
      updateEffectStatus(message, "warning");
      setStatus(message);
    }
    updateRunControls();
  }

  function activeManifest() {
    return NS.RobotRegistry && NS.RobotRegistry.getActive ? NS.RobotRegistry.getActive() : null;
  }

  function activeRobotId() {
    const manifest = activeManifest();
    return manifest ? manifest.id : "arduino_arm";
  }

  function isArduinoActive() {
    return activeRobotId() === "arduino_arm";
  }

  function getActiveHomeAngles() {
    return NS.RobotSafety && activeManifest() ? NS.RobotSafety.getHomeAngles(activeManifest()) : HOME_ANGLES.slice();
  }

  function getActiveJointState() {
    const manifest = activeManifest();
    const joints = {};
    (manifest && Array.isArray(manifest.joints) ? manifest.joints : []).forEach((joint, index) => {
      joints[joint.id] = state.angles[index] ?? joint.home ?? 0;
    });
    return joints;
  }

  function handleRobotPythonChanged() {
    state.validatedCommands = null;
    state.validatedCode = "";
    updateCommandSummary("-");
    ui.commandPreview.textContent = "";
    updateEffectStatus("Generated Python changed. Validate before running.", "warning");
    updateRunControls();
  }

  function wireSerialEvents() {
    state.serial.addEventListener("status", (event) => {
      const detail = event.detail || {};
      const connected = Boolean(detail.connected);
      setConnectionStatus(connected, detail.message || "");
      appendSerial("SYS", `${connected ? "Connected" : "Disconnected"}: ${detail.message || "-"}`);
      syncConnectButton();
      updateRunControls();
    });

    state.serial.addEventListener("positions", (event) => {
      const angles = event.detail && Array.isArray(event.detail.angles) ? event.detail.angles : null;
      if (angles) {
        applyAngles(angles, { source: "serial" });
      }
    });

    state.serial.addEventListener("tx", (event) => {
      const command = event.detail ? event.detail.command : "";
      if (command) {
        appendSerial("TX", command);
      }
    });

    state.serial.addEventListener("line", (event) => {
      const line = event.detail ? event.detail.line : "";
      if (!line) {
        return;
      }
      appendSerial("RX", line);
      if (line === "STOPPED") {
        setStatus("Emergency stop confirmed");
      } else if (line.startsWith("ERR")) {
        setStatus(`Device error: ${line}`);
      } else if (line === "READY") {
        setStatus("Device ready");
      }
    });
  }

  function wireRunnerEvents() {
    state.runner.addEventListener("status", (event) => {
      const text = event.detail ? event.detail.text : "";
      if (text) {
        setStatus(text);
      }
      updateRunControls();
    });

    state.runner.addEventListener("paused", updateRunControls);

    state.runner.addEventListener("running", (event) => {
      const running = Boolean(event.detail && event.detail.running);
      state.controlOwner = running ? CONTROL_OWNER.PROGRAM : CONTROL_OWNER.IDLE;
      updateRunControls();
    });

    state.runner.addEventListener("error", (event) => {
      const error = event.detail ? event.detail.error : null;
      if (error) {
        setStatus(`Runner error: ${error.message || error}`);
      }
      state.controlOwner = CONTROL_OWNER.IDLE;
      updateRunControls();
    });
  }

  function wireButtons() {
    ui.btnConnect.addEventListener("click", () => {
      void handleConnectToggle();
    });

    ui.btnHome.addEventListener("click", () => {
      void handleHome();
    });

    ui.btnEmergencyStop.addEventListener("click", () => {
      void handleEmergencyStop();
    });

    ui.modelSelect.addEventListener("change", () => {
      syncEditorModelFromSelect();
    });

    ui.imageInput.addEventListener("change", () => {
      void handleImageSelected();
    });

    ui.clearImageButtons.forEach((button) => button.addEventListener("click", () => {
      clearImage();
    }));

    ui.cameraSelect.addEventListener("change", () => {
      void handleCameraSelectionChanged();
    });

    ui.btnOpenCamera.addEventListener("click", () => {
      void openCamera();
    });

    ui.btnCaptureCamera.addEventListener("click", () => {
      void captureCameraImage();
    });

    ui.btnStopCamera.addEventListener("click", () => {
      stopCamera();
    });

    ui.btnCameraZoomOut.addEventListener("click", () => {
      void applyCameraZoom(-state.cameraZoom.step);
    });

    ui.btnCameraZoomIn.addEventListener("click", () => {
      void applyCameraZoom(state.cameraZoom.step);
    });

    ui.btnRunGemini.addEventListener("click", () => {
      void runGeminiRequest({ robotMode: false });
    });

    ui.btnGenerateRobotPython.addEventListener("click", () => {
      void runGeminiRequest({ robotMode: true });
    });

    if (ui.btnDetectObjects) {
      ui.btnDetectObjects.addEventListener("click", () => {
        void runObjectDetection();
      });
    }

    if (ui.btnDownloadAnnotatedImage) {
      ui.btnDownloadAnnotatedImage.addEventListener("click", () => {
        void downloadAnnotatedImage();
      });
    }

    if (ui.btnReviewTabRobot) {
      ui.btnReviewTabRobot.addEventListener("click", () => {
        showReviewTab("robot");
      });
    }

    if (ui.btnReviewTabVision) {
      ui.btnReviewTabVision.addEventListener("click", () => {
        showReviewTab("vision");
      });
    }
    wireTablistKeyboard([
      { name: "robot", button: ui.btnReviewTabRobot },
      { name: "vision", button: ui.btnReviewTabVision }
    ], showReviewTab);

    if (ui.imageSourceTabInput) {
      ui.imageSourceTabInput.addEventListener("click", () => {
        showImageSourceTab("image");
      });
    }

    if (ui.imageSourceTabCamera) {
      ui.imageSourceTabCamera.addEventListener("click", () => {
        showImageSourceTab("camera");
      });
    }
    wireTablistKeyboard([
      { name: "image", button: ui.imageSourceTabInput },
      { name: "camera", button: ui.imageSourceTabCamera }
    ], showImageSourceTab);

    ui.btnCancelGemini.addEventListener("click", () => {
      cancelGeminiWork("Gemini request canceled");
    });

    if (ui.armConsoleToggle) {
      ui.armConsoleToggle.addEventListener("click", () => {
        setArmConsoleCollapsed(!state.armConsoleCollapsed);
      });
    }

    if (ui.btnSaveGeminiPython) {
      ui.btnSaveGeminiPython.addEventListener("click", () => {
        void saveGeminiPythonToFile();
      });
    }

    if (ui.btnLoadGeminiPython) {
      ui.btnLoadGeminiPython.addEventListener("click", () => {
        void loadGeminiPythonFromFile();
      });
    }

    ui.btnClearGeminiOutput.addEventListener("click", () => {
      clearGeminiOutput();
    });

    ui.btnOpenGeminiOutput.addEventListener("click", () => {
      openGeminiOutputDialog();
    });

    ui.btnCopyGeminiOutput.addEventListener("click", () => {
      void copyGeminiOutput();
    });

    ui.btnCopyGeminiOutputDialog.addEventListener("click", () => {
      void copyGeminiOutput();
    });

    ui.btnCloseGeminiOutput.addEventListener("click", () => {
      closeGeminiOutputDialog();
    });

    ui.btnCloseGeminiOutputFooter.addEventListener("click", () => {
      closeGeminiOutputDialog();
    });

    ui.btnValidateRobotPython.addEventListener("click", () => {
      void validateRobotPython();
    });

    ui.btnRunRobotPython.addEventListener("click", () => {
      void runReviewedRobotPython();
    });

    ui.btnPause.addEventListener("click", () => {
      void handlePauseResume();
    });

    ui.btnStop.addEventListener("click", () => {
      void handleStop();
    });

    if (ui.btnSaveRobotPython) {
      ui.btnSaveRobotPython.addEventListener("click", () => {
        void saveRobotPythonToFile();
      });
    }

    if (ui.btnLoadRobotPython) {
      ui.btnLoadRobotPython.addEventListener("click", () => {
        void loadRobotPythonFromFile();
      });
    }

    ui.btnCopyRobotPython.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getRobotEditorValue());
        setStatus("Reviewed Python copied");
      } catch (error) {
        setStatus("Copy failed (clipboard permission)");
      }
    });

    ui.motorsEnabled.addEventListener("change", (event) => {
      void setMotorsEnabled(Boolean(event.target && event.target.checked), { sendCommand: true });
    });

    if (!state.robotEditor) {
      ui.robotPython.addEventListener("input", handleRobotPythonChanged);
    }
  }

  async function saveGeminiPythonToFile() {
    await savePythonTextFile(getEditorValue(), `robobuddy-gemini-request-${slugTimestamp()}.py`, "Gemini Python");
  }

  async function loadGeminiPythonFromFile() {
    if (isBusy()) {
      setStatus("Wait for the active run to finish before loading Python.");
      return;
    }
    const result = await openPythonTextFile("Gemini Python");
    if (!result) {
      return;
    }
    setEditorValue(result.text);
    setRobotEditorValue("");
    state.validatedCommands = null;
    state.validatedCode = "";
    updateCommandSummary("-");
    ui.commandPreview.textContent = "";
    clearGeminiOutput();
    updateEffectStatus("Gemini Python loaded. Generate reviewed robot Python before running.", "warning");
    setStatus(`Loaded Gemini Python${result.name ? `: ${result.name}` : ""}.`);
    updateRunControls();
  }

  async function saveRobotPythonToFile() {
    await savePythonTextFile(getRobotEditorValue(), `robobuddy-reviewed-python-${slugTimestamp()}.py`, "Reviewed Python");
  }

  async function loadRobotPythonFromFile() {
    if (isBusy()) {
      setStatus("Wait for the active run to finish before loading reviewed Python.");
      return;
    }
    const result = await openPythonTextFile("Reviewed Python");
    if (!result) {
      return;
    }
    setRobotEditorValue(result.text);
    state.validatedCommands = null;
    state.validatedCode = "";
    updateCommandSummary("-");
    ui.commandPreview.textContent = "";
    updateEffectStatus("Reviewed Python loaded. Validate before running.", "warning");
    setStatus(`Loaded reviewed Python${result.name ? `: ${result.name}` : ""}.`);
    updateRunControls();
  }

  async function savePythonTextFile(code, suggestedName, label) {
    const fileApi = NS.FileWorkflows;
    if (!fileApi || typeof fileApi.saveTextFile !== "function") {
      setStatus(`${label} save failed: file helper unavailable.`);
      return;
    }
    const result = await fileApi.saveTextFile(code, {
      suggestedName,
      accept: PYTHON_FILE_ACCEPT,
      description: "Python code",
      mimeType: "text/plain;charset=utf-8"
    });
    if (!result.ok) {
      setStatus(result.canceled ? `${label} save canceled.` : `${label} save failed: ${result.error ? result.error.message || result.error : "unknown error"}`);
      return;
    }
    setStatus(result.name ? `${label} saved: ${result.name}` : `${label} saved to local file.`);
  }

  async function openPythonTextFile(label) {
    const fileApi = NS.FileWorkflows;
    if (!fileApi || typeof fileApi.openTextFile !== "function") {
      setStatus(`${label} load failed: file helper unavailable.`);
      return null;
    }
    const result = await fileApi.openTextFile({
      accept: PYTHON_FILE_ACCEPT,
      description: "Python code",
      mimeType: "text/plain",
      maxBytes: PYTHON_IMPORT_MAX_BYTES
    });
    if (!result.ok) {
      setStatus(result.canceled ? `${label} load canceled.` : `${label} load failed: ${result.error ? result.error.message || result.error : "unknown error"}`);
      return null;
    }
    return {
      text: result.text,
      name: result.name || ""
    };
  }

  function slugTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("") + "-" + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join("");
  }

  function createGeminiWorker() {
    if (state.geminiWorker) {
      state.geminiWorker.terminate();
    }

    state.geminiWorkerReady = false;
    state.geminiWorker = new Worker("js/gemini-python-worker.js");
    state.geminiWorker.addEventListener("message", onGeminiWorkerMessage);
    state.geminiWorker.addEventListener("error", (event) => {
      state.geminiWorkerReady = false;
      setRuntimeStatus(ui.geminiRuntimeStatus, `Gemini runtime error: ${event.message || "worker failed"}`, "error");
      if (state.pendingGeminiPython) {
        finishPendingGeminiPython({
          ok: false,
          request: null,
          stdout: "",
          stderr: "",
          robotResponse: "",
          error: event.message || "Gemini Python worker failed",
          traceback: ""
        });
      }
      updateRunControls();
    });
    setRuntimeStatus(ui.geminiRuntimeStatus, "Loading Gemini Python runtime...", "warning");
  }

  function onGeminiWorkerMessage(event) {
    const data = event.data || {};
    if (data.type === "status") {
      if (data.phase === "ready") {
        state.geminiWorkerReady = true;
        setRuntimeStatus(ui.geminiRuntimeStatus, "Gemini Python runtime ready", "ready");
      } else {
        setRuntimeStatus(ui.geminiRuntimeStatus, "Loading Gemini Python runtime...", "warning");
      }
      updateRunControls();
      return;
    }

    if (data.type === "result") {
      finishPendingGeminiPython(data);
    }
  }

  function executeGeminiPython(mode, code, responseText = "") {
    if (!state.geminiWorker) {
      createGeminiWorker();
    }

    if (state.pendingGeminiPython) {
      return Promise.reject(new Error("Gemini Python is already running."));
    }

    const id = state.geminiRequestId + 1;
    state.geminiRequestId = id;

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!state.pendingGeminiPython || state.pendingGeminiPython.id !== id) {
          return;
        }
        state.pendingGeminiPython = null;
        state.geminiWorkerReady = false;
        state.geminiWorker.terminate();
        state.geminiWorker = null;
        setRuntimeStatus(ui.geminiRuntimeStatus, "Gemini Python runtime stopped after timeout", "error");
        createGeminiWorker();
        updateRunControls();
        reject(new Error(`Gemini Python timed out after ${GEMINI_PYTHON_TIMEOUT_MS / 1000}s.`));
      }, GEMINI_PYTHON_TIMEOUT_MS);

      state.pendingGeminiPython = { id, resolve, reject, timeoutId };
      updateRunControls();
      state.geminiWorker.postMessage({
        type: "run",
        id,
        mode,
        python: code,
        responseText
      });
    });
  }

  function finishPendingGeminiPython(data) {
    if (!state.pendingGeminiPython || data.id !== state.pendingGeminiPython.id) {
      return;
    }

    window.clearTimeout(state.pendingGeminiPython.timeoutId);
    const pending = state.pendingGeminiPython;
    state.pendingGeminiPython = null;
    updateRunControls();
    pending.resolve(data);
  }

  function createRobotWorker() {
    if (state.robotWorker) {
      state.robotWorker.terminate();
    }

    state.robotWorkerReady = false;
    state.robotWorker = new Worker("js/python-worker.js");
    state.robotWorker.addEventListener("message", onRobotWorkerMessage);
    state.robotWorker.addEventListener("error", (event) => {
      state.robotWorkerReady = false;
      setRuntimeStatus(ui.robotRuntimeStatus, `Robot runtime error: ${event.message || "worker failed"}`, "error");
      if (state.pendingRobotPython) {
        finishPendingRobotPython({
          ok: false,
          commands: [],
          stdout: "",
          stderr: "",
          error: event.message || "Robot Python worker failed",
          traceback: ""
        });
      }
      updateRunControls();
    });
    setRuntimeStatus(ui.robotRuntimeStatus, "Loading robot Python runtime...", "warning");
  }

  function onRobotWorkerMessage(event) {
    const data = event.data || {};
    if (data.type === "status") {
      if (data.phase === "ready") {
        state.robotWorkerReady = true;
        setRuntimeStatus(ui.robotRuntimeStatus, "Robot Python runtime ready", "ready");
      } else {
        setRuntimeStatus(ui.robotRuntimeStatus, "Loading robot Python runtime...", "warning");
      }
      updateRunControls();
      return;
    }

    if (data.type === "result") {
      finishPendingRobotPython(data);
    }
  }

  function executeRobotPython(code) {
    if (!state.robotWorker) {
      createRobotWorker();
    }

    if (state.pendingRobotPython) {
      return Promise.reject(new Error("Robot Python is already running."));
    }

    const id = state.robotRequestId + 1;
    state.robotRequestId = id;

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!state.pendingRobotPython || state.pendingRobotPython.id !== id) {
          return;
        }
        state.pendingRobotPython = null;
        state.robotWorkerReady = false;
        state.robotWorker.terminate();
        state.robotWorker = null;
        setRuntimeStatus(ui.robotRuntimeStatus, "Robot Python runtime stopped after timeout", "error");
        createRobotWorker();
        updateRunControls();
        reject(new Error(`Robot Python timed out after ${ROBOT_PYTHON_TIMEOUT_MS / 1000}s.`));
      }, ROBOT_PYTHON_TIMEOUT_MS);

      state.pendingRobotPython = { id, resolve, reject, timeoutId };
      updateRunControls();
      state.robotWorker.postMessage({
        type: "run",
        id,
        python: code,
        manifest: activeManifest(),
        activeRobotId: activeRobotId(),
        initialJoints: getActiveJointState(),
        poses: state.poses,
        maxCommands: MAX_PYTHON_COMMANDS
      });
    });
  }

  function finishPendingRobotPython(data) {
    if (!state.pendingRobotPython || data.id !== state.pendingRobotPython.id) {
      return;
    }

    window.clearTimeout(state.pendingRobotPython.timeoutId);
    const pending = state.pendingRobotPython;
    state.pendingRobotPython = null;
    updateRunControls();
    pending.resolve(data);
  }

  async function runGeminiRequest(options = {}) {
    const robotMode = Boolean(options.robotMode);
    const apiKey = ui.apiKey.value.trim();
    if (!apiKey) {
      setStatus("Enter a session Gemini API key first.");
      updateEffectStatus("API key required for Gemini requests.", "warning");
      return false;
    }

    if (isBusy()) {
      setStatus("Wait for the active run to finish.");
      return false;
    }

    const code = getEditorValue();
    if (!code.trim()) {
      setStatus("Gemini Python editor is empty.");
      return false;
    }

    state.apiBusy = true;
    state.validatedCommands = null;
    state.validatedCode = "";
    updateCommandSummary("-");
    ui.commandPreview.textContent = "";
    updateRunControls();

    try {
      setStatus(robotMode ? "Preparing robot-planning request..." : "Preparing Gemini request...");
      const capture = await executeGeminiPython("capture", code);
      appendGeminiPythonResult(capture, "Capture");
      if (!capture.ok) {
        throw new Error(capture.error || "Gemini Python capture failed.");
      }
      if (!capture.request) {
        throw new Error("Python did not call client.models.generate_content(...).");
      }

      const selectedModel = resolveSelectedModel();
      const capturedModel = String(capture.request.model || "");
      const model = selectedModel || capturedModel;
      if (!model) {
        throw new Error("Choose a Gemini model.");
      }
      if (capturedModel && model !== capturedModel) {
        appendOutput(`Model selector override: ${capturedModel} -> ${model}`);
      }

      const body = robotMode
        ? buildRobotRequestBody(capture.request)
        : buildRawRequestBody(capture.request);

      setStatus(`Calling ${model}...`);
      const responseText = await callGeminiApi(apiKey, model, body);
      appendOutput(`Gemini response:\n${responseText || "(empty response)"}`);

      const replay = await executeGeminiPython("replay", code, responseText);
      appendGeminiPythonResult(replay, "Replay");
      if (!replay.ok) {
        updateEffectStatus(`Gemini replay warning: ${replay.error || "unknown error"}`, "warning");
      }

      if (robotMode) {
        const sourceText = replay.robotResponse || responseText;
        applyRobotPlan(sourceText);
      } else {
        updateEffectStatus("Gemini response received. Raw output only; no robot motion prepared.", "ready");
      }
      setStatus(robotMode ? "Robot Python generated for review." : "Gemini request complete.");
      return true;
    } catch (error) {
      const message = error && error.name === "AbortError" ? "Gemini request canceled" : error.message;
      setStatus(message);
      updateEffectStatus(message, "error");
      appendOutput(`Error: ${message}`);
      return false;
    } finally {
      state.apiBusy = false;
      state.apiAbortController = null;
      updateRunControls();
    }
  }

  async function runObjectDetection() {
    const apiKey = ui.apiKey.value.trim();
    if (!state.selectedImage) {
      const message = "Select or capture an image before object detection.";
      showReviewTab("vision");
      setStatus(message);
      setDetectionStatus(message, "warning");
      return false;
    }
    if (!apiKey) {
      const message = "Enter a session Gemini API key before object detection.";
      showReviewTab("vision");
      setStatus(message);
      setDetectionStatus(message, "warning");
      return false;
    }
    if (isBusy()) {
      setStatus("Wait for the active run to finish.");
      return false;
    }

    const code = getEditorValue();
    if (!code.trim()) {
      const message = "Gemini Python editor is empty.";
      showReviewTab("vision");
      setStatus(message);
      setDetectionStatus(message, "warning");
      return false;
    }

    const selectedImage = state.selectedImage;
    const imageVersion = state.selectedImageVersion;

    state.apiBusy = true;
    state.detectionResult = null;
    state.detectionCanvasReady = false;
    showReviewTab("vision");
    resetDetectionOutput("Preparing image-recognition request...", "warning");
    updateRunControls();

    try {
      setStatus("Preparing image-recognition request...");
      const capture = await executeGeminiPython("capture", code);
      appendGeminiPythonResult(capture, "Capture");
      if (!capture.ok) {
        throw new Error(capture.error || "Gemini Python capture failed.");
      }
      if (!capture.request) {
        throw new Error("Python did not call client.models.generate_content(...).");
      }

      const capturedModel = String(capture.request.model || "");
      const selectedModel = resolveSelectedModel();
      const sourceModel = capturedModel || selectedModel;
      if (sourceModel && sourceModel !== OBJECT_DETECTION_MODEL) {
        appendOutput(`Object detection model override: ${sourceModel} -> ${OBJECT_DETECTION_MODEL}`);
      }

      const promptText = extractTextFromContents(capture.request.contents).trim();
      setDetectionStatus("Detecting objects with Robotics-ER...", "warning");
      setStatus(`Calling ${OBJECT_DETECTION_MODEL} for image recognition...`);
      const body = buildObjectDetectionRequestBody(promptText, selectedImage);
      const responseText = await callGeminiApi(apiKey, OBJECT_DETECTION_MODEL, body);
      appendOutput(`Object detection response:\n${responseText || "(empty response)"}`);

      if (imageVersion !== state.selectedImageVersion) {
        const message = "Detection result discarded because the selected image changed.";
        setStatus(message);
        setDetectionStatus(message, "warning");
        return false;
      }

      const result = parseDetectionJson(responseText);
      state.detectionResult = result;
      await renderDetectionResults(result);
      showReviewTab("vision");
      const count = result.detections.length;
      setStatus(`Object detection complete (${count} ${count === 1 ? "object" : "objects"}).`);
      return true;
    } catch (error) {
      const message = error && error.name === "AbortError"
        ? "Gemini request canceled"
        : ((error && error.message) || String(error || "Object detection failed."));
      setStatus(message);
      setDetectionStatus(message, "error");
      appendOutput(`Error: ${message}`);
      state.detectionCanvasReady = false;
      syncDetectionControls();
      return false;
    } finally {
      state.apiBusy = false;
      state.apiAbortController = null;
      updateRunControls();
    }
  }

  function buildObjectDetectionRequestBody(promptText, image) {
    return {
      contents: [
        {
          role: "user",
          parts: [
            buildSelectedImagePart(image),
            { text: buildObjectDetectionPrompt(promptText) }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        ...buildJsonResponseGenerationConfig(DETECTION_RESPONSE_SCHEMA)
      }
    };
  }

  function buildObjectDetectionPrompt(promptText) {
    const trimmed = String(promptText || "").trim();
    const requestLine = trimmed
      ? `Requested object recognition task: ${trimmed}`
      : "Requested object recognition task: detect all prominent objects in the image.";
    return [
      "Analyze the image for object recognition.",
      requestLine,
      "Return JSON only. Use [ymin, xmin, ymax, xmax] for each box_2d, normalized from 0 to 1000 relative to the original image dimensions.",
      "If specific objects are requested, mark requested=true only for matching detections and list requested objects that are not visible in notFound.",
      "Include relevant nearby objects when they help understand the scene.",
      "Do not identify people. Label visible people only as person and include privacy or safety cautions in safetyNotes."
    ].join(" ");
  }

  function parseDetectionJson(text) {
    const parsed = parseJsonPayload(text, "Gemini returned an empty object-detection response.");
    const source = Array.isArray(parsed)
      ? { sceneSummary: "", requestedObjects: [], detections: parsed, notFound: [], safetyNotes: [] }
      : (parsed && typeof parsed === "object" ? parsed : {});
    const rawDetections = Array.isArray(source.detections) ? source.detections : [];
    const detections = rawDetections
      .map((item, index) => normalizeDetection(item, index))
      .filter(Boolean);

    return {
      sceneSummary: safeText(source.sceneSummary || source.summary),
      requestedObjects: stringArray(source.requestedObjects || source.requested_objects),
      detections,
      notFound: stringArray(source.notFound || source.not_found),
      safetyNotes: stringArray(source.safetyNotes || source.safety_notes)
    };
  }

  function parseJsonPayload(text, emptyMessage) {
    const raw = String(text || "").trim();
    if (!raw) {
      throw new Error(emptyMessage || "Gemini returned an empty JSON response.");
    }
    try {
      return JSON.parse(raw);
    } catch (firstError) {
      const fenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
      const startObject = fenced.indexOf("{");
      const endObject = fenced.lastIndexOf("}");
      const startArray = fenced.indexOf("[");
      const endArray = fenced.lastIndexOf("]");
      if (startObject >= 0 && endObject > startObject) {
        return JSON.parse(fenced.slice(startObject, endObject + 1));
      }
      if (startArray >= 0 && endArray > startArray) {
        return JSON.parse(fenced.slice(startArray, endArray + 1));
      }
      throw firstError;
    }
  }

  function normalizeDetection(value, index) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const box = normalizeBox2d(value.box_2d || value.box2d || value.box, index);
    if (!box) {
      return null;
    }
    const center = normalizePoint2d(value.center_2d || value.center2d || value.center) || [
      (box[0] + box[2]) / 2,
      (box[1] + box[3]) / 2
    ];
    return {
      label: safeText(value.label || value.name || `Object ${index + 1}`),
      matchedRequestedObject: safeText(value.matchedRequestedObject || value.matched_requested_object),
      requested: Boolean(value.requested),
      box_2d: box,
      center_2d: center,
      confidence: numberOrNull(value.confidence, 0, 1),
      attributes: stringArray(value.attributes),
      spatialNotes: safeText(value.spatialNotes || value.spatial_notes),
      evidence: safeText(value.evidence)
    };
  }

  function normalizeBox2d(value) {
    if (!Array.isArray(value) || value.length < 4) {
      return null;
    }
    const numbers = value.slice(0, 4).map((item) => Number(item));
    if (numbers.some((item) => !Number.isFinite(item))) {
      return null;
    }
    const ymin = clampNumber(Math.min(numbers[0], numbers[2]), 0, 1000);
    const xmin = clampNumber(Math.min(numbers[1], numbers[3]), 0, 1000);
    const ymax = clampNumber(Math.max(numbers[0], numbers[2]), 0, 1000);
    const xmax = clampNumber(Math.max(numbers[1], numbers[3]), 0, 1000);
    if (ymax <= ymin || xmax <= xmin) {
      return null;
    }
    return [ymin, xmin, ymax, xmax];
  }

  function normalizePoint2d(value) {
    if (!Array.isArray(value) || value.length < 2) {
      return null;
    }
    const y = Number(value[0]);
    const x = Number(value[1]);
    if (!Number.isFinite(y) || !Number.isFinite(x)) {
      return null;
    }
    return [clampNumber(y, 0, 1000), clampNumber(x, 0, 1000)];
  }

  function stringArray(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => safeText(item)).filter(Boolean);
  }

  function safeText(value) {
    return String(value || "").trim();
  }

  function numberOrNull(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return null;
    }
    return clampNumber(number, min, max);
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  async function renderDetectionResults(result) {
    if (!ui.detectionResult) {
      return;
    }
    ui.detectionResult.hidden = false;
    ui.detectionSummary.textContent = result.sceneSummary || "Object detection results";
    renderDetectionDetails(result);
    await drawDetectionCanvas(result);
    const count = result.detections.length;
    const notFound = result.notFound.length;
    const suffix = notFound ? `; ${notFound} requested not found` : "";
    setDetectionStatus(`${count} ${count === 1 ? "object" : "objects"} detected${suffix}.`, count ? "ready" : "warning");
    syncDetectionControls();
  }

  function renderDetectionDetails(result) {
    if (!ui.detectionDetails) {
      return;
    }
    ui.detectionDetails.textContent = "";
    const fragment = document.createDocumentFragment();
    if (result.requestedObjects.length > 0) {
      fragment.appendChild(buildDetectionNote("Requested", result.requestedObjects.join(", ")));
    }
    if (result.notFound.length > 0) {
      fragment.appendChild(buildDetectionNote("Not Found", result.notFound.join(", ")));
    }
    if (result.safetyNotes.length > 0) {
      fragment.appendChild(buildDetectionNote("Notes", result.safetyNotes.join(" ")));
    }
    if (result.detections.length === 0) {
      fragment.appendChild(buildDetectionNote("Detections", "No valid boxes returned."));
    }
    result.detections.forEach((detection, index) => {
      fragment.appendChild(buildDetectionItem(detection, index));
    });
    ui.detectionDetails.appendChild(fragment);
  }

  function buildDetectionNote(label, value) {
    const item = document.createElement("div");
    item.className = "gemini-draft__detection-note";
    const strong = document.createElement("strong");
    strong.textContent = label;
    const span = document.createElement("span");
    span.textContent = value || "-";
    item.append(strong, span);
    return item;
  }

  function buildDetectionItem(detection, index) {
    const item = document.createElement("article");
    item.className = "gemini-draft__detection-item";
    const color = DETECTION_BOX_COLORS[index % DETECTION_BOX_COLORS.length];
    item.style.setProperty("--detection-color", color);

    const title = document.createElement("h3");
    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${detection.label}`;
    const confidence = document.createElement("small");
    confidence.textContent = detection.confidence === null ? "confidence -" : `${Math.round(detection.confidence * 100)}%`;
    title.append(label, confidence);
    item.appendChild(title);

    const rows = [
      ["Requested", detection.requested ? "yes" : "no"],
      ["Match", detection.matchedRequestedObject || "-"],
      ["Box", detection.box_2d.map((value) => Math.round(value)).join(", ")],
      ["Center", detection.center_2d.map((value) => Math.round(value)).join(", ")],
      ["Attributes", detection.attributes.join(", ") || "-"],
      ["Spatial", detection.spatialNotes || "-"],
      ["Evidence", detection.evidence || "-"]
    ];
    rows.forEach(([key, value]) => {
      item.appendChild(buildDetectionMetaRow(key, value));
    });
    return item;
  }

  function buildDetectionMetaRow(key, value) {
    const row = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = key;
    const span = document.createElement("span");
    span.textContent = value;
    row.append(strong, span);
    return row;
  }

  async function drawDetectionCanvas(result) {
    const canvas = ui.detectionCanvas;
    const context = canvas && canvas.getContext ? canvas.getContext("2d") : null;
    const imageDataUrl = selectedImageDataUrl();
    if (!canvas || !context || !state.selectedImage || !imageDataUrl) {
      state.detectionCanvasReady = false;
      return false;
    }

    const image = await loadImageElement(imageDataUrl);
    const width = image.naturalWidth || state.selectedImage.width;
    const height = image.naturalHeight || state.selectedImage.height;
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    result.detections.forEach((detection, index) => {
      drawDetectionBox(context, detection, index, width, height);
    });

    state.detectionCanvasReady = true;
    return true;
  }

  function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener("error", () => reject(new Error("Annotated image could not be decoded.")), { once: true });
      image.src = dataUrl;
    });
  }

  function drawDetectionBox(context, detection, index, imageWidth, imageHeight) {
    const [ymin, xmin, ymax, xmax] = detection.box_2d;
    const x = Math.round((xmin / 1000) * imageWidth);
    const y = Math.round((ymin / 1000) * imageHeight);
    const width = Math.max(1, Math.round(((xmax - xmin) / 1000) * imageWidth));
    const height = Math.max(1, Math.round(((ymax - ymin) / 1000) * imageHeight));
    const color = DETECTION_BOX_COLORS[index % DETECTION_BOX_COLORS.length];
    const lineWidth = Math.max(3, Math.round(Math.min(imageWidth, imageHeight) / 240));

    context.save();
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.strokeRect(x, y, width, height);

    const label = `${index + 1}. ${detection.label}${detection.confidence === null ? "" : ` ${Math.round(detection.confidence * 100)}%`}`;
    const fontSize = Math.max(16, Math.round(Math.min(imageWidth, imageHeight) / 34));
    const padding = Math.max(6, Math.round(fontSize * 0.38));
    context.font = `700 ${fontSize}px "DM Sans", "Segoe UI", sans-serif`;
    const textWidth = context.measureText(label).width;
    const labelWidth = Math.min(imageWidth, Math.ceil(textWidth + (padding * 2)));
    const labelHeight = fontSize + (padding * 2);
    const labelX = Math.min(Math.max(0, x), Math.max(0, imageWidth - labelWidth));
    const labelY = y - labelHeight >= 0 ? y - labelHeight : Math.min(imageHeight - labelHeight, y);

    context.fillStyle = color;
    context.fillRect(labelX, Math.max(0, labelY), labelWidth, labelHeight);
    context.fillStyle = "#ffffff";
    context.fillText(label, labelX + padding, Math.max(0, labelY) + padding + fontSize - 2);

    if (Array.isArray(detection.center_2d)) {
      const centerY = Math.round((detection.center_2d[0] / 1000) * imageHeight);
      const centerX = Math.round((detection.center_2d[1] / 1000) * imageWidth);
      context.beginPath();
      context.arc(centerX, centerY, Math.max(4, lineWidth * 1.5), 0, Math.PI * 2);
      context.fillStyle = "#ffffff";
      context.fill();
      context.strokeStyle = color;
      context.lineWidth = Math.max(2, Math.round(lineWidth / 2));
      context.stroke();
    }
    context.restore();
  }

  function resetDetectionOutput(message = "No detections yet.", tone = "ready") {
    state.detectionResult = null;
    state.detectionCanvasReady = false;
    if (ui.detectionResult) {
      ui.detectionResult.hidden = true;
    }
    if (ui.detectionSummary) {
      ui.detectionSummary.textContent = "";
    }
    if (ui.detectionDetails) {
      ui.detectionDetails.textContent = "";
    }
    if (ui.detectionCanvas && ui.detectionCanvas.getContext) {
      const context = ui.detectionCanvas.getContext("2d");
      context.clearRect(0, 0, ui.detectionCanvas.width || 1, ui.detectionCanvas.height || 1);
      ui.detectionCanvas.width = 0;
      ui.detectionCanvas.height = 0;
    }
    setDetectionStatus(message, tone);
    syncDetectionControls();
  }

  async function downloadAnnotatedImage() {
    const canvas = ui.detectionCanvas;
    if (!state.detectionCanvasReady || !canvas || !canvas.width || !canvas.height) {
      setDetectionStatus("No annotated image is ready to download.", "warning");
      return;
    }
    try {
      const blob = await canvasToBlob(canvas, "image/png");
      const suggestedName = `robobuddy-detections-${formatCameraTimestamp(new Date())}.png`;
      const fileApi = NS.FileWorkflows;
      if (fileApi && typeof fileApi.saveBlobFile === "function") {
        const result = await fileApi.saveBlobFile(blob, {
          suggestedName,
          accept: ".png",
          description: "RoboBuddy annotated image",
          mimeType: "image/png",
          preferPicker: false
        });
        if (!result.ok) {
          setDetectionStatus(result.canceled ? "Annotated image download canceled." : `Annotated image download failed: ${result.error ? result.error.message || result.error : "unknown error"}`, "error");
          return;
        }
        setDetectionStatus(result.name ? `Annotated image download started: ${result.name}` : "Annotated image download started.", "ready");
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = suggestedName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDetectionStatus("Annotated image download started.", "ready");
    } catch (error) {
      setDetectionStatus(`Annotated image download failed: ${error.message || error}`, "error");
    }
  }

  function buildRawRequestBody(request) {
    const body = {
      contents: appendSelectedImage(normalizeContents(request.contents))
    };
    const configParts = normalizeConfig(request.config, request.kwargs);
    if (Object.keys(configParts.generationConfig).length > 0) {
      body.generationConfig = configParts.generationConfig;
    }
    if (configParts.tools.length > 0) {
      body.tools = configParts.tools;
    }
    return body;
  }

  function buildTextResponseFormat(mimeType, schema) {
    const text = {
      mimeType: normalizeTextResponseMimeType(mimeType || "text/plain")
    };
    if (schema) {
      text.schema = schema;
    }
    return { text };
  }

  function buildJsonResponseGenerationConfig(schema) {
    return {
      responseFormat: buildTextResponseFormat("application/json", schema)
    };
  }

  function buildActiveRobotPromptContext() {
    const manifest = activeManifest();
    if (!manifest) {
      return "Active robot: Arduino Arm\nUse conservative Arduino Arm joint commands only.";
    }
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities.join(", ") : "none listed";
    const joints = Array.isArray(manifest.joints) && manifest.joints.length > 0
      ? manifest.joints.map((joint) => {
        const unit = joint.unit || "deg";
        const home = Number.isFinite(Number(joint.home)) ? `, home ${joint.home}${unit === "percent" ? "%" : ""}` : "";
        return `- ${joint.id} (${joint.label || joint.id}): ${joint.min}..${joint.max} ${unit}${home}`;
      }).join("\n")
      : "- no joints listed";
    const driveContext = manifest.mobileBase
      ? [
        "Drive support: available for this mobile robot.",
        `Drive methods: robot.drive(vx_percent, vy_percent=0, omega=0, seconds=1.0), robot.drive_forward(speed_percent, seconds=1.0), robot.drive_backward(speed_percent, seconds=1.0), robot.strafe_left(speed_percent, seconds=1.0), robot.strafe_right(speed_percent, seconds=1.0), robot.turn_left(omega=45, seconds=1.0), robot.turn_right(omega=45, seconds=1.0).`,
        `Maximum angular speed is ${manifest.mobileBase.maxAngularSpeed || 90} deg/s; drive speed arguments are percentages.`
      ].join("\n")
      : "Drive support: not available. Do not emit drive, strafe, or turn commands.";
    return [
      "Active robot context:",
      `Name: ${manifest.name}`,
      `ID: ${manifest.id}`,
      `Capabilities: ${capabilities}`,
      "Available joints and limits:",
      joints,
      driveContext,
      "Use only the exact joint IDs listed above."
    ].join("\n");
  }

  function buildRobotRequestBody(request) {
    const studentPrompt = extractTextFromContents(request.contents).trim() || "Create a short, safe robot motion.";
    const text = `${ROBOT_PLANNER_PROMPT}\n\n${buildActiveRobotPromptContext()}\n\nStudent request:\n${studentPrompt}`;
    return {
      contents: appendSelectedImage([
        {
          role: "user",
          parts: [{ text }]
        }
      ]),
      generationConfig: {
        temperature: 0.2,
        ...buildJsonResponseGenerationConfig(ROBOT_RESPONSE_SCHEMA)
      }
    };
  }

  function normalizeContents(value) {
    if (Array.isArray(value)) {
      if (value.some((item) => item && typeof item === "object" && Array.isArray(item.parts))) {
        return value.map((item) => ({
          role: item.role || "user",
          parts: normalizeParts(item.parts)
        }));
      }
      return [{ role: "user", parts: normalizeParts(value) }];
    }

    if (value && typeof value === "object" && Array.isArray(value.parts)) {
      return [{
        role: value.role || "user",
        parts: normalizeParts(value.parts)
      }];
    }

    return [{
      role: "user",
      parts: [{ text: typeof value === "string" ? value : JSON.stringify(value) }]
    }];
  }

  function normalizeParts(parts) {
    return (Array.isArray(parts) ? parts : [parts]).map((part) => {
      if (typeof part === "string") {
        return { text: part };
      }
      if (!part || typeof part !== "object") {
        return { text: String(part || "") };
      }
      if (typeof part.text === "string") {
        return { text: part.text };
      }
      if (part.inline_data || part.inlineData) {
        return part;
      }
      return { text: JSON.stringify(part) };
    });
  }

  function appendSelectedImage(contents) {
    const next = Array.isArray(contents) && contents.length > 0
      ? contents.map((item) => ({ role: item.role || "user", parts: Array.isArray(item.parts) ? item.parts.slice() : [] }))
      : [{ role: "user", parts: [] }];

    if (!state.selectedImage) {
      return next;
    }

    next[0].parts.unshift(buildSelectedImagePart(state.selectedImage));
    return next;
  }

  function buildSelectedImagePart(image) {
    return {
      inlineData: {
        mimeType: image.mimeType,
        data: image.data
      }
    };
  }

  function extractTextFromContents(value) {
    const chunks = [];
    collectText(value, chunks);
    return chunks.join("\n").trim();
  }

  function collectText(value, chunks) {
    if (typeof value === "string") {
      chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectText(item, chunks));
      return;
    }
    if (value && typeof value === "object") {
      if (typeof value.text === "string") {
        chunks.push(value.text);
      }
      if (Array.isArray(value.parts)) {
        value.parts.forEach((item) => collectText(item, chunks));
      }
    }
  }

  function normalizeConfig(config, kwargs) {
    const raw = {};
    if (config && typeof config === "object" && !Array.isArray(config)) {
      Object.assign(raw, config);
    }
    if (kwargs && typeof kwargs === "object" && !Array.isArray(kwargs)) {
      Object.assign(raw, kwargs);
    }

    const generationConfig = {};
    const tools = [];
    copyNumberConfig(raw, generationConfig, "temperature");
    copyNumberConfig(raw, generationConfig, "topP", "top_p");
    copyNumberConfig(raw, generationConfig, "topK", "top_k");
    copyNumberConfig(raw, generationConfig, "maxOutputTokens", "max_output_tokens");

    if (raw.thinkingConfig || raw.thinking_config) {
      generationConfig.thinkingConfig = camelizeApiObject(raw.thinkingConfig || raw.thinking_config);
    }
    if (raw.responseFormat || raw.response_format) {
      generationConfig.responseFormat = normalizeResponseFormat(raw.responseFormat || raw.response_format);
    } else if (raw.responseMimeType || raw.response_mime_type || raw.responseSchema || raw.response_schema || raw.responseJsonSchema || raw.response_json_schema) {
      const mimeType = raw.responseMimeType || raw.response_mime_type || "application/json";
      const schema = raw.responseSchema || raw.response_schema || raw.responseJsonSchema || raw.response_json_schema || null;
      generationConfig.responseFormat = buildTextResponseFormat(mimeType, schema);
    }
    if (Array.isArray(raw.tools)) {
      tools.push(...raw.tools.map(camelizeApiObject));
    }

    return { generationConfig, tools };
  }

  function copyNumberConfig(source, target, camelKey, snakeKey) {
    const value = source[camelKey] !== undefined ? source[camelKey] : source[snakeKey || camelKey];
    const n = Number(value);
    if (Number.isFinite(n)) {
      target[camelKey] = n;
    }
  }

  function normalizeResponseFormat(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const text = value.text || value.Text || {};
    const out = {};
    const textOut = {};
    if (text.mimeType || text.mime_type) {
      textOut.mimeType = normalizeTextResponseMimeType(text.mimeType || text.mime_type);
    }
    if (text.schema) {
      textOut.schema = text.schema;
    }
    if (Object.keys(textOut).length > 0) {
      out.text = textOut;
    }
    return Object.keys(out).length > 0 ? out : camelizeApiObject(value);
  }

  function normalizeTextResponseMimeType(value) {
    const text = String(value || "").trim();
    const compact = text.toLowerCase().replace(/[-/]/g, "_");
    if (compact === "application_json") {
      return "APPLICATION_JSON";
    }
    if (compact === "text_plain") {
      return "TEXT_PLAIN";
    }
    return text;
  }

  function camelizeApiObject(value, parentKey = "") {
    if (Array.isArray(value)) {
      return value.map((item) => camelizeApiObject(item, parentKey));
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if (parentKey === "schema" || parentKey === "parameters" || parentKey === "responseSchema" || parentKey === "responseJsonSchema") {
      return value;
    }
    const out = {};
    Object.keys(value).forEach((key) => {
      const nextKey = snakeToCamel(key);
      out[nextKey] = camelizeApiObject(value[key], nextKey);
    });
    return out;
  }

  function snakeToCamel(value) {
    return String(value).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  async function callGeminiApi(apiKey, model, body) {
    const url = `https://generativelanguage.googleapis.com/v1beta/${formatModelResourcePath(model)}:generateContent`;
    const controller = new AbortController();
    state.apiAbortController = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), GEMINI_API_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const apiMessage = data && data.error && data.error.message ? data.error.message : response.statusText;
        throw new Error(`Gemini API error ${response.status}: ${apiMessage}`);
      }
      return extractGeminiText(data);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function formatModelResourcePath(model) {
    const raw = String(model || "").trim().replace(/^\/+/, "");
    const resourcePath = raw.includes("/") ? raw : `models/${raw}`;
    return resourcePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  }

  function extractGeminiText(data) {
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content
      ? data.candidates[0].content.parts || []
      : [];
    const text = parts.map((part) => part && part.text ? part.text : "").filter(Boolean).join("\n");
    if (text) {
      return text;
    }
    if (data && data.promptFeedback && data.promptFeedback.blockReason) {
      throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
    }
    return "";
  }

  function appendGeminiPythonResult(result, label) {
    const stdout = result.stdout ? result.stdout.trimEnd() : "";
    const stderr = result.stderr ? result.stderr.trimEnd() : "";
    if (stdout) {
      appendOutput(`${label} stdout:\n${stdout}`);
    }
    if (stderr) {
      appendOutput(`${label} stderr:\n${stderr}`);
    }
    if (!result.ok && result.error) {
      appendOutput(`${label} error: ${result.error}`);
      if (result.traceback) {
        appendOutput(result.traceback.trimEnd());
      }
    }
  }

  function applyRobotPlan(text) {
    const parsed = parseRobotJson(text);
    const robotPython = String(parsed.robotPython || "").trim();
    if (!robotPython) {
      throw new Error("Gemini response did not include robotPython.");
    }
    showReviewTab("robot");
    setRobotEditorValue(robotPython);
    state.validatedCommands = null;
    state.validatedCode = "";
    updateCommandSummary("-");
    ui.commandPreview.textContent = "";
    updateEffectStatus(parsed.summary || "Robot Python generated. Review and validate before running.", "warning");
    if (Array.isArray(parsed.safetyNotes) && parsed.safetyNotes.length > 0) {
      appendOutput(`Safety notes:\n${parsed.safetyNotes.map((note) => `- ${note}`).join("\n")}`);
    }
  }

  function parseRobotJson(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      throw new Error("Gemini returned an empty robot-plan response.");
    }
    try {
      return JSON.parse(raw);
    } catch (firstError) {
      const fenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
      const start = fenced.indexOf("{");
      const end = fenced.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(fenced.slice(start, end + 1));
      }
      throw firstError;
    }
  }

  async function validateRobotPython() {
    const code = getRobotEditorValue();
    if (!code.trim()) {
      setStatus("Reviewed Python is empty.");
      updateEffectStatus("Generate or write RoboBuddy Python before validation.", "warning");
      return null;
    }
    if (isBusy()) {
      setStatus("Wait for the active run to finish.");
      return null;
    }

    try {
      setStatus("Validating reviewed Python...");
      const result = await executeRobotPython(code);
      appendRobotResult(result);
      if (!result.ok) {
        throw new Error(result.error || "Robot Python validation failed.");
      }
      const commands = validatePythonCommands(result.commands || []);
      state.validatedCommands = commands;
      state.validatedCode = code;
      updateCommandSummary(`${commands.length} commands ready`);
      ui.commandPreview.textContent = formatCommands(commands);
      updateEffectStatus("Command list validated. Review preview before running.", "ready");
      setStatus("Reviewed Python validated.");
      return commands;
    } catch (error) {
      state.validatedCommands = null;
      state.validatedCode = "";
      updateCommandSummary("-");
      ui.commandPreview.textContent = "";
      updateEffectStatus(`Validation failed: ${error.message}`, "error");
      setStatus(`Validation failed: ${error.message}`);
      return null;
    } finally {
      updateRunControls();
    }
  }

  async function runReviewedRobotPython() {
    let commands = state.validatedCommands;
    if (!commands || state.validatedCode !== getRobotEditorValue()) {
      commands = await validateRobotPython();
    }
    if (!commands || commands.length === 0) {
      setStatus("No validated commands to run.");
      return false;
    }
    return runCommands(commands, "Reviewed Python");
  }

  function appendRobotResult(result) {
    const stdout = result.stdout ? result.stdout.trimEnd() : "";
    const stderr = result.stderr ? result.stderr.trimEnd() : "";
    if (stdout) {
      appendOutput(`Robot Python stdout:\n${stdout}`);
    }
    if (stderr) {
      appendOutput(`Robot Python stderr:\n${stderr}`);
    }
    if (!result.ok && result.error) {
      appendOutput(`Robot Python error: ${result.error}`);
      if (result.traceback) {
        appendOutput(result.traceback.trimEnd());
      }
    }
  }

  async function runCommands(commands, label) {
    if (!Array.isArray(commands) || commands.length === 0) {
      setStatus(`${label} has no commands to run.`);
      return false;
    }
    if (state.runner.isRunning() || state.controlOwner === CONTROL_OWNER.PROGRAM) {
      setStatus("Program already running.");
      return false;
    }
    if (isArduinoActive() && state.serial.isConnected() && !ensureMotionAllowed()) {
      return false;
    }

    setStatus(`Starting ${label} run (${commands.length} steps)...`);
    try {
      await state.runner.run(commands, null);
      return true;
    } catch (error) {
      setStatus(`${label} run failed: ${error.message}`);
      return false;
    }
  }

  function validatePythonCommands(rawCommands) {
    if (NS.RobotCommandSchema) {
      return NS.RobotCommandSchema.validateCommandList(rawCommands, { activeRobotId: activeRobotId() });
    }
    if (!Array.isArray(rawCommands)) {
      throw new Error("Python did not return a command list.");
    }
    return rawCommands.map((command, index) => validatePythonCommand(command, index));
  }

  function validatePythonCommand(command, index) {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error(`Command ${index + 1} is not an object.`);
    }
    const type = String(command.type || "");
    switch (type) {
      case "servo": {
        const servo = intInRange(command.servo, 0, 5, `Command ${index + 1} servo`);
        const limits = JOINT_LIMITS[servo] || [0, 180];
        const angle = intInRange(command.angle, limits[0], limits[1], `Command ${index + 1} angle`);
        const speed = intInRange(command.speed, 1, 100, `Command ${index + 1} speed`);
        return { type, servo, angle, speed };
      }
      case "home":
      case "emergencyStop":
        return { type };
      case "delay": {
        const ms = intInRange(command.ms, 0, 30000, `Command ${index + 1} delay`);
        return { type, ms };
      }
      case "savePose": {
        const name = safePoseName(command.name, `Command ${index + 1} pose`);
        return { type, name };
      }
      case "goPose": {
        const name = safePoseName(command.name, `Command ${index + 1} pose`);
        const speed = intInRange(command.speed, 1, 100, `Command ${index + 1} speed`);
        return { type, name, speed };
      }
      case "smoothMove": {
        const servo = intInRange(command.servo, 0, 5, `Command ${index + 1} servo`);
        const limits = JOINT_LIMITS[servo] || [0, 180];
        const from = intInRange(command.from, limits[0], limits[1], `Command ${index + 1} start angle`);
        const to = intInRange(command.to, limits[0], limits[1], `Command ${index + 1} end angle`);
        const durationMs = intInRange(command.durationMs, 200, 10000, `Command ${index + 1} duration`);
        return { type, servo, from, to, durationMs };
      }
      default:
        throw new Error(`Command ${index + 1} has unsupported type: ${type || "(missing)"}.`);
    }
  }

  function formatCommands(commands) {
    return commands.map((command, index) => {
      if (command.type === "servo") {
        return `${index + 1}. servo ${command.servo} -> ${command.angle} deg @ ${command.speed}`;
      }
      if (command.type === "delay") {
        return `${index + 1}. wait ${command.ms} ms`;
      }
      if (command.type === "smoothMove") {
        return `${index + 1}. smooth servo ${command.servo}: ${command.from} -> ${command.to} over ${command.durationMs} ms`;
      }
      if (command.type === "savePose") {
        return `${index + 1}. save pose "${command.name}"`;
      }
      if (command.type === "goPose") {
        return `${index + 1}. go pose "${command.name}" @ ${command.speed}`;
      }
      if (command.type === "move_joint") {
        return `${index + 1}. ${command.robotId} ${command.joint} -> ${command.value} @ ${command.speed}`;
      }
      if (command.type === "move_joints") {
        return `${index + 1}. ${command.robotId} move joints ${Object.keys(command.joints || {}).join(", ")} @ ${command.speed}`;
      }
      if (command.type === "set_gripper") {
        return `${index + 1}. ${command.robotId} gripper -> ${command.value} @ ${command.speed}`;
      }
      if (command.type === "wait") {
        return `${index + 1}. wait ${command.seconds}s`;
      }
      if (command.type === "drive") {
        return `${index + 1}. ${command.robotId} drive vx=${command.vx} vy=${command.vy} omega=${command.omega} for ${command.seconds}s`;
      }
      if (command.type === "stop") {
        return `${index + 1}. stop ${command.robotId || "robot"}`;
      }
      return `${index + 1}. ${command.type}`;
    }).join("\n");
  }

  async function handleImageSelected() {
    const file = ui.imageInput.files && ui.imageInput.files[0] ? ui.imageInput.files[0] : null;
    if (!file) {
      clearImage();
      return;
    }
    const ok = await setSelectedImageFromBlob(file, file.name, file.type || "image/jpeg", "Uploaded");
    if (ok) {
      stopCamera({ silent: true });
    }
  }

  async function openCamera() {
    if (!supportsCameraCapture()) {
      setImageStatus("Camera capture is unavailable. Use localhost or HTTPS in a browser with camera support.", "error");
      syncCameraControls();
      return;
    }
    if (state.cameraActive) {
      syncCameraControls();
      return;
    }

    try {
      resetCameraZoom();
      setImageStatus("Requesting camera permission...", "warning");
      const stream = await navigator.mediaDevices.getUserMedia(buildCameraConstraints());
      state.cameraStream = stream;
      state.cameraActive = true;
      ui.cameraPreview.srcObject = stream;
      ui.cameraPreviewFrame.hidden = false;
      stream.getTracks().forEach((track) => {
        track.addEventListener("ended", () => {
          if (state.cameraStream === stream) {
            stopCamera();
          }
        }, { once: true });
      });
      await ui.cameraPreview.play().catch(() => {});
      await refreshCameraDevices({ silent: true });
      await configureCameraZoom(stream);
      setImageStatus(`Camera ready. ${state.cameraZoom.mode === "hardware" ? "Hardware" : "Digital"} zoom available. Capture a snapshot when the image is framed.`, "warning");
    } catch (error) {
      stopCamera({ silent: true });
      const name = error && error.name ? error.name : "";
      const message = name === "NotAllowedError" || name === "SecurityError"
        ? "Camera permission denied. Allow camera access or choose an image file."
        : name === "OverconstrainedError" || name === "NotFoundError"
          ? "Selected camera is unavailable. Choose another camera or use the default camera."
        : `Camera unavailable: ${error.message || error}`;
      setImageStatus(message, "error");
      void refreshCameraDevices({ silent: true });
    } finally {
      syncCameraControls();
    }
  }

  async function captureCameraImage() {
    if (!state.cameraActive || !state.cameraStream || !ui.cameraPreview.srcObject) {
      setImageStatus("Open camera before capturing a snapshot.", "warning");
      syncCameraControls();
      return;
    }

    const width = ui.cameraPreview.videoWidth;
    const height = ui.cameraPreview.videoHeight;
    if (!width || !height) {
      setImageStatus("Camera preview is not ready yet.", "warning");
      return;
    }

    const captureRect = getCameraCaptureRect(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(captureRect.outputWidth));
    canvas.height = Math.max(1, Math.round(captureRect.outputHeight));
    const context = canvas.getContext("2d");
    if (!context) {
      setImageStatus("Camera capture failed: canvas is unavailable.", "error");
      return;
    }
    context.drawImage(
      ui.cameraPreview,
      captureRect.sourceX,
      captureRect.sourceY,
      captureRect.sourceWidth,
      captureRect.sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );

    try {
      const blob = await canvasToBlob(canvas, CAMERA_CAPTURE_MIME, CAMERA_CAPTURE_QUALITY);
      const name = `camera-capture-${formatCameraTimestamp(new Date())}.jpg`;
      const ok = await setSelectedImageFromBlob(blob, name, CAMERA_CAPTURE_MIME, "Camera");
      if (ok) {
        ui.imageInput.value = "";
        stopCamera({ silent: true });
      }
    } catch (error) {
      setImageStatus(`Camera capture failed: ${error.message || error}`, "error");
      syncCameraControls();
    }
  }

  function stopCamera(options = {}) {
    const wasActive = state.cameraActive || Boolean(state.cameraStream);
    const stream = state.cameraStream;
    state.cameraStream = null;
    state.cameraActive = false;

    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    }

    if (ui.cameraPreview) {
      ui.cameraPreview.pause();
      ui.cameraPreview.srcObject = null;
    }

    if (ui.cameraPreviewFrame) {
      ui.cameraPreviewFrame.hidden = true;
    }

    resetCameraZoom();
    syncCameraControls();
    if (!options.silent && wasActive) {
      if (state.selectedImage) {
        setImageStatus(describeSelectedImage("Image selected"), "warning");
      } else {
        setImageStatus("Camera stopped. No image selected.", "ready");
      }
    }
  }

  async function setSelectedImageFromBlob(blob, name, mimeType, sourceLabel) {
    const type = mimeType || blob.type || "";
    if (!type.startsWith("image/")) {
      clearImage();
      setImageStatus("Choose an image file for Robotics-ER input.", "error");
      return false;
    }
    if (blob.size > MAX_INLINE_IMAGE_BYTES) {
      clearImage();
      setImageStatus("Image is too large for inline Gemini input. Keep it under 18 MB.", "error");
      return false;
    }

    try {
      const dataUrl = await readBlobAsDataUrl(blob);
      const comma = dataUrl.indexOf(",");
      const dimensions = await readImageDimensions(dataUrl);
      state.selectedImage = {
        name,
        mimeType: type || "image/jpeg",
        data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
        size: blob.size,
        width: dimensions.width,
        height: dimensions.height
      };
      state.selectedImageVersion += 1;
      resetDetectionOutput();
      setImageStatus(describeSelectedImage(`${sourceLabel || "Image"} image selected`), "warning");
      return true;
    } catch (error) {
      clearImage();
      setImageStatus(`Image load failed: ${error.message || error}`, "error");
      return false;
    }
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")));
      reader.addEventListener("error", () => reject(reader.error || new Error("File read failed.")));
      reader.readAsDataURL(blob);
    });
  }

  function readImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener("load", () => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) {
          reject(new Error("Image dimensions are unavailable."));
          return;
        }
        resolve({ width, height });
      }, { once: true });
      image.addEventListener("error", () => reject(new Error("Image could not be decoded.")), { once: true });
      image.src = dataUrl;
    });
  }

  function selectedImageDataUrl(image = state.selectedImage) {
    if (!image || !image.data) {
      return "";
    }
    return `data:${image.mimeType || "image/jpeg"};base64,${image.data}`;
  }

  function canvasToBlob(canvas, mimeType, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Snapshot encoding failed."));
        }
      }, mimeType, quality);
    });
  }

  function clearImage() {
    stopCamera({ silent: true });
    state.selectedImage = null;
    state.selectedImageVersion += 1;
    ui.imageInput.value = "";
    resetDetectionOutput();
    setImageStatus("No image selected. Robotics-ER works best with relevant visual context.", "ready");
    syncCameraControls();
  }

  function supportsCameraCapture() {
    return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");
  }

  function buildCameraConstraints() {
    if (state.selectedCameraDeviceId) {
      return {
        video: { deviceId: { exact: state.selectedCameraDeviceId } },
        audio: false
      };
    }
    return { video: true, audio: false };
  }

  async function refreshCameraDevices(options = {}) {
    if (!ui.cameraSelect || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      syncCameraControls();
      return;
    }
    state.cameraDevicesBusy = true;
    syncCameraControls();
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.cameraDevices = devices.filter((device) => device.kind === "videoinput" && device.deviceId);
      if (state.selectedCameraDeviceId && !state.cameraDevices.some((device) => device.deviceId === state.selectedCameraDeviceId)) {
        state.selectedCameraDeviceId = "";
      }
      renderCameraOptions();
      if (!options.silent && state.cameraDevices.length === 0) {
        setImageStatus("No camera devices found. Connect a webcam or choose an image file.", "warning");
      }
    } catch (error) {
      if (!options.silent) {
        setImageStatus(`Camera list unavailable: ${error.message || error}`, "error");
      }
    } finally {
      state.cameraDevicesBusy = false;
      syncCameraControls();
    }
  }

  function renderCameraOptions() {
    if (!ui.cameraSelect) {
      return;
    }
    const current = state.selectedCameraDeviceId;
    ui.cameraSelect.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Default camera";
    ui.cameraSelect.appendChild(defaultOption);

    state.cameraDevices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      ui.cameraSelect.appendChild(option);
    });

    ui.cameraSelect.value = state.cameraDevices.some((device) => device.deviceId === current) ? current : "";
  }

  async function handleCameraSelectionChanged() {
    if (!ui.cameraSelect) {
      return;
    }
    state.selectedCameraDeviceId = ui.cameraSelect.value;
    if (!state.cameraActive) {
      syncCameraControls();
      return;
    }

    setImageStatus("Switching camera...", "warning");
    stopCamera({ silent: true });
    await openCamera();
  }

  function syncCameraControls() {
    if (!ui.btnOpenCamera || !ui.btnCaptureCamera || !ui.btnStopCamera || !ui.cameraPreview || !ui.cameraPreviewFrame) {
      return;
    }
    const supported = supportsCameraCapture();
    const zoom = state.cameraZoom;
    const isAtMin = zoom.value <= zoom.min + 0.0001;
    const isAtMax = zoom.value >= zoom.max - 0.0001;
    ui.btnOpenCamera.disabled = !supported || state.cameraActive;
    ui.btnCaptureCamera.disabled = !supported || !state.cameraActive;
    ui.btnStopCamera.disabled = !state.cameraActive;
    if (ui.cameraSelect) {
      ui.cameraSelect.disabled = !supported || state.cameraDevicesBusy;
    }
    if (ui.btnCameraZoomOut) {
      ui.btnCameraZoomOut.disabled = !supported || !state.cameraActive || isAtMin;
    }
    if (ui.btnCameraZoomIn) {
      ui.btnCameraZoomIn.disabled = !supported || !state.cameraActive || isAtMax;
    }
    if (ui.cameraZoomValue) {
      ui.cameraZoomValue.textContent = `${zoom.value.toFixed(2)}x`;
    }
    ui.cameraPreviewFrame.hidden = !state.cameraActive;
    updateCameraPreviewZoom();
  }

  function syncDetectionControls() {
    const busy = isBusy();
    if (ui.btnDetectObjects) {
      ui.btnDetectObjects.disabled = busy || !state.geminiWorkerReady;
    }
    if (ui.btnDownloadAnnotatedImage) {
      ui.btnDownloadAnnotatedImage.disabled = busy || !state.detectionCanvasReady;
    }
  }

  function showReviewTab(tabName) {
    const nextTab = tabName === "vision" ? "vision" : "robot";
    state.activeReviewTab = nextTab;
    const items = [
      { name: "robot", button: ui.btnReviewTabRobot, panel: ui.reviewRobotPanel },
      { name: "vision", button: ui.btnReviewTabVision, panel: ui.reviewVisionPanel }
    ];

    items.forEach((item) => {
      const active = item.name === nextTab;
      if (item.button) {
        item.button.classList.toggle("is-active", active);
        item.button.setAttribute("aria-selected", active ? "true" : "false");
        item.button.tabIndex = active ? 0 : -1;
      }
      if (item.panel) {
        item.panel.hidden = !active;
      }
    });

    if (nextTab === "robot" && state.robotEditor) {
      window.requestAnimationFrame(() => state.robotEditor.refresh());
    }
    if (nextTab === "vision" && state.detectionResult && state.detectionCanvasReady) {
      window.requestAnimationFrame(() => {
        void drawDetectionCanvas(state.detectionResult)
          .catch(() => {
            state.detectionCanvasReady = false;
          })
          .finally(() => {
            syncDetectionControls();
          });
      });
    }
    if (state.preview3d && typeof state.preview3d.resize === "function") {
      window.requestAnimationFrame(() => state.preview3d.resize());
    }
  }

  function showImageSourceTab(tabName) {
    const nextTab = tabName === "camera" ? "camera" : "image";
    const items = [
      { name: "image", button: ui.imageSourceTabInput, panel: ui.imageSourceInputPanel },
      { name: "camera", button: ui.imageSourceTabCamera, panel: ui.imageSourceCameraPanel }
    ];

    items.forEach((item) => {
      const active = item.name === nextTab;
      if (item.button) {
        item.button.classList.toggle("is-active", active);
        item.button.setAttribute("aria-selected", active ? "true" : "false");
        item.button.tabIndex = active ? 0 : -1;
      }
      if (item.panel) {
        item.panel.hidden = !active;
      }
    });

    state.activeImageSourceTab = nextTab;
    if (nextTab === "camera" && ui.cameraPreviewFrame && !state.cameraActive) {
      ui.cameraPreviewFrame.hidden = true;
    }
    try {
      localStorage.setItem(GEMINI_IMAGE_SOURCE_TAB_STORAGE_KEY, nextTab);
    } catch (error) {
      // Optional persistence.
    }
  }

  function wireTablistKeyboard(items, activate) {
    const activeItems = items.filter((item) => item.button);
    if (activeItems.length === 0) {
      return;
    }

    activeItems.forEach((item, index) => {
      item.button.addEventListener("keydown", (event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          activate(item.name);
          return;
        }

        let nextIndex = -1;
        if (event.key === "ArrowRight") {
          nextIndex = (index + 1) % activeItems.length;
        } else if (event.key === "ArrowLeft") {
          nextIndex = (index - 1 + activeItems.length) % activeItems.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = activeItems.length - 1;
        } else {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        const nextItem = activeItems[nextIndex];
        nextItem.button.focus();
        activate(nextItem.name);
      });
    });
  }

  function setArmConsoleCollapsed(nextCollapsed) {
    const collapsed = Boolean(nextCollapsed);
    state.armConsoleCollapsed = collapsed;
    if (ui.armConsoleToggle) {
      const label = `${collapsed ? "Show" : "Hide"} Robot Console`;
      ui.armConsoleToggle.setAttribute("aria-expanded", String(!collapsed));
      ui.armConsoleToggle.setAttribute("aria-label", label);
      ui.armConsoleToggle.title = label;
      ui.armConsoleToggle.dataset.hint = label;
    }
    if (ui.armConsolePanel) {
      ui.armConsolePanel.hidden = collapsed;
    }
    if (ui.armConsoleToggleIcon && window.lucide) {
      ui.armConsoleToggleIcon.setAttribute("data-lucide", collapsed ? "chevron-down" : "chevron-up");
      lucide.createIcons({ nodes: [ui.armConsoleToggleIcon] });
    }
  }

  function readStoredGeminiSplitLeft(fallback) {
    const value = readStoredPercent(GEMINI_SPLIT_LEFT_STORAGE_KEY, fallback);
    return clampGeminiSplitPanel(value, fallback);
  }

  function readStoredGeminiSplitRight(fallback) {
    return readStoredPercent(GEMINI_SPLIT_RIGHT_STORAGE_KEY, fallback);
  }

  function clampGeminiSplitPanel(value, fallback) {
    const numeric = Number(value);
    const fallbackValue = Number.isFinite(Number(fallback))
      ? Number(fallback)
      : GEMINI_SPLIT_PANEL_MIN_PERCENT;
    return clampNumber(
      Number.isFinite(numeric) ? numeric : fallbackValue,
      GEMINI_SPLIT_PANEL_MIN_PERCENT,
      GEMINI_SPLIT_PANEL_MAX_PERCENT
    );
  }

  function readStoredPercent(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === "") {
        return fallback;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return fallback;
      }
      return parsed;
    } catch (error) {
      return fallback;
    }
  }

  function readStoredImageSourceTab(fallback) {
    let raw = "";
    try {
      raw = localStorage.getItem(GEMINI_IMAGE_SOURCE_TAB_STORAGE_KEY) || "";
    } catch (error) {
      return fallback || "image";
    }
    if (raw === "camera") {
      return "camera";
    }
    return "image";
  }

  function wireSplitters() {
    document.querySelectorAll("[data-gemini-splitter]").forEach(function(splitter) {
      splitter.addEventListener("pointerdown", handleSplitterPointerDown);
      splitter.addEventListener("pointermove", handleSplitterPointerMove);
      splitter.addEventListener("pointerup", endSplitterDrag);
      splitter.addEventListener("pointercancel", endSplitterDrag);
      splitter.addEventListener("lostpointercapture", endSplitterDrag);
      splitter.addEventListener("keydown", handleSplitterKeydown);
    });
    document.addEventListener("pointermove", handleSplitterPointerMove);
    document.addEventListener("pointerup", endSplitterDrag);
    document.addEventListener("pointercancel", endSplitterDrag);
  }

  function applyGeminiSplitLayout() {
    const normalized = normalizeGeminiSplits(
      readStoredGeminiSplitLeft(state.geminiSplitLeftPercent),
      readStoredGeminiSplitRight(state.geminiSplitRightPercent)
    );
    state.geminiSplitLeftPercent = normalized.left;
    state.geminiSplitRightPercent = normalized.right;
    if (ui.geminiSplitContainer) {
      ui.geminiSplitContainer.style.setProperty("--gemini-split-left", `${state.geminiSplitLeftPercent}%`);
      ui.geminiSplitContainer.style.setProperty("--gemini-split-mid", `${state.geminiSplitRightPercent}%`);
    }
    updateSplitterA11y();
  }

  function setGeminiSplit(left, right, options = {}) {
    const next = normalizeGeminiSplits(left, right);
    state.geminiSplitLeftPercent = next.left;
    state.geminiSplitRightPercent = next.right;
    if (ui.geminiSplitContainer) {
      ui.geminiSplitContainer.style.setProperty("--gemini-split-left", `${state.geminiSplitLeftPercent}%`);
      ui.geminiSplitContainer.style.setProperty("--gemini-split-mid", `${state.geminiSplitRightPercent}%`);
    }
    updateSplitterA11y();
    if (options.persist !== false) {
      persistGeminiSplitLayout();
    }
    scheduleSplitResizeRefresh();
  }

  function scheduleSplitResizeRefresh() {
    if (state.splitResizeRefreshQueued) {
      return;
    }
    state.splitResizeRefreshQueued = true;
    window.requestAnimationFrame(() => {
      state.splitResizeRefreshQueued = false;
      refreshEditor();
    });
  }

  function persistGeminiSplitLayout() {
    try {
      localStorage.setItem(GEMINI_SPLIT_LEFT_STORAGE_KEY, String(state.geminiSplitLeftPercent));
      localStorage.setItem(GEMINI_SPLIT_RIGHT_STORAGE_KEY, String(state.geminiSplitRightPercent));
    } catch (error) {
      // Optional.
    }
  }

  function normalizeGeminiSplits(left, right) {
    let leftPercent = clampGeminiSplitPanel(left);
    let rightPercent = Number.isFinite(Number(right)) ? Number(right) : GEMINI_SPLIT_DEFAULT_RIGHT_SPLIT;
    leftPercent = clampNumber(
      leftPercent,
      GEMINI_SPLIT_PANEL_MIN_PERCENT,
      Math.min(GEMINI_SPLIT_PANEL_MAX_PERCENT, 100 - GEMINI_SPLIT_PANEL_MIN_PERCENT)
    );
    rightPercent = clampNumber(
      rightPercent,
      leftPercent + GEMINI_SPLIT_PANEL_MIN_PERCENT,
      leftPercent + GEMINI_SPLIT_PANEL_MAX_PERCENT
    );
    rightPercent = clampNumber(
      rightPercent,
      100 - GEMINI_SPLIT_PANEL_MAX_PERCENT,
      100 - GEMINI_SPLIT_PANEL_MIN_PERCENT
    );
    leftPercent = clampNumber(
      leftPercent,
      rightPercent - GEMINI_SPLIT_PANEL_MAX_PERCENT,
      rightPercent - GEMINI_SPLIT_PANEL_MIN_PERCENT
    );
    return {
      left: Math.round(leftPercent * 10) / 10,
      right: Math.round(rightPercent * 10) / 10
    };
  }

  function updateSplitterA11y() {
    const leftPanel = formatSplitPercent(state.geminiSplitLeftPercent);
    const rightPanel = formatSplitPercent(state.geminiSplitRightPercent);
    const midPanel = formatSplitPercent(state.geminiSplitRightPercent - state.geminiSplitLeftPercent);

    if (ui.leftSplitter) {
      const min = GEMINI_SPLIT_PANEL_MIN_PERCENT;
      const max = Math.min(
        GEMINI_SPLIT_PANEL_MAX_PERCENT,
        state.geminiSplitRightPercent - GEMINI_SPLIT_PANEL_MIN_PERCENT
      );
      ui.leftSplitter.setAttribute("aria-valuemin", String(min));
      ui.leftSplitter.setAttribute("aria-valuemax", String(max));
      ui.leftSplitter.setAttribute("aria-valuenow", String(leftPanel));
      ui.leftSplitter.setAttribute("aria-valuetext", `Gemini control ${leftPanel} percent`);
    }

    if (ui.rightSplitter) {
      const min = Math.max(
        state.geminiSplitLeftPercent + GEMINI_SPLIT_PANEL_MIN_PERCENT,
        100 - GEMINI_SPLIT_PANEL_MAX_PERCENT
      );
      const max = Math.min(
        state.geminiSplitLeftPercent + GEMINI_SPLIT_PANEL_MAX_PERCENT,
        100 - GEMINI_SPLIT_PANEL_MIN_PERCENT
      );
      ui.rightSplitter.setAttribute("aria-valuemin", String(min));
      ui.rightSplitter.setAttribute("aria-valuemax", String(max));
      ui.rightSplitter.setAttribute("aria-valuenow", String(rightPanel));
      ui.rightSplitter.setAttribute("aria-valuetext", `Gemini review ${midPanel} percent`);
    }
  }

  function formatSplitPercent(value) {
    return String(Math.round(Number(value) * 10) / 10);
  }

  function splitterPointerPosition(event) {
    const container = ui.geminiSplitContainer;
    if (!container) {
      return null;
    }
    const bounds = container.getBoundingClientRect();
    if (!bounds.width) {
      return null;
    }
    return (event.clientX - bounds.left) / bounds.width * 100;
  }

  function handleSplitterPointerDown(event) {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    const splitter = event.currentTarget;
    const key = splitter.getAttribute("data-gemini-splitter");
    if (key !== "left" && key !== "right") {
      return;
    }
    state.activeSplitter = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startLeft: state.geminiSplitLeftPercent,
      startRight: state.geminiSplitRightPercent
    };
    splitter.classList.add("is-active");
    if (splitter.setPointerCapture) {
      splitter.setPointerCapture(event.pointerId);
    }
    document.body.classList.add("is-resizing-gemini");
    document.body.classList.add("is-resizing-gemini--vertical");
    event.preventDefault();
    event.stopPropagation();
  }

  function handleSplitterPointerMove(event) {
    if (!state.activeSplitter) {
      return;
    }
    if (
      Number.isFinite(state.activeSplitter.pointerId) &&
      Number.isFinite(event.pointerId) &&
      event.pointerId !== state.activeSplitter.pointerId
    ) {
      return;
    }
    const percent = splitterPointerPosition(event);
    if (percent === null) {
      return;
    }
    const next = state.activeSplitter.key;
    if (next !== "left" && next !== "right") {
      return;
    }
    if (next === "left") {
      const leftOffset = percent;
      const newRight = state.geminiSplitRightPercent;
      setGeminiSplit(leftOffset, newRight, { persist: false });
    } else {
      const newRight = percent;
      setGeminiSplit(state.geminiSplitLeftPercent, newRight, { persist: false });
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function endSplitterDrag(event) {
    if (!state.activeSplitter) {
      return;
    }
    if (
      Number.isFinite(state.activeSplitter.pointerId) &&
      event &&
      Number.isFinite(event.pointerId) &&
      event.pointerId !== state.activeSplitter.pointerId
    ) {
      return;
    }
    const activeSplitterNode = document.querySelector(`[data-gemini-splitter="${state.activeSplitter.key}"]`);
    if (activeSplitterNode) {
      activeSplitterNode.classList.remove("is-active");
      if (event && event.pointerId !== undefined && activeSplitterNode.hasPointerCapture && activeSplitterNode.hasPointerCapture(event.pointerId)) {
        activeSplitterNode.releasePointerCapture(event.pointerId);
      }
    }
    persistGeminiSplitLayout();
    state.activeSplitter = null;
    document.body.classList.remove("is-resizing-gemini", "is-resizing-gemini--vertical");
    scheduleSplitResizeRefresh();
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleSplitterKeydown(event) {
    const key = event.key;
    const isArrow = key === "ArrowLeft" || key === "ArrowRight";
    if (!isArrow && key !== "Home" && key !== "End") {
      return;
    }
    const splitter = event.currentTarget.getAttribute("data-gemini-splitter");
    let nextLeft = state.geminiSplitLeftPercent;
    let nextRight = state.geminiSplitRightPercent;
    const step = event.shiftKey ? 10 : 1;
    if (key === "Home") {
      if (splitter === "left") {
        nextLeft = GEMINI_SPLIT_PANEL_MIN_PERCENT;
      } else {
        nextRight = state.geminiSplitLeftPercent + GEMINI_SPLIT_PANEL_MIN_PERCENT;
      }
    } else if (key === "End") {
      if (splitter === "left") {
        nextLeft = Math.min(
          state.geminiSplitRightPercent - GEMINI_SPLIT_PANEL_MIN_PERCENT,
          100 - GEMINI_SPLIT_PANEL_MAX_PERCENT
        );
      } else {
        nextRight = 100 - GEMINI_SPLIT_PANEL_MIN_PERCENT;
      }
    } else if (key === "ArrowLeft") {
      if (splitter === "left") {
        nextLeft = state.geminiSplitLeftPercent - step;
      } else {
        nextRight = state.geminiSplitRightPercent - step;
      }
    } else {
      if (splitter === "left") {
        nextLeft = state.geminiSplitLeftPercent + step;
      } else {
        nextRight = state.geminiSplitRightPercent + step;
      }
    }
    setGeminiSplit(nextLeft, nextRight, { persist: true });
    event.preventDefault();
    event.stopPropagation();
  }

  async function configureCameraZoom(stream) {
    resetCameraZoom();
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    const capabilities = track && typeof track.getCapabilities === "function" ? track.getCapabilities() : null;
    const zoomCapability = capabilities && capabilities.zoom ? capabilities.zoom : null;
    const min = Number(zoomCapability && zoomCapability.min);
    const max = Number(zoomCapability && zoomCapability.max);
    const step = Number(zoomCapability && zoomCapability.step);
    const settings = track && typeof track.getSettings === "function" ? track.getSettings() : null;
    const currentZoom = Number(settings && settings.zoom);

    if (track && Number.isFinite(min) && Number.isFinite(max) && max > min) {
      state.cameraZoom.mode = "hardware";
      state.cameraZoom.min = min;
      state.cameraZoom.max = max;
      state.cameraZoom.step = Number.isFinite(step) && step > 0 ? step : DIGITAL_CAMERA_ZOOM_STEP;
      state.cameraZoom.value = clampCameraZoom(Number.isFinite(currentZoom) ? currentZoom : min);
      try {
        await applyHardwareCameraZoom(state.cameraZoom.value);
      } catch (error) {
        useDigitalCameraZoom(state.cameraZoom.value);
      }
    } else {
      useDigitalCameraZoom(DIGITAL_CAMERA_ZOOM_MIN);
    }

    syncCameraControls();
  }

  async function applyCameraZoom(delta) {
    if (!state.cameraActive) {
      syncCameraControls();
      return;
    }

    const nextZoom = clampCameraZoom(state.cameraZoom.value + delta);
    if (Math.abs(nextZoom - state.cameraZoom.value) < 0.0001) {
      syncCameraControls();
      return;
    }

    if (state.cameraZoom.mode === "hardware") {
      try {
        await applyHardwareCameraZoom(nextZoom);
        state.cameraZoom.value = nextZoom;
      } catch (error) {
        useDigitalCameraZoom(nextZoom);
        setImageStatus("Hardware zoom was unavailable. Using digital zoom for this camera.", "warning");
      }
    } else {
      state.cameraZoom.value = nextZoom;
    }

    syncCameraControls();
  }

  async function applyHardwareCameraZoom(value) {
    const track = getActiveCameraTrack();
    if (!track || typeof track.applyConstraints !== "function") {
      throw new Error("Camera track does not support zoom constraints.");
    }
    await track.applyConstraints({ advanced: [{ zoom: value }] });
  }

  function getActiveCameraTrack() {
    if (!state.cameraStream || typeof state.cameraStream.getVideoTracks !== "function") {
      return null;
    }
    return state.cameraStream.getVideoTracks()[0] || null;
  }

  function useDigitalCameraZoom(value) {
    state.cameraZoom.mode = "digital";
    state.cameraZoom.min = DIGITAL_CAMERA_ZOOM_MIN;
    state.cameraZoom.max = DIGITAL_CAMERA_ZOOM_MAX;
    state.cameraZoom.step = DIGITAL_CAMERA_ZOOM_STEP;
    state.cameraZoom.value = clampCameraZoom(value);
  }

  function resetCameraZoom() {
    state.cameraZoom.mode = "digital";
    state.cameraZoom.min = DIGITAL_CAMERA_ZOOM_MIN;
    state.cameraZoom.max = DIGITAL_CAMERA_ZOOM_MAX;
    state.cameraZoom.step = DIGITAL_CAMERA_ZOOM_STEP;
    state.cameraZoom.value = DIGITAL_CAMERA_ZOOM_MIN;
    updateCameraPreviewZoom();
    if (ui.cameraZoomValue) {
      ui.cameraZoomValue.textContent = `${state.cameraZoom.value.toFixed(2)}x`;
    }
  }

  function clampCameraZoom(value) {
    const min = Number.isFinite(state.cameraZoom.min) ? state.cameraZoom.min : DIGITAL_CAMERA_ZOOM_MIN;
    const max = Number.isFinite(state.cameraZoom.max) ? state.cameraZoom.max : DIGITAL_CAMERA_ZOOM_MAX;
    const step = Number.isFinite(state.cameraZoom.step) && state.cameraZoom.step > 0
      ? state.cameraZoom.step
      : DIGITAL_CAMERA_ZOOM_STEP;
    const raw = Number.isFinite(Number(value)) ? Number(value) : min;
    const clamped = Math.min(max, Math.max(min, raw));
    const stepped = min + (Math.round((clamped - min) / step) * step);
    return Number(Math.min(max, Math.max(min, stepped)).toFixed(2));
  }

  function updateCameraPreviewZoom() {
    if (!ui.cameraPreview) {
      return;
    }
    const zoom = state.cameraZoom.mode === "digital" && state.cameraActive ? state.cameraZoom.value : DIGITAL_CAMERA_ZOOM_MIN;
    ui.cameraPreview.style.transform = `scale(${zoom})`;
  }

  function getCameraCaptureRect(videoWidth, videoHeight) {
    const frameWidth = ui.cameraPreviewFrame && ui.cameraPreviewFrame.clientWidth ? ui.cameraPreviewFrame.clientWidth : 16;
    const frameHeight = ui.cameraPreviewFrame && ui.cameraPreviewFrame.clientHeight ? ui.cameraPreviewFrame.clientHeight : 9;
    const frameAspect = frameWidth > 0 && frameHeight > 0 ? frameWidth / frameHeight : 16 / 9;
    const videoAspect = videoWidth / videoHeight;
    let baseWidth = videoWidth;
    let baseHeight = videoHeight;
    let baseX = 0;
    let baseY = 0;

    if (videoAspect > frameAspect) {
      baseWidth = videoHeight * frameAspect;
      baseX = (videoWidth - baseWidth) / 2;
    } else if (videoAspect < frameAspect) {
      baseHeight = videoWidth / frameAspect;
      baseY = (videoHeight - baseHeight) / 2;
    }

    const digitalZoom = state.cameraZoom.mode === "digital"
      ? Math.max(DIGITAL_CAMERA_ZOOM_MIN, state.cameraZoom.value)
      : DIGITAL_CAMERA_ZOOM_MIN;
    const sourceWidth = baseWidth / digitalZoom;
    const sourceHeight = baseHeight / digitalZoom;
    return {
      sourceX: baseX + ((baseWidth - sourceWidth) / 2),
      sourceY: baseY + ((baseHeight - sourceHeight) / 2),
      sourceWidth,
      sourceHeight,
      outputWidth: baseWidth,
      outputHeight: baseHeight
    };
  }

  function describeSelectedImage(prefix) {
    if (!state.selectedImage) {
      return "No image selected. Robotics-ER works best with relevant visual context.";
    }
    const dimensions = state.selectedImage.width && state.selectedImage.height
      ? `, ${state.selectedImage.width}x${state.selectedImage.height}px`
      : "";
    return `${prefix}: ${state.selectedImage.name} (${Math.round(state.selectedImage.size / 1024)} KB${dimensions}). Avoid identifiable people unless consent is handled.`;
  }

  function formatCameraTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("") + "-" + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join("");
  }

  function resolveSelectedModel() {
    return ui.modelSelect.value;
  }

  function syncEditorModelFromSelect() {
    const selectedModel = resolveSelectedModel();
    if (!selectedModel) {
      return;
    }

    const code = getEditorValue();
    const nextCode = code.replace(/(\bmodel\s*=\s*)(["'])(.*?)(\2)/, (match, prefix, quote) => {
      const escapedModel = selectedModel
        .replace(/\\/g, "\\\\")
        .replace(new RegExp(quote, "g"), `\\${quote}`);
      return `${prefix}${quote}${escapedModel}${quote}`;
    });

    if (nextCode === code) {
      return;
    }

    if (state.editor) {
      const cursor = state.editor.getCursor();
      const scrollInfo = state.editor.getScrollInfo();
      state.editor.setValue(nextCode);
      state.editor.setCursor(cursor);
      state.editor.scrollTo(scrollInfo.left, scrollInfo.top);
    } else {
      ui.pythonEditor.value = nextCode;
    }
  }

  function cancelGeminiWork(message) {
    if (state.apiAbortController) {
      state.apiAbortController.abort();
    }
    if (state.pendingGeminiPython) {
      window.clearTimeout(state.pendingGeminiPython.timeoutId);
      state.pendingGeminiPython.reject(new Error(message || "Gemini Python stopped"));
      state.pendingGeminiPython = null;
      state.geminiWorkerReady = false;
      if (state.geminiWorker) {
        state.geminiWorker.terminate();
        state.geminiWorker = null;
      }
      createGeminiWorker();
    }
    state.apiBusy = false;
    setStatus(message || "Gemini work canceled");
    updateRunControls();
  }

  async function handleConnectToggle() {
    if (!isArduinoActive()) {
      setStatus(activeRobotId() === "so101_follower" ? "SO-101 hardware uses the local bridge workflow." : "LeKiwi is simulation-only in Tier 1.");
      syncConnectButton();
      return;
    }
    if (state.serial.isConnected()) {
      try {
        await parkBeforeDisconnect();
        await state.serial.disconnect();
        setStatus("Serial disconnected");
      } catch (error) {
        setStatus(`Disconnect failed: ${error.message}`);
      }
      return;
    }

    ui.statusDot.classList.add("is-connecting");
    ui.statusText.textContent = "Connecting serial device...";
    try {
      setStatus("Requesting serial port (USB/Bluetooth)...");
      await state.serial.connect();
      setStatus("Connected. Waiting for READY...");
      try {
        await state.serial.waitForReady(3000);
      } catch (readyError) {
        appendSerial("SYS", "READY not received within 3s");
      }
      await state.serial.attachAll();
      const profileOk = await ensureFirmwareProfileCompatible("gemini-draft-connect");
      if (!profileOk) {
        return;
      }
      try {
        const positions = await state.serial.queryPositions();
        if (Array.isArray(positions)) {
          applyAngles(positions, { source: "connect-query" });
        }
      } catch (queryError) {
        appendSerial("SYS", `Position sync failed: ${queryError.message}`);
      }
      if (!state.motorsEnabled) {
        await state.serial.emergencyStop();
        setStatus("Serial connected; motors disabled");
      } else {
        setStatus("Serial connected and synchronized");
      }
    } catch (error) {
      setStatus(`Connect failed: ${error.message}`);
      ui.statusDot.classList.remove("is-connecting");
    }
  }

  async function parkBeforeDisconnect() {
    if (!state.serial.isConnected() || state.runner.isRunning() || !state.motorsEnabled || state.firmwareMismatch) {
      return false;
    }
    try {
      setStatus("Moving to safe park pose before disconnect...");
      await state.serial.attachAll();
      for (let servo = 0; servo < HOME_ANGLES.length; servo += 1) {
        await state.serial.moveServo(servo, clampAngle(servo, HOME_ANGLES[servo]), DISCONNECT_PARK_SPEED);
      }
      applyAngles(HOME_ANGLES, { source: "disconnect-park" });
      return true;
    } catch (error) {
      appendSerial("SYS", `Safe park before disconnect failed: ${error.message}`);
      return false;
    }
  }

  async function handleHome() {
    if (!isArduinoActive()) {
      if (NS.RobotRuntime) {
        NS.RobotRuntime.home();
        applyAngles(NS.RobotRuntime.getJointArray());
      } else {
        applyAngles(getActiveHomeAngles());
      }
      setStatus(`${activeManifest().shortName || activeManifest().name} moved to home pose`);
      return;
    }
    if (state.serial.isConnected() && !ensureMotionAllowed()) {
      return;
    }
    try {
      if (state.serial.isConnected()) {
        await state.serial.home();
      }
      applyAngles(HOME_ANGLES, { source: "home" });
      setStatus("Moved to home position");
    } catch (error) {
      setStatus(`Home failed: ${error.message}`);
    }
  }

  async function handleEmergencyStop() {
    cancelGeminiWork("Gemini work stopped by emergency stop");
    terminateRobotPythonRun("Robot Python stopped by emergency stop");
    state.runner.stop();
    try {
      if (state.serial.isConnected()) {
        await state.serial.emergencyStop();
      }
      await setMotorsEnabled(false, { sendCommand: false });
      setStatus("Emergency stop triggered");
    } catch (error) {
      setStatus(`Emergency stop failed: ${error.message}`);
    }
  }

  async function handlePauseResume() {
    if (!state.runner.isRunning()) {
      return;
    }
    if (state.runner.isPaused()) {
      setStatus("Resuming program...");
      await state.runner.resume();
    } else {
      setStatus("Pausing program...");
      await state.runner.pause();
    }
    updateRunControls();
  }

  async function handleStop() {
    if (state.pendingGeminiPython || state.apiBusy) {
      cancelGeminiWork("Gemini work stopped");
      return;
    }
    if (state.pendingRobotPython) {
      terminateRobotPythonRun("Robot Python stopped");
      setStatus("Robot Python stopped");
      return;
    }
    if (!state.runner.isRunning()) {
      return;
    }
    try {
      setStatus("Stopping program...");
      await state.runner.stop({ mode: "immediate" });
      await waitForRunnerIdle(1800);
      setStatus("Program stopped");
    } catch (error) {
      setStatus(`Stop failed: ${error.message}`);
    } finally {
      updateRunControls();
    }
  }

  function terminateRobotPythonRun(message) {
    if (state.pendingRobotPython) {
      window.clearTimeout(state.pendingRobotPython.timeoutId);
      state.pendingRobotPython.reject(new Error(message || "Robot Python stopped"));
      state.pendingRobotPython = null;
    }
    state.robotWorkerReady = false;
    if (state.robotWorker) {
      state.robotWorker.terminate();
      state.robotWorker = null;
    }
    createRobotWorker();
    updateRunControls();
  }

  async function setMotorsEnabled(enabled, options = {}) {
    const requested = Boolean(enabled);
    if (requested && !isArduinoActive()) {
      state.motorsEnabled = false;
      syncMotorsToggleUi();
      setStatus(activeRobotId() === "so101_follower" ? "SO-101 hardware uses the local bridge workflow." : "LeKiwi is simulation-only in Tier 1.");
      return;
    }
    if (requested && state.firmwareMismatch) {
      setStatus(state.firmwareMismatch.message || "Firmware mismatch detected. Motors remain disabled.");
      state.motorsEnabled = false;
      syncMotorsToggleUi();
      return;
    }

    state.motorsEnabled = requested;
    localStorage.setItem(MOTORS_STORAGE_KEY, state.motorsEnabled ? "1" : "0");
    syncMotorsToggleUi();

    if (!state.motorsEnabled && state.runner.isRunning()) {
      state.runner.stop();
    }

    if (options.sendCommand !== false && state.serial.isConnected()) {
      try {
        if (state.motorsEnabled) {
          await state.serial.attachAll();
        } else {
          await state.serial.emergencyStop();
        }
      } catch (error) {
        setStatus(`Motor toggle failed: ${error.message}`);
      }
    }

    setStatus(state.motorsEnabled ? "Motors enabled" : "Motors disabled");
  }

  function ensureMotionAllowed() {
    if (state.firmwareMismatch) {
      setStatus(state.firmwareMismatch.message || "Firmware mismatch detected. Reflash required.");
      return false;
    }
    if (!state.motorsEnabled) {
      setStatus("Motors are disabled. Enable Motors Enabled first.");
      return false;
    }
    return true;
  }

  async function ensureFirmwareProfileCompatible(source) {
    let profile = null;
    try {
      profile = await state.serial.getFirmwareProfile();
    } catch (error) {
      return activateFirmwareMismatch(`profile query failed: ${error.message}`, source);
    }

    const issues = [];
    const profileId = String(profile.id || "").trim();
    if (profileId !== EXPECTED_FIRMWARE_PROFILE_ID) {
      issues.push(`profile ${profileId || "(missing)"} expected ${EXPECTED_FIRMWARE_PROFILE_ID}`);
    }
    const gripperLimits = JOINT_LIMITS[5] || [25, 130];
    if (Number(profile.gripperMin) !== gripperLimits[0] || Number(profile.gripperMax) !== gripperLimits[1]) {
      issues.push(`gripper ${profile.gripperMin}..${profile.gripperMax} expected ${gripperLimits[0]}..${gripperLimits[1]}`);
    }
    if (issues.length > 0) {
      return activateFirmwareMismatch(issues.join("; "), source);
    }

    state.firmwareMismatch = null;
    appendOutput(`Firmware profile verified: ${profileId}`);
    return true;
  }

  async function activateFirmwareMismatch(reason, source) {
    const message = `Firmware mismatch detected (${reason}). Reflash required.`;
    state.firmwareMismatch = { message, source };
    await setMotorsEnabled(false, { sendCommand: false });
    try {
      if (state.serial.isConnected()) {
        await state.serial.emergencyStop({ immediate: true });
      }
    } catch (error) {
      appendSerial("SYS", `Mismatch guard stop failed: ${error.message}`);
    }
    setStatus(message);
    return false;
  }

  function appendOutput(text) {
    const value = String(text || "");
    if (!value) {
      return;
    }
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    state.outputLines.push(`[${timestamp}] ${value}`);
    while (state.outputLines.length > 180) {
      state.outputLines.shift();
    }
    renderGeminiOutput();
  }

  function geminiOutputText() {
    return state.outputLines.join("\n");
  }

  function renderGeminiOutput() {
    const text = geminiOutputText();
    ui.outputLog.textContent = text;
    ui.outputLog.scrollTop = ui.outputLog.scrollHeight;
    if (ui.outputDialogContent) {
      ui.outputDialogContent.textContent = text || "No Gemini output yet.";
    }
    syncGeminiOutputActions();
  }

  function syncGeminiOutputActions() {
    const hasOutput = state.outputLines.length > 0;
    [
      ui.btnOpenGeminiOutput,
      ui.btnCopyGeminiOutput,
      ui.btnClearGeminiOutput,
      ui.btnCopyGeminiOutputDialog
    ].forEach((button) => {
      if (button) {
        button.disabled = !hasOutput;
      }
    });
  }

  function clearGeminiOutput() {
    state.outputLines = [];
    renderGeminiOutput();
    setStatus("Gemini output cleared");
  }

  async function copyGeminiOutput() {
    const text = geminiOutputText();
    if (!text) {
      setStatus("No Gemini output to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Gemini output copied");
    } catch (error) {
      setStatus("Copy failed (clipboard permission)");
    }
  }

  function openGeminiOutputDialog() {
    renderGeminiOutput();
    if (!ui.outputDialog || ui.outputDialog.open) {
      return;
    }
    ui.outputDialog.showModal();
    if (window.lucide) {
      lucide.createIcons({ nodes: ui.outputDialog.querySelectorAll("[data-lucide]") });
    }
    if (ui.outputDialogContent) {
      ui.outputDialogContent.focus();
    }
  }

  function closeGeminiOutputDialog() {
    if (ui.outputDialog && ui.outputDialog.open) {
      ui.outputDialog.close();
    }
  }

  function appendSerial(kind, text) {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    state.serialLines.push(`[${timestamp}] ${kind}: ${text}`);
    while (state.serialLines.length > 160) {
      state.serialLines.shift();
    }
    ui.serialLog.textContent = state.serialLines.join("\n");
    ui.serialLog.scrollTop = ui.serialLog.scrollHeight;
  }

  function applyAngles(nextAngles) {
    if (!Array.isArray(nextAngles)) {
      return;
    }
    state.angles = nextAngles.slice(0, 6).map((value, index) => clampAngle(index, value));
    if (state.preview3d) {
      state.preview3d.setAngles(state.angles);
    }
    for (let servo = 0; servo < 6; servo += 1) {
      const valueEl = ui.jointValues[servo];
      if (valueEl) {
        valueEl.textContent = `${state.angles[servo]} deg`;
      }
    }
  }

  function syncPreviewVisibility() {
    const showArduino = isArduinoActive();
    if (ui.previewBody) {
      ui.previewBody.classList.toggle("is-robot-sim-active", !showArduino);
    }
    if (ui.previewSketchPanel) {
      ui.previewSketchPanel.hidden = !showArduino;
    }
    if (showArduino && state.preview3d && typeof state.preview3d.resize === "function") {
      window.requestAnimationFrame(() => state.preview3d.resize());
    }
    if (ui.robotSimPreview) {
      ui.robotSimPreview.hidden = showArduino;
      if (!showArduino && NS.RobotRuntime) {
        NS.RobotRuntime.render(ui.robotSimPreview);
      }
    }
  }

  function mark3dPreviewUnavailable() {
    const container = ui.previewSketchPanel || null;
    if (!container) {
      return;
    }
    container.classList.add("is-3d-unavailable");
    const preview = container.querySelector("[data-arm-preview-3d]");
    if (preview) {
      preview.hidden = true;
    }
    const fallbackStatus = container.querySelector("[data-arm-preview-3d-fallback-status]");
    if (fallbackStatus) {
      fallbackStatus.hidden = false;
      fallbackStatus.textContent = "3D preview unavailable.";
    }
  }

  function updateRunControls() {
    const runnerRunning = Boolean(state.runner && state.runner.isRunning());
    const runnerPaused = runnerRunning && state.runner.isPaused();
    const busy = isBusy();
    ui.btnRunGemini.disabled = busy || !state.geminiWorkerReady;
    ui.btnGenerateRobotPython.disabled = busy || !state.geminiWorkerReady;
    ui.btnCancelGemini.disabled = !(state.apiBusy || state.pendingGeminiPython);
    if (ui.btnLoadGeminiPython) {
      ui.btnLoadGeminiPython.disabled = busy;
    }
    ui.btnValidateRobotPython.disabled = busy || !state.robotWorkerReady;
    const robotCode = getRobotEditorValue();
    ui.btnRunRobotPython.disabled = busy || !state.robotWorkerReady || !robotCode.trim();
    if (ui.btnLoadRobotPython) {
      ui.btnLoadRobotPython.disabled = busy;
    }
    ui.btnCopyRobotPython.disabled = !robotCode.trim();
    ui.btnPause.disabled = !runnerRunning;
    ui.btnStop.disabled = !busy;
    if (ui.runSpinner) {
      ui.runSpinner.hidden = !state.apiBusy;
    }
    syncCameraControls();
    syncDetectionControls();
    const pauseLabel = runnerPaused ? "Resume active program" : "Pause active program";
    ui.btnPause.setAttribute("aria-label", pauseLabel);
    ui.btnPause.title = pauseLabel;
    const pauseTool = ui.btnPause.closest(".gemini-draft__tool");
    if (pauseTool) {
      pauseTool.dataset.hint = runnerPaused ? "Resume" : "Pause";
    }
    const pauseIcon = ui.btnPause.querySelector("[data-lucide]");
    if (pauseIcon && window.lucide) {
      pauseIcon.setAttribute("data-lucide", runnerPaused ? "play" : "pause");
      lucide.createIcons({ nodes: [pauseIcon] });
    }
    updateStatusIcon(
      runnerPaused ? "pause" : (busy ? "loader" : "circle-check"),
      busy && !runnerPaused,
      false,
      runnerPaused
    );
  }

  function isBusy() {
    return Boolean(
      state.apiBusy ||
      state.pendingGeminiPython ||
      state.pendingRobotPython ||
      (state.runner && state.runner.isRunning())
    );
  }

  function syncConnectButton() {
    if (!ui.btnConnect || !state.serial) {
      return;
    }
    const connected = state.serial.isConnected();
    const span = ui.btnConnect.querySelector("span");
    if (span) {
      span.textContent = !isArduinoActive()
        ? (activeRobotId() === "so101_follower" ? "Use Bridge" : "Sim Only")
        : (connected ? "Disconnect" : "Connect");
    }
    ui.btnConnect.disabled = !isArduinoActive() || !state.serial.supportsWebSerial();
    if (state.serial.supportsWebSerial && !state.serial.supportsWebSerial()) {
      ui.btnConnect.disabled = true;
    }
    const icon = ui.btnConnect.querySelector("[data-lucide]");
    if (icon && window.lucide) {
      icon.setAttribute("data-lucide", connected ? "unlink" : "plug");
      lucide.createIcons({ nodes: [icon] });
    }
  }

  function syncMotorsToggleUi() {
    if (!ui.motorsEnabled) {
      return;
    }
    ui.motorsEnabled.checked = isArduinoActive() && state.motorsEnabled;
    ui.motorsEnabled.disabled = !isArduinoActive();
    updateRunControls();
  }

  function readMotorsEnabled() {
    const raw = localStorage.getItem(MOTORS_STORAGE_KEY);
    return raw === "1" || raw === "true";
  }

  function setConnectionStatus(connected, text) {
    ui.statusDot.classList.toggle("is-connected", connected);
    ui.statusDot.classList.remove("is-connecting");
    ui.statusText.textContent = text || (connected ? "Connected" : "Disconnected");
  }

  function setStatus(text) {
    ui.programStatus.textContent = text;
  }

  function setRuntimeStatus(element, text, tone) {
    element.textContent = text;
    element.dataset.tone = tone || "ready";
  }

  function updateEffectStatus(text, tone) {
    ui.effectStatus.textContent = text;
    ui.effectStatus.dataset.tone = tone || "ready";
  }

  function updateCommandSummary(text) {
    ui.commandSummary.textContent = text || "-";
  }

  function setImageStatus(text, tone) {
    ui.imageStatus.textContent = text;
    ui.imageStatus.dataset.tone = tone || "ready";
  }

  function setDetectionStatus(text, tone) {
    if (!ui.detectionStatus) {
      return;
    }
    ui.detectionStatus.textContent = text;
    ui.detectionStatus.dataset.tone = tone || "ready";
  }

  function updateStatusIcon(iconName, isRunning, isError, isWarning) {
    if (!ui.programStatusIcon || !window.lucide) {
      return;
    }
    ui.programStatusIcon.setAttribute("data-lucide", iconName);
    ui.programStatusIcon.classList.toggle("is-running", Boolean(isRunning));
    ui.programStatusIcon.classList.toggle("is-error", Boolean(isError));
    ui.programStatusIcon.classList.toggle("is-warning", Boolean(isWarning));
    lucide.createIcons({ nodes: [ui.programStatusIcon] });
  }

  function intInRange(value, min, max, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) {
      throw new Error(`${label} must be ${min}..${max}.`);
    }
    return n;
  }

  function safePoseName(value, label) {
    const text = String(value || "").trim();
    if (!text) {
      throw new Error(`${label} name cannot be empty.`);
    }
    return text.slice(0, 40);
  }

  function clampAngle(servo, angle) {
    const limits = JOINT_LIMITS[servo] || [0, 180];
    const value = Number(angle);
    const safe = Number.isFinite(value) ? Math.round(value) : limits[0];
    return Math.min(limits[1], Math.max(limits[0], safe));
  }

  async function waitForRunnerIdle(timeoutMs) {
    const start = Date.now();
    while (state.runner && state.runner.isRunning()) {
      if (Date.now() - start >= timeoutMs) {
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }
})();
