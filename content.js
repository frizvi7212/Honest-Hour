// content.js — Honest Hour
// Detects that the user is doing something on this page (typing, scrolling,
// moving the mouse, clicking) and pings the background worker.
// IMPORTANT: this never reads *what* was typed or *what* the page content is —
// only that an input event of a given type occurred.

const PING_THROTTLE_MS = 5000; // don't spam messages on every mousemove
let lastPingSentAt = 0;

function sendActivityPing() {
  const now = Date.now();
  if (now - lastPingSentAt < PING_THROTTLE_MS) return;
  lastPingSentAt = now;

  try {
    chrome.runtime
      .sendMessage({ type: "activity-ping" })
      .then(() => {
        console.log(
          "[Honest Hour] ping OK at",
          new Date(now).toLocaleTimeString(),
        );
      })
      .catch((err) => {
        console.warn(
          "[Honest Hour] ping FAILED at",
          new Date(now).toLocaleTimeString(),
          err?.message || err,
        );
      });
  } catch (err) {
    // chrome.runtime.sendMessage can throw SYNCHRONOUSLY (not just reject)
    // when this content script instance is stale — e.g. the extension was
    // reloaded while this page stayed open. A .catch() alone can't catch
    // that; this try/catch is the actual fix. Safe to ignore either way —
    // a page refresh gives this page a fresh, valid script instance.
    console.warn(
      "[Honest Hour] ping threw synchronously (stale context):",
      err?.message || err,
    );
  }
}

const ACTIVITY_EVENTS = [
  "keydown",
  "mousemove",
  "mousedown",
  "scroll",
  "wheel",
  "touchstart",
];

ACTIVITY_EVENTS.forEach((evt) => {
  document.addEventListener(evt, sendActivityPing, {
    passive: true,
    capture: true,
  });
});

// Fire one immediately on load so a page you land on and start reading
// right away isn't marked idle for the first stretch.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sendActivityPing();
});
