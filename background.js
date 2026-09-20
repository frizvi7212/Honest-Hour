// background.js — Honest Hour
// MV3 service worker: NOT persistent. It can be killed and restarted by
// Chrome at any time, so we never rely on in-memory state surviving —
// everything that matters gets written to chrome.storage.local immediately.

const IDLE_THRESHOLD_SECONDS = 30; // chrome.idle's own floor is 15s; this is the "how fresh must a ping be" window
const HEARTBEAT_ALARM = "honest-hour-heartbeat";
const DEFAULT_TICK_SECONDS = 30;
// NOTE: chrome.alarms clamps periods under 1 minute to 1 minute for PACKED
// (published) extensions. Sub-minute values below only work while loaded
// unpacked in developer mode — see README for details.

const STUDY_END_ALARM = "honest-hour-study-end";
const STUDY_WARN_ALARM = "honest-hour-study-warn";
const STUDY_WARN_LEAD_MS = 8000; // fire a heads-up notification 8s before the session ends

// In-memory cache of "last known" state — treated as disposable.
// Source of truth is always chrome.storage.local.
let state = {
  activeTabId: null,
  activeHostname: null,
  windowFocused: true,
  tabAudible: false, // playing audio/video — counts like reading mode
  lastActivityTs: 0, // updated by content script heartbeats
  pendingActiveMs: 0, // accumulated since the last tick flush
  readingModeUntil: 0, // epoch ms; if in the future, idle checks are suppressed
};

async function setupAlarm() {
  const { tickSeconds = DEFAULT_TICK_SECONDS } = await chrome.storage.local.get(
    ["tickSeconds"],
  );
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: tickSeconds / 60 });
}

async function reconcileStudyModeOnStartup() {
  // If the browser was closed mid-session, the alarm may have been missed —
  // clean up so a stale session doesn't block sites forever.
  const { studyMode } = await chrome.storage.local.get(["studyMode"]);
  if (studyMode?.active && studyMode.endsAt <= Date.now()) {
    await endStudyMode();
  } else if (studyMode?.active) {
    await applyBlockRules(studyMode.blockedHosts); // re-assert rules just in case
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  reconcileStudyModeOnStartup();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  reconcileStudyModeOnStartup();
});

// --- Track which tab/hostname is actually in front of the user ---

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab && tab.url) {
      state.activeTabId = tab.id;
      state.activeHostname = safeHostname(tab.url);
      state.tabAudible = !!tab.audible; // playing sound — e.g. a lecture video — even with no input
    } else {
      state.activeTabId = null;
      state.activeHostname = null;
      state.tabAudible = false;
    }
  } catch (e) {
    state.activeTabId = null;
    state.activeHostname = null;
    state.tabAudible = false;
  }
}

function safeHostname(url) {
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.hostname; // hostname only — never store full URL (query params can leak data)
  } catch (e) {
    return null;
  }
}

chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || "audible" in changeInfo)
    refreshActiveTab();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  state.windowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;
  refreshActiveTab();
});

// --- Receive activity heartbeats from content scripts ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "activity-ping") {
    const ts = Date.now();
    // Accumulate synchronously in memory — safe against races even when
    // multiple frames (all_frames content scripts) ping near-simultaneously,
    // since this runs to completion before any other message is handled.
    // Storage is only a restart-safety backup, never read-before-write here.
    const PING_CREDIT_CAP_MS = 10000;
    const creditMs =
      state.lastActivityTs > 0
        ? Math.min(ts - state.lastActivityTs, PING_CREDIT_CAP_MS)
        : 0;
    state.lastActivityTs = ts;
    state.pendingActiveMs =
      (state.pendingActiveMs || 0) + Math.max(creditMs, 0);
    chrome.storage.local.set({
      lastActivityTs: state.lastActivityTs,
      pendingActiveMs: state.pendingActiveMs,
    });
    sendResponse({ ok: true });
  }
  if (msg?.type === "reading-mode-toggle") {
    const minutes = Math.max(1, Number(msg.durationMinutes) || 30);
    state.readingModeUntil = msg.enabled ? Date.now() + minutes * 60 * 1000 : 0;
    chrome.storage.local.set({ readingModeUntil: state.readingModeUntil });
    sendResponse({ ok: true, readingModeUntil: state.readingModeUntil });
  }
  if (msg?.type === "set-tick-seconds") {
    // Sub-minute values only take effect while loaded unpacked (dev mode) —
    // chrome.alarms clamps packed/published extensions to a 1-minute floor.
    const seconds = Math.max(5, Number(msg.seconds) || DEFAULT_TICK_SECONDS);
    chrome.storage.local.set({ tickSeconds: seconds }).then(() => {
      setupAlarm();
      sendResponse({ ok: true, tickSeconds: seconds });
    });
    return true; // keep the message channel open for the async response above
  }
  if (msg?.type === "start-study-mode") {
    startStudyMode(msg.durationMinutes, msg.hostnames).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.type === "set-nudge-seconds") {
    const seconds = Math.max(5, Number(msg.seconds) || 300);
    chrome.storage.local.set({ nudgeAfterSeconds: seconds }).then(() => {
      sendResponse({ ok: true, nudgeAfterSeconds: seconds });
    });
    return true;
  }
  return true;
});

