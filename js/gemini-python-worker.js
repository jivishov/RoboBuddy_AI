const PYODIDE_VERSION = "0.29.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.js`;

let pyodideReadyPromise = null;

function loadRuntime() {
  if (!pyodideReadyPromise) {
    pyodideReadyPromise = (async () => {
      self.postMessage({ type: "status", phase: "loading" });
      importScripts(PYODIDE_URL);
      const pyodide = await loadPyodide();
      self.postMessage({ type: "status", phase: "ready" });
      return pyodide;
    })();
  }
  return pyodideReadyPromise;
}

const RUNTIME_CODE = `
import contextlib
import io
import json
import math
import traceback
import types as _types

mode = __MODE__
response_text = __RESPONSE_TEXT__
request_limit = 1
requests = []
robot_response = ""

def _jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if hasattr(value, "to_json_dict"):
        return _jsonable(value.to_json_dict())
    if hasattr(value, "_roboadmin_json"):
        return _jsonable(value._roboadmin_json())
    return str(value)

class _GeminiResponse:
    def __init__(self, text):
        self.text = text

class _Part:
    def __init__(self, payload):
        self.payload = payload

    @classmethod
    def from_bytes(cls, data=None, mime_type="application/octet-stream"):
        if data:
            raise ValueError("Image bytes cannot be loaded inside the browser Python sandbox. Use the page image upload control.")
        return cls({"inline_data": {"mime_type": str(mime_type), "data": ""}})

    def _roboadmin_json(self):
        return self.payload

class _Config:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def _roboadmin_json(self):
        return self.kwargs

class _ThinkingConfig(_Config):
    pass

class _ToolCodeExecution(_Config):
    pass

class _Tool(_Config):
    pass

class _TypesModule:
    Part = _Part
    GenerateContentConfig = _Config
    ThinkingConfig = _ThinkingConfig
    Tool = _Tool
    ToolCodeExecution = _ToolCodeExecution

class _Models:
    def generate_content(self, model=None, contents=None, config=None, **kwargs):
        if len(requests) >= request_limit:
            raise ValueError("Only one Gemini generate_content call is supported in this lab.")
        model_text = str(model or "").strip()
        if not model_text:
            raise ValueError("generate_content requires a model.")
        request = {
            "model": model_text,
            "contents": _jsonable(contents),
            "config": _jsonable(config),
            "kwargs": _jsonable(kwargs),
        }
        requests.append(request)
        return _GeminiResponse(response_text if mode == "replay" else "")

class _Client:
    def __init__(self, *args, api_key=None, **kwargs):
        if args:
            raise ValueError("genai.Client() positional arguments are not supported in this classroom lab.")
        if api_key:
            raise ValueError("Do not put Gemini API keys in Python code. Use the session key field.")
        self.models = _Models()

genai_module = _types.SimpleNamespace(Client=_Client, types=_TypesModule())
google_module = _types.SimpleNamespace(genai=genai_module)
types_module = _TypesModule()

def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0:
        raise ImportError("Relative imports are not supported in this classroom lab.")
    if name == "google":
        return google_module
    if name == "google.genai":
        return genai_module
    if name == "math":
        return math
    raise ImportError(f"Import is not available in this classroom lab: {name}")

class _RoboAdmin:
    def use_response(self, text):
        global robot_response
        robot_response = str(text)
        return robot_response

safe_builtins = {
    "__import__": _safe_import,
    "abs": abs,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "print": print,
    "range": range,
    "round": round,
    "str": str,
    "sum": sum,
    "tuple": tuple,
}

stdout_buffer = io.StringIO()
stderr_buffer = io.StringIO()
exec_globals = {
    "__builtins__": safe_builtins,
    "genai": genai_module,
    "google": google_module,
    "math": math,
    "roboadmin": _RoboAdmin(),
}

try:
    with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
        exec(__USER_CODE__, exec_globals, exec_globals)
    __result = {
        "ok": True,
        "request": requests[0] if requests else None,
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "robotResponse": robot_response,
        "error": "",
        "traceback": "",
    }
except Exception as exc:
    __result = {
        "ok": False,
        "request": requests[0] if requests else None,
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "robotResponse": robot_response,
        "error": f"{type(exc).__name__}: {exc}",
        "traceback": traceback.format_exc(limit=6),
    }

json.dumps(__result)
`;

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  if (data.type !== "run") {
    return;
  }

  const id = data.id;
  try {
    const pyodide = await loadRuntime();
    pyodide.globals.set("__USER_CODE__", String(data.python || ""));
    pyodide.globals.set("__MODE__", data.mode === "replay" ? "replay" : "capture");
    pyodide.globals.set("__RESPONSE_TEXT__", String(data.responseText || ""));

    const resultText = await pyodide.runPythonAsync(RUNTIME_CODE);
    const result = JSON.parse(String(resultText || "{}"));
    self.postMessage({ type: "result", id, ...result });
  } catch (error) {
    self.postMessage({
      type: "result",
      id,
      ok: false,
      request: null,
      stdout: "",
      stderr: "",
      robotResponse: "",
      error: error && error.message ? error.message : String(error),
      traceback: ""
    });
  }
});

void loadRuntime();
