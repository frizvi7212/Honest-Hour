// popup.js — Honest Hour dashboard

function formatHM(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function lastNDays(n) {
  const days = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    days.push(d);
  }
  return days;
}

async function render() {
  const { dailyLogs = {}, readingModeUntil = 0 } =
    await chrome.storage.local.get(["dailyLogs", "readingModeUntil"]);

  const todayKey = dateKey(new Date());
  const today = dailyLogs[todayKey] || {
    totalOpenSeconds: 0,
    totalActiveSeconds: 0,
    byDomain: {},
  };

  document.getElementById("open-today").textContent = formatHM(
    today.totalOpenSeconds,
  );
  document.getElementById("active-today").textContent = formatHM(
    today.totalActiveSeconds,
  );
  updateRing(today.totalOpenSeconds, today.totalActiveSeconds);

  renderTopSites(today.byDomain || {});

  // Reading mode toggle state
  const toggle = document.getElementById("reading-mode-toggle");
  const hint = document.getElementById("reading-mode-hint");
  const active = readingModeUntil > Date.now();
  toggle.checked = active;
  hint.textContent = active
    ? `On until ${new Date(readingModeUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "Off";

  // Week view
  const days = lastNDays(7);
  const maxOpen = Math.max(
    1,
    ...days.map((d) => dailyLogs[dateKey(d)]?.totalOpenSeconds || 0),
  );

  const weekList = document.getElementById("week-list");
  weekList.innerHTML = "";
  const hasAnyData = days.some((d) => dailyLogs[dateKey(d)]);

  if (!hasAnyData) {
    weekList.innerHTML =
      '<p class="empty">No activity logged yet this week.</p>';
  } else {
    days.forEach((d) => {
      const log = dailyLogs[dateKey(d)] || {
        totalOpenSeconds: 0,
        totalActiveSeconds: 0,
      };
      const label = d.toLocaleDateString([], { weekday: "short" }).slice(0, 2);
      const pct = Math.round((log.totalActiveSeconds / maxOpen) * 100);

      const row = document.createElement("div");
      row.className = "week-row";
      row.innerHTML = `
        <span class="day">${label}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="amount">${formatHM(log.totalActiveSeconds)}</span>
      `;
      weekList.appendChild(row);
    });
  }
}

function renderTopSites(byDomain) {
  const list = document.getElementById("top-sites-list");
  const entries = Object.entries(byDomain)
    .map(([hostname, d]) => ({
      hostname,
      openSeconds: d.openSeconds || 0,
      activeSeconds: d.activeSeconds || 0,
    }))
    .sort((a, b) => b.activeSeconds - a.activeSeconds)
    .slice(0, 5);

  list.innerHTML = "";

  if (entries.length === 0) {
    list.innerHTML = '<p class="empty">Nothing tracked yet today.</p>';
    return;
  }

  const maxActive = Math.max(1, ...entries.map((e) => e.activeSeconds));

  entries.forEach((e) => {
    const pct = Math.round((e.activeSeconds / maxActive) * 100);
    const row = document.createElement("div");
    row.className = "week-row";
    row.innerHTML = `
      <span class="day" style="width:110px; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${e.hostname}">${e.hostname}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="amount">${formatHM(e.activeSeconds)}</span>
    `;
    list.appendChild(row);
  });
}

document.getElementById("open-record-page").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("record.html") });
});

document
  .getElementById("reading-mode-toggle")
  .addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    await chrome.runtime.sendMessage({ type: "reading-mode-toggle", enabled });
    render();
  });

document
  .getElementById("tick-interval")
  .addEventListener("change", async (e) => {
    const seconds = Number(e.target.value);
    await chrome.runtime.sendMessage({ type: "set-tick-seconds", seconds });
  });

document
  .getElementById("nudge-interval")
  .addEventListener("change", async (e) => {
    const seconds = Number(e.target.value);
    await chrome.runtime.sendMessage({ type: "set-nudge-seconds", seconds });
  });

async function initNudgeIntervalPicker() {
  const { nudgeAfterSeconds = 300 } = await chrome.storage.local.get([
    "nudgeAfterSeconds",
  ]);
  const select = document.getElementById("nudge-interval");
  if ([...select.options].some((o) => Number(o.value) === nudgeAfterSeconds)) {
    select.value = String(nudgeAfterSeconds);
  }
}
initNudgeIntervalPicker();

async function initTickIntervalPicker() {
  const { tickSeconds = 30 } = await chrome.storage.local.get(["tickSeconds"]);
  const select = document.getElementById("tick-interval");
  if ([...select.options].some((o) => Number(o.value) === tickSeconds)) {
    select.value = String(tickSeconds);
  }
}
initTickIntervalPicker();

// --- To-do list: persisted, but self-cleaning ---
// Each item disappears the instant it's checked off, and anything left
// unchecked auto-expires 24 hours after it was created — nothing lingers.

const TODO_TTL_MS = 24 * 60 * 60 * 1000;

async function loadTodos() {
  const { todos = [] } = await chrome.storage.local.get(["todos"]);
  const now = Date.now();
  const fresh = todos.filter((t) => now - t.createdAt < TODO_TTL_MS);
  if (fresh.length !== todos.length) {
    await chrome.storage.local.set({ todos: fresh }); // prune expired ones from storage too
  }
  return fresh;
}

async function saveTodos(todos) {
  await chrome.storage.local.set({ todos });
}

function renderTodos(todos) {
  const list = document.getElementById("todo-list");
  list.innerHTML = "";

  if (todos.length === 0) {
    list.innerHTML = '<p class="empty">Nothing on the list right now.</p>';
    return;
  }

  todos.forEach((todo) => {
    const li = document.createElement("li");
    li.className = "todo-item";
    li.innerHTML = `
      <input type="checkbox" data-id="${todo.id}" />
      <span class="todo-text">${escapeHtml(todo.text)}</span>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", async (e) => {
      const id = e.target.dataset.id;
      const current = await loadTodos();
      const remaining = current.filter((t) => String(t.id) !== id);
      await saveTodos(remaining);
      renderTodos(remaining); // vanishes immediately, no animation delay
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("todo-input");
  const text = input.value.trim();
  if (!text) return;

  const todos = await loadTodos();
  todos.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    createdAt: Date.now(),
  });
  await saveTodos(todos);
  renderTodos(todos);
  input.value = "";
  input.focus();
});

