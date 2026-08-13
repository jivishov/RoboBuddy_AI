import { escapeHtml } from "./calculations.js";
import { EVIDENCE_BASIS_LABELS, PROVENANCE_LABELS, ROBOT_LABELS, commandLabel, labelFromId } from "./labels.js";
import { assistanceCopy } from "./instructions.js";

export function setTone(element, tone) {
  if (element) element.dataset.tone = tone || "ready";
}

export function renderCatalogRows(container, tasks, selectedId) {
  container.innerHTML = tasks.map((task) => `
    <button class="lab-task-row${task.id === selectedId ? " is-selected" : ""}" type="button" role="option"
      aria-selected="${task.id === selectedId}" data-task-id="${escapeHtml(task.id)}">
      <span class="lab-task-row__rank" data-readout>${task.rank}</span>
      <span class="lab-task-row__main">
        <strong>${escapeHtml(task.title)}</strong>
        <span>${escapeHtml(task.techniques.join(" · "))}</span>
      </span>
      <span class="lab-task-row__meta">
        <span>${escapeHtml(task.assistanceLevel)}</span>
        <span>${escapeHtml(task.complexity)}</span>
      </span>
    </button>
  `).join("");
}

export function renderCatalogDetails(container, task) {
  if (!task) {
    container.innerHTML = `<div class="lab-empty"><strong>No task selected</strong><p>Choose a robot task to inspect its mission and programming boundary.</p></div>`;
    return;
  }
  const robot = ROBOT_LABELS[task.robotId] || task.robotId;
  const base = `lab-workbench.html?robot=${encodeURIComponent(task.robotId)}&task=${encodeURIComponent(task.id)}`;
  container.innerHTML = `
    <header class="lab-detail__header">
      <span class="lab-kicker">Rank ${task.rank} · ${escapeHtml(task.assistanceLevel)}</span>
      <h2>${escapeHtml(task.title)}</h2>
      <p>${escapeHtml(task.brief)}</p>
    </header>
    <dl class="lab-definition-list">
      <div><dt>Robot</dt><dd>${escapeHtml(robot)}</dd></div>
      <div><dt>Technique basis</dt><dd>${task.techniques.map((id) => `<code>${escapeHtml(id)}</code>`).join(" ")}</dd></div>
      <div><dt>Skills</dt><dd>${task.skills.map(escapeHtml).join(", ")}</dd></div>
      <div><dt>Assistance</dt><dd>${escapeHtml(assistanceCopy(task.assistanceLevel))}</dd></div>
      <div><dt>Simulation limit</dt><dd>${escapeHtml(task.limitations)}</dd></div>
    </dl>
    <section class="lab-boundary" aria-label="Safety boundary">
      <strong>Simulation boundary</strong>
      <p>Robot-programming and procedural-technique practice only. No physical robot or real laboratory action is available.</p>
    </section>
    <div class="lab-detail__actions">
      <a class="lab-button lab-button--primary" href="${base}&language=blockly"><i data-lucide="puzzle" aria-hidden="true"></i>Open in Blockly</a>
      <a class="lab-button" href="${base}&language=python"><i data-lucide="square-code" aria-hidden="true"></i>Open in Python</a>
    </div>
  `;
  if (window.lucide) window.lucide.createIcons({ nodes: container.querySelectorAll("[data-lucide]") });
}

export function renderCheckpoints(container, definition, state) {
  container.innerHTML = definition.checkpoints.map((checkpoint, index) => {
    const status = state.completedCheckpointIds.includes(checkpoint.id) ? "complete" : index === state.checkpointIndex ? "active" : "pending";
    return `
      <li class="lab-checkpoint" data-status="${status}"${status === "active" ? ' aria-current="step"' : ""}>
        <span class="lab-checkpoint__index" data-readout>${String(index + 1).padStart(2, "0")}</span>
        <span><strong>${escapeHtml(checkpoint.label)}</strong><small>${escapeHtml(Array.isArray(checkpoint.sourceBasis) ? checkpoint.sourceBasis.map((basis) => EVIDENCE_BASIS_LABELS[basis] || basis).join(" + ") : EVIDENCE_BASIS_LABELS[checkpoint.sourceBasis] || checkpoint.sourceBasis)}</small></span>
        <span class="lab-checkpoint__state">${status}</span>
      </li>
    `;
  }).join("");
}

export function renderEvidence(container, evidence) {
  const items = evidence.slice().reverse();
  container.innerHTML = items.length ? items.map((entry) => `
    <li class="lab-evidence" data-provenance="${escapeHtml(entry.category)}">
      <span class="lab-provenance">${escapeHtml(PROVENANCE_LABELS[entry.category] || entry.category)}</span>
      <strong>${escapeHtml(entry.label)}</strong>
      <span>${escapeHtml(entry.value)}</span>
    </li>
  `).join("") : `<li class="lab-empty">No evidence recorded.</li>`;
}

export function renderApparatus(container, apparatus) {
  container.innerHTML = apparatus.filter((item) => !item.sceneOnly).map((item) => {
    const location = item.heldBy ? `Held by ${labelFromId(item.heldBy)}` : item.insertedInto ? `Inserted in ${labelFromId(item.insertedInto)}` : labelFromId(item.currentZone);
    return `
      <tr>
        <th scope="row">${escapeHtml(item.label)}</th>
        <td>${escapeHtml(location)}</td>
        <td>${escapeHtml(item.contentsCategory)}</td>
        <td>${escapeHtml(item.state.temperature)}</td>
        <td>${escapeHtml([item.state.cleanliness, item.state.contamination, item.state.calibration, item.state.connection].filter((value) => value && value !== "not applicable").join(" · "))}</td>
        <td>${escapeHtml(item.transferState)}</td>
      </tr>
    `;
  }).join("");
}

export function renderCommandLog(container, entries) {
  const items = entries.slice(-8).reverse();
  container.innerHTML = items.length ? items.map((entry) => `
    <li data-tone="${entry.ok ? "ready" : "error"}">
      <code>${String(entry.index).padStart(2, "0")}</code>
      <span><strong>${escapeHtml(commandLabel(entry.command))}</strong><small>${escapeHtml(entry.message)}</small></span>
      <span>${escapeHtml(entry.code)}</span>
    </li>
  `).join("") : `<li class="lab-empty">Run a command to populate the execution trace.</li>`;
}

export function renderLoadingRows(container, count = 7) {
  container.innerHTML = Array.from({ length: count }, (_, index) => `
    <div class="lab-task-skeleton" aria-hidden="true"><span>${String(index + 1).padStart(2, "0")}</span><i></i><i></i></div>
  `).join("");
}

export function announce(element, message) {
  if (!element) return;
  element.textContent = "";
  window.requestAnimationFrame(() => { element.textContent = message; });
}
