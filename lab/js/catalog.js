import { ROBOT_LABELS } from "./labels.js";
import { announce, renderCatalogDetails, renderCatalogRows, renderLoadingRows } from "./ui.js";

const elements = {
  filters: document.getElementById("labRobotFilters"),
  search: document.getElementById("labTaskSearch"),
  list: document.getElementById("labTaskList"),
  details: document.getElementById("labTaskDetails"),
  resultCount: document.getElementById("labResultCount"),
  live: document.getElementById("labCatalogLive"),
  error: document.getElementById("labCatalogError")
};

const params = new URLSearchParams(window.location.search);
const state = {
  catalog: null,
  robotId: params.get("robot") || "arduino_arm",
  selectedId: params.get("task") || "",
  query: params.get("q") || ""
};

function visibleTasks() {
  if (!state.catalog) return [];
  const query = state.query.trim().toLowerCase();
  return state.catalog.tasks
    .filter((task) => task.robotId === state.robotId)
    .filter((task) => !query || [task.title, task.brief, task.learningObjective, task.supportedFidelity, task.apiLevel, task.migrationClass, ...(task.provenanceLabels || [])].filter(Boolean).join(" ").toLowerCase().includes(query))
    .sort((a, b) => a.rank - b.rank);
}

function selectedTask(tasks = visibleTasks()) {
  return tasks.find((task) => task.id === state.selectedId) || tasks[0] || null;
}

function writeUrl() {
  const next = new URL(window.location.href);
  next.searchParams.set("robot", state.robotId);
  if (state.selectedId) next.searchParams.set("task", state.selectedId);
  else next.searchParams.delete("task");
  if (state.query) next.searchParams.set("q", state.query);
  else next.searchParams.delete("q");
  window.history.replaceState({}, "", next);
}

function render() {
  const tasks = visibleTasks();
  const selected = selectedTask(tasks);
  state.selectedId = selected ? selected.id : "";
  elements.filters.querySelectorAll("button[data-robot-id]").forEach((button) => {
    const active = button.dataset.robotId === state.robotId;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-active", active);
  });
  renderCatalogRows(elements.list, tasks, state.selectedId);
  elements.list.setAttribute("aria-label", `${ROBOT_LABELS[state.robotId]} tasks`);
  renderCatalogDetails(elements.details, selected);
  elements.resultCount.textContent = `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;
  writeUrl();
  if (!tasks.length) {
    elements.list.innerHTML = `<div class="lab-empty"><strong>No matching tasks</strong><p>Clear the search or choose another robot.</p></div>`;
  }
  window.lucide?.createIcons();
}

function selectTask(taskId, focusDetails = false) {
  state.selectedId = taskId;
  render();
  if (focusDetails) elements.details.focus();
  announce(elements.live, `${selectedTask()?.title || "Task"} selected.`);
}

function bindEvents() {
  elements.filters.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-robot-id]");
    if (!button) return;
    state.robotId = button.dataset.robotId;
    state.selectedId = "";
    render();
    elements.list.querySelector("button")?.focus();
  });
  elements.search.addEventListener("input", () => {
    state.query = elements.search.value;
    state.selectedId = "";
    render();
    announce(elements.live, `${visibleTasks().length} matching tasks.`);
  });
  elements.list.addEventListener("click", (event) => {
    const row = event.target.closest("[data-task-id]");
    if (row) selectTask(row.dataset.taskId);
  });
  elements.list.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
    const rows = [...elements.list.querySelectorAll("[data-task-id]")];
    if (!rows.length) return;
    const activeIndex = Math.max(0, rows.indexOf(document.activeElement));
    let nextIndex = activeIndex;
    if (event.key === "ArrowDown") nextIndex = Math.min(rows.length - 1, activeIndex + 1);
    if (event.key === "ArrowUp") nextIndex = Math.max(0, activeIndex - 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = rows.length - 1;
    event.preventDefault();
    if (event.key === "Enter" || event.key === " ") selectTask(rows[activeIndex].dataset.taskId, true);
    else {
      const nextTaskId = rows[nextIndex].dataset.taskId;
      selectTask(nextTaskId);
      elements.list.querySelector(`[data-task-id="${nextTaskId}"]`)?.focus();
    }
  });
}

async function init() {
  renderLoadingRows(elements.list);
  elements.search.value = state.query;
  try {
    const response = await fetch("missions/lab-assistant/v2/index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Catalog request returned ${response.status}.`);
    state.catalog = await response.json();
    if (!state.catalog.robots.some((robot) => robot.id === state.robotId)) state.robotId = state.catalog.robots[0].id;
    elements.filters.innerHTML = state.catalog.robots.map((robot) => `
      <button type="button" data-robot-id="${robot.id}" aria-pressed="false">
        <span>${ROBOT_LABELS[robot.id] || robot.id}</span><small data-readout>${robot.taskCount}</small>
      </button>
    `).join("");
    bindEvents();
    render();
  } catch (error) {
    elements.error.hidden = false;
    elements.error.querySelector("p").textContent = `${error.message} Serve RoboBuddy through HTTP instead of opening the file directly, then retry.`;
    elements.list.innerHTML = "";
    elements.details.innerHTML = `<div class="lab-empty"><strong>Task details unavailable</strong><p>The scenario catalog did not load.</p></div>`;
  }
}

init();
