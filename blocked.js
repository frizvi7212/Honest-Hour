// blocked.js — shows which host was blocked and counts down to when
// Study Mode actually ends, reading directly from chrome.storage.local.

const params = new URLSearchParams(location.search);
document.getElementById("host").textContent = params.get("host") || "This site";

function format(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function tick() {
  const { studyMode } = await chrome.storage.local.get(["studyMode"]);
  const timerEl = document.getElementById("timer");

  if (!studyMode || !studyMode.active) {
    timerEl.textContent = "Done!";
    return;
  }

  const remaining = studyMode.endsAt - Date.now();
  timerEl.textContent = format(remaining);

  if (remaining <= 0) {
    // Session just ended — reload so the browser re-checks the (now
    // removed) block rule and lets the real page through.
    location.reload();
  }
}

tick();
setInterval(tick, 1000);
