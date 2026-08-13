(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const PICKER_EXTENSION_MAX_LENGTH = 16;

  function normalizeAccept(accept) {
    if (!accept) {
      return "";
    }
    const values = Array.isArray(accept) ? accept : String(accept).split(",");
    return Array.from(new Set(
      values
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )).join(",");
  }

  function pickerSafeExtensions(accept) {
    return normalizeAccept(accept)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.startsWith("."))
      .filter((item) => item.length <= PICKER_EXTENSION_MAX_LENGTH)
      .filter((item) => !/[\\/\s]/.test(item));
  }

  function filePickerTypes(description, accept, mimeType) {
    const extensions = pickerSafeExtensions(accept);
    if (extensions.length === 0) {
      return [];
    }

    const pickerMimeType = String(mimeType || "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
    return [{
      description: description || "RoboBuddy files",
      accept: {
        [pickerMimeType]: extensions
      }
    }];
  }

  function isCanceled(error) {
    return Boolean(error && (error.name === "AbortError" || error.name === "NotAllowedError"));
  }

  function createSaveResult(ok, extra = {}) {
    return {
      ok: Boolean(ok),
      canceled: Boolean(extra.canceled),
      method: extra.method || "",
      name: extra.name || "",
      error: extra.error || null
    };
  }

  async function saveBlobFile(blob, options = {}) {
    const suggestedName = options.suggestedName || "robobuddy-file";
    const types = filePickerTypes(options.description, options.accept, options.mimeType);

    if (options.preferPicker !== false && typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types,
          excludeAcceptAllOption: false
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return createSaveResult(true, { method: "picker", name: handle.name || suggestedName });
      } catch (error) {
        if (isCanceled(error)) {
          return createSaveResult(false, { canceled: true, method: "picker" });
        }
        return createSaveResult(false, { method: "picker", error });
      }
    }

    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = suggestedName;
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        link.remove();
      }, 1000);
      return createSaveResult(true, { method: "download", name: suggestedName });
    } catch (error) {
      return createSaveResult(false, { method: "download", error });
    }
  }

  async function saveTextFile(text, options = {}) {
    const type = options.mimeType || "text/plain;charset=utf-8";
    const blob = new Blob([String(text ?? "")], { type });
    return saveBlobFile(blob, options);
  }

  async function saveJsonFile(data, options = {}) {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    return saveTextFile(text, {
      ...options,
      mimeType: "application/json;charset=utf-8"
    });
  }

  async function readFileText(file, method, options = {}) {
    const maxBytes = Number(options.maxBytes);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && Number(file.size) > maxBytes) {
      return {
        ok: false,
        canceled: false,
        method,
        name: file.name || "",
        text: "",
        error: new Error(`File is too large. Choose a file under ${Math.round(maxBytes / 1024)} KB.`)
      };
    }

    try {
      const text = await file.text();
      return { ok: true, canceled: false, method, name: file.name || "", text };
    } catch (error) {
      return { ok: false, canceled: false, method, name: file.name || "", text: "", error };
    }
  }

  function readFromInput(options = {}) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = normalizeAccept(options.accept);
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.style.top = "0";

      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener("focus", handleWindowFocus);
        input.remove();
        resolve(result);
      };

      const handleWindowFocus = () => {
        window.setTimeout(() => {
          if (!settled && (!input.files || input.files.length === 0)) {
            finish({ ok: false, canceled: true, method: "input", name: "", text: "" });
          }
        }, 500);
      };

      input.addEventListener("change", async () => {
        const file = input.files && input.files[0] ? input.files[0] : null;
        if (!file) {
          finish({ ok: false, canceled: true, method: "input", name: "", text: "" });
          return;
        }
        finish(await readFileText(file, "input", options));
      });

      input.addEventListener("cancel", () => {
        finish({ ok: false, canceled: true, method: "input", name: "", text: "" });
      });

      document.body.appendChild(input);
      window.addEventListener("focus", handleWindowFocus);
      input.click();
    });
  }

  async function openTextFile(options = {}) {
    const types = filePickerTypes(options.description, options.accept, options.mimeType);

    if (typeof window.showOpenFilePicker === "function") {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: false,
          types,
          excludeAcceptAllOption: false
        });
        const handle = handles && handles[0] ? handles[0] : null;
        if (!handle) {
          return { ok: false, canceled: true, method: "picker", name: "", text: "" };
        }
        const file = await handle.getFile();
        return readFileText(file, "picker", options);
      } catch (error) {
        if (isCanceled(error)) {
          return { ok: false, canceled: true, method: "picker", name: "", text: "" };
        }
        return { ok: false, canceled: false, method: "picker", name: "", text: "", error };
      }
    }

    return readFromInput(options);
  }

  NS.FileWorkflows = {
    saveBlobFile,
    saveTextFile,
    saveJsonFile,
    openTextFile
  };
})();
