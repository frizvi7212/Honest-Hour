// offscreen.js — the only job this invisible page has is playing audio,
// since a service worker (background.js) has no DOM and can't do this itself.

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === "play-nudge-audio" && msg.dataUrl) {
    const audio = new Audio(msg.dataUrl);
    audio.play().catch((err) => {
      console.warn("[Honest Hour] offscreen audio playback failed:", err?.message || err);
    });
  }
});
