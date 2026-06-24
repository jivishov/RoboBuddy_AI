# AGENTS.md

## Repository

- Local repository address: `E:\Projects\RoboBuddy_AI`
- This is the static GitHub Pages version of RoboBuddy.
- Browser entry points: `index.html`, `python.html`, `gemini.html`, `python-docs.html`.

## Logo Invariant

- The website logo must stay constant across all pages.
- Use `assets/logo.png` for the header logo and favicon.
- Do not reintroduce scheduled, date-based, time-based, or audience-based logo rotation.
- Do not re-add code or attributes named like `scheduled-logo`, `data-scheduled-logo`, `LOGO_SCHEDULE`, or `resolveLogoSrc`.

## General LLM Integration Rules

- Keep provider/model capabilities centralized. Prefer a model catalog module over scattered string equality checks.
- Keep dependencies unpinned unless a repo explicitly requires pins. Do not add hidden pins elsewhere after simplifying `requirements.txt`.
- Runtime-only attachment data must stay server-side. Never serialize local file paths, SHA256 hashes, or vendor `file_id` values into client-visible state.
- Stage attachments locally first, upload lazily on the first provider call that needs them, cache remote file handles for reuse, and delete both local files and remote handles on reset/cleanup.
- For the web projects never check for mobile responsive formats, unless explicitly specified in the prompt to do so. Always implement responsiveness for tablet, laptop screens and above. Mobile screens are only when specified.
- After every plan is built in the plan mode critically review the plan once then revise and refine it for fidelity and applicability.
- After every code writing is finalized review the code once then revise and refine it for fidelity and applicability.

## OpenAI Rules

- Prefer the Responses API for new work.
- For file inputs, use the Files API with `purpose="user_data"`.
- When a file is attached, place `{"type": "input_file", "file_id": ...}` before the user text block in the Responses API input.
- Reuse the same cached OpenAI `file_id` across subsequent rounds instead of re-uploading.
- Apply reasoning controls from the model catalog, not hard-coded conditionals.
- The GPT Pro model is the only OpenAI model in this workspace that requires an explicit UI confirmation gate before execution.

## Anthropic Rules

- Use plain `client.messages.create(...)` only when no file is attached.
- When a file is attached, use `client.beta.files.upload(...)` followed by `client.beta.messages.create(...)`.
- File-analysis requests should use:
  - `betas=["files-api-2025-04-14", "code-execution-2025-08-25"]`
  - `tools=[{"name":"code_execution","type":"code_execution_20250825","allowed_callers":["direct"]}]`
  - a user `content` array with `{"type":"container_upload","file_id": ...}` before the text block
- For Claude 4.6 and above models, use adaptive thinking plus catalog-driven effort values.
- Do not send `temperature`, `top_p`, or `top_k` with thinking-enabled Anthropic requests.
- For Haiku fallback flows, keep the simple enabled/disabled thinking shape with a fixed hidden budget.