// --- Core tick: decide "active" vs "open", persist to storage ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    await tick();
  }
  if (alarm.name === STUDY_END_ALARM) {
    await endStudyMode();
  }
  if (alarm.name === STUDY_WARN_ALARM) {
    warnStudyModeEnding();
  }
});

// --- Study Mode: custom timer + site blocker via declarativeNetRequest ---
// No pause/cancel by design — starting it is the commitment.

async function startStudyMode(durationMinutes, hostnames) {
  const minutes = Math.max(1, Number(durationMinutes) || 25);
  const cleanHosts = (hostnames || [])
    .map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, ""),
    )
    .filter(Boolean);

  const endsAt = Date.now() + minutes * 60 * 1000;

  await chrome.storage.local.set({
    studyMode: {
      active: true,
      endsAt,
      blockedHosts: cleanHosts,
      durationMinutes: minutes,
    },
  });

  await applyBlockRules(cleanHosts);
  await kickOpenTabsOffBlockedHosts(cleanHosts);

  await chrome.alarms.create(STUDY_END_ALARM, { when: endsAt });
  const warnAt = endsAt - STUDY_WARN_LEAD_MS;
  if (warnAt > Date.now()) {
    await chrome.alarms.create(STUDY_WARN_ALARM, { when: warnAt });
  }
}

async function kickOpenTabsOffBlockedHosts(hostnames) {
  if (hostnames.length === 0) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url) continue;
    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch (e) {
      continue;
    }
    if (hostnames.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
      chrome.tabs.reload(tab.id).catch((err) => {
        console.warn(
          "[Honest Hour] couldn't reload tab for study mode:",
          err?.message || err,
        );
      });
    }
  }
}

async function applyBlockRules(hostnames) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = hostnames.map((host, i) => ({
    id: 1000 + i,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        extensionPath: `/blocked.html?host=${encodeURIComponent(host)}`,
      },
    },
    condition: { urlFilter: `||${host}^`, resourceTypes: ["main_frame"] },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

async function endStudyMode() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
  });
  await chrome.storage.local.set({
    studyMode: {
      active: false,
      endsAt: 0,
      blockedHosts: [],
      durationMinutes: 0,
    },
  });
  await chrome.alarms.clear(STUDY_WARN_ALARM);

  chrome.notifications.create(
    `honest-hour-study-done-${Date.now()}`,
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Study session done",
      message: "Nice work — sites are unblocked now.",
      priority: 1,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[Honest Hour] study-done notification failed:",
          chrome.runtime.lastError.message,
        );
      }
    },
  );
}

function warnStudyModeEnding() {
  chrome.notifications.create(
    `honest-hour-study-warn-${Date.now()}`,
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Almost done",
      message: "Study mode ends in a few seconds.",
      priority: 1,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[Honest Hour] study-warn notification failed:",
          chrome.runtime.lastError.message,
        );
      }
    },
  );
}

async function tick() {
  await refreshActiveTab();

  const now = Date.now();
  const stored = await chrome.storage.local.get([
    "readingModeUntil",
    "lastActivityTs",
    "pendingActiveMs",
    "lastTickTs",
  ]);

  state.readingModeUntil = stored.readingModeUntil || 0;
  state.lastActivityTs = Math.max(
    stored.lastActivityTs || 0,
    state.lastActivityTs || 0,
  );
  // Reconcile in-memory vs stored pendingActiveMs — whichever is larger is
  // more current. If the worker just restarted, in-memory is 0 and storage
  // has the real value; if the worker survived, in-memory is authoritative
  // and storage may lag slightly behind the latest fire-and-forget write.
  state.pendingActiveMs = Math.max(
    stored.pendingActiveMs || 0,
    state.pendingActiveMs || 0,
  );
  const inReadingMode = state.readingModeUntil > now;

  // Real elapsed time since the last tick, not an assumed constant — this
  // also makes the accounting self-correcting if an alarm fires late.
  // Capped so a laptop sleep/wake or a long-dead worker doesn't dump a huge
  // block of "open" time in one jump.
  const MAX_TICK_GAP_MS = 5 * 60 * 1000;
  const lastTickTs = stored.lastTickTs || now;
  const elapsedSeconds = Math.min(now - lastTickTs, MAX_TICK_GAP_MS) / 1000;

  // How much of that elapsed time did we actually earn credit for, via
  // pings that arrived in real time (not limited by the alarm's interval)?
  const pendingActiveSeconds = state.pendingActiveMs / 1000;

  let activeSeconds;
  if (state.tabAudible) {
    // A playing tab counts as active even if Chrome isn't the focused
    // window — listening to a video/podcast doesn't require looking at the
    // screen. Still needs a real tracked tab, just not window focus.
    activeSeconds = state.activeHostname ? elapsedSeconds : 0;
  } else if (inReadingMode) {
    activeSeconds =
      state.windowFocused && state.activeHostname ? elapsedSeconds : 0;
  } else {
    activeSeconds = Math.min(pendingActiveSeconds, elapsedSeconds);
    if (!state.windowFocused || !state.activeHostname) activeSeconds = 0;
  }

  const secondsSinceActivity = (now - state.lastActivityTs) / 1000;

  console.log(
    `[Honest Hour] tick | host=${state.activeHostname} focused=${state.windowFocused} ` +
      `elapsed=${elapsedSeconds.toFixed(1)}s credited=${activeSeconds.toFixed(1)}s ` +
      `reading=${inReadingMode} audible=${state.tabAudible}`,
  );

  if (state.activeHostname) {
    await recordTick(state.activeHostname, elapsedSeconds, activeSeconds);
  }

  state.pendingActiveMs = 0;
  await chrome.storage.local.set({ lastTickTs: now, pendingActiveMs: 0 });

  await maybeNudge(secondsSinceActivity, inReadingMode);
}