loadTodos().then(renderTodos);

// --- Study mode: render setup form or live countdown ---

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

let studyIsActive = false;

async function renderStudyMode() {
  const { studyMode, studyDraft } = await chrome.storage.local.get([
    "studyMode",
    "studyDraft",
  ]);
  const setupEl = document.getElementById("study-setup");
  const activeEl = document.getElementById("study-active");
  const expandedEl = document.getElementById("study-expanded");
  const stateEl = document.getElementById("study-card-state");

  studyIsActive = !!(studyMode?.active && studyMode.endsAt > Date.now());

  if (studyIsActive) {
    setupEl.classList.add("hidden");
    activeEl.classList.remove("hidden");
    expandedEl.classList.remove("hidden"); // stay visible while a session is running — this isn't optional to collapse
    const remaining = formatCountdown(studyMode.endsAt - Date.now());
    document.getElementById("study-timer").textContent = remaining;
    document.getElementById("study-blocked-list").textContent =
      studyMode.blockedHosts.length > 0
        ? `Blocked: ${studyMode.blockedHosts.join(", ")}`
        : "No sites blocked this session.";
    stateEl.textContent = remaining;
  } else {
    setupEl.classList.remove("hidden");
    activeEl.classList.add("hidden");
    stateEl.textContent = "Start a session";
    // Restore whatever was being typed before the popup was last closed —
    // popups are destroyed on close, so this would otherwise vanish every
    // time the user tabs away to go copy a URL.
    if (studyDraft && !studyRestored) {
      studyRestored = true;
      if (studyDraft.duration != null)
        document.getElementById("study-duration").value = studyDraft.duration;
      if (studyDraft.sitesText != null)
        document.getElementById("study-sites").value = studyDraft.sitesText;
    }
  }
}

document.getElementById("study-card-toggle").addEventListener("click", () => {
  if (studyIsActive) return; // stays open while a session is running — nothing to toggle
  const expandedEl = document.getElementById("study-expanded");
  const nowHidden = expandedEl.classList.toggle("hidden");
  document
    .getElementById("study-card-toggle")
    .setAttribute("aria-expanded", String(!nowHidden));
});

let studyRestored = false;

function saveStudyDraft() {
  chrome.storage.local.set({
    studyDraft: {
      duration: document.getElementById("study-duration").value,
      sitesText: document.getElementById("study-sites").value,
    },
  });
}

document
  .getElementById("study-duration")
  .addEventListener("input", saveStudyDraft);
document
  .getElementById("study-sites")
  .addEventListener("input", saveStudyDraft);

document.getElementById("study-start").addEventListener("click", async () => {
  const duration =
    Number(document.getElementById("study-duration").value) || 25;
  const sitesRaw = document.getElementById("study-sites").value;
  const hostnames = sitesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await chrome.runtime.sendMessage({
    type: "start-study-mode",
    durationMinutes: duration,
    hostnames,
  });
  await chrome.storage.local.remove("studyDraft"); // session started — clear the scratch draft
  renderStudyMode();
});

renderStudyMode();
setInterval(renderStudyMode, 1000); // live countdown while popup is open

render();
// Refresh while popup is open, in case user leaves it up
setInterval(render, 5000);

function updateRing(openSeconds, activeSeconds) {
  const ring = document.getElementById("ring-fill");
  const circumference = 2 * Math.PI * 52; // matches the circle's r=52 in popup.html
  const ratio = openSeconds > 0 ? Math.min(1, activeSeconds / openSeconds) : 0;
  ring.style.strokeDashoffset = String(circumference * (1 - ratio));
}

// --- Tab switching (visual only — no tracking logic here) ---

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document
      .querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`)
      .classList.remove("hidden");
  });
});