// --- Storage schema ---
// dailyLogs: { "YYYY-MM-DD": { totalOpenSeconds, totalActiveSeconds,
//              byDomain: { hostname: { openSeconds, activeSeconds } } } }

async function recordTick(hostname, openDeltaSeconds, activeDeltaSeconds) {
  const dateKey = new Date().toISOString().slice(0, 10);

  const { dailyLogs = {} } = await chrome.storage.local.get(["dailyLogs"]);
  const day = dailyLogs[dateKey] || {
    totalOpenSeconds: 0,
    totalActiveSeconds: 0,
    byDomain: {},
  };
  const domain = day.byDomain[hostname] || { openSeconds: 0, activeSeconds: 0 };

  domain.openSeconds += openDeltaSeconds;
  day.totalOpenSeconds += openDeltaSeconds;
  domain.activeSeconds += activeDeltaSeconds;
  day.totalActiveSeconds += activeDeltaSeconds;

  day.byDomain[hostname] = domain;
  dailyLogs[dateKey] = day;

  await chrome.storage.local.set({ dailyLogs });
}

// --- Gentle inactivity nudge (once per idle stretch, not repeated) ---

async function maybeNudge(secondsSinceActivity, inReadingMode) {
  const { nudgeAfterSeconds = 300 } = await chrome.storage.local.get([
    "nudgeAfterSeconds",
  ]);

  if (inReadingMode) return;
  if (secondsSinceActivity < nudgeAfterSeconds) return;

  // "Have we already nudged for THIS idle stretch?" — keyed off the
  // lastActivityTs that started it, so a worker restart mid-stretch doesn't
  // cause a duplicate notification, and a fresh ping naturally clears it.
  const { notifiedForActivityTs } = await chrome.storage.local.get([
    "notifiedForActivityTs",
  ]);
  if (notifiedForActivityTs === state.lastActivityTs) return;

  await chrome.storage.local.set({
    notifiedForActivityTs: state.lastActivityTs,
  });

  const minutes = Math.round(nudgeAfterSeconds / 60);
  const timeLabel =
    minutes >= 1
      ? `${minutes} minute${minutes === 1 ? "" : "s"}`
      : `${nudgeAfterSeconds} seconds`;

  chrome.notifications.create(
    `honest-hour-nudge-${Date.now()}`,
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Still there?",
      message: `It's been a quiet ${timeLabel}. No judgment — just checking in.`,
      priority: 0,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[Honest Hour] notification failed:",
          chrome.runtime.lastError.message,
        );
      }
    },
  );

  await playNudgeVoiceIfAny();
}

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification:
        "Play a locally recorded nudge sound when the user has been inactive",
    });
  } catch (err) {
    // "Only a single offscreen document may be created" is expected once
    // one already exists — anything else is worth knowing about.
    if (!String(err?.message || err).includes("single offscreen document")) {
      console.warn(
        "[Honest Hour] offscreen document error:",
        err?.message || err,
      );
    }
  }
}

async function playNudgeVoiceIfAny() {
  const { nudgeVoiceClip } = await chrome.storage.local.get(["nudgeVoiceClip"]);
  if (!nudgeVoiceClip) return; // no custom clip recorded — default notification sound is enough

  await ensureOffscreenDocument();
  chrome.runtime
    .sendMessage({ type: "play-nudge-audio", dataUrl: nudgeVoiceClip })
    .catch(() => {
      // Offscreen document may still be spinning up — acceptable to miss
      // one playback rather than delay or duplicate the notification.
    });
}
