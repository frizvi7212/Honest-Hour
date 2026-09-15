// record.js — records a short local voice clip for the inactivity nudge.
// Runs as its own tab (not the transient popup) so a mic-permission prompt
// can't cause the UI to vanish mid-flow.

const MAX_RECORD_MS = 5000;

const recordBtn = document.getElementById("record-btn");
const timerEl = document.getElementById("timer");
const statusEl = document.getElementById("status");
const previewControls = document.getElementById("preview-controls");
const clearControls = document.getElementById("clear-controls");
const playBtn = document.getElementById("play-btn");
const saveBtn = document.getElementById("save-btn");
const discardBtn = document.getElementById("discard-btn");
const clearBtn = document.getElementById("clear-btn");

let mediaRecorder = null;
let chunks = [];
let recordedBlob = null;
let recordedDataUrl = null;
let timerInterval = null;
let stopTimeout = null;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop()); // release the mic
      recordedBlob = new Blob(chunks, { type: "audio/webm" });
      recordedDataUrl = await blobToDataUrl(recordedBlob);
      previewControls.classList.remove("hidden");
      recordBtn.classList.add("hidden");
      timerEl.textContent = "";
      statusEl.textContent = "Recorded. Preview it, then save if you're happy with it.";
    };

    mediaRecorder.start();
    recordBtn.classList.add("recording");
    statusEl.textContent = "Recording…";

    const startedAt = Date.now();
    timerInterval = setInterval(() => {
      const remaining = Math.max(0, MAX_RECORD_MS - (Date.now() - startedAt));
      timerEl.textContent = `${(remaining / 1000).toFixed(1)}s left`;
    }, 100);

    stopTimeout = setTimeout(stopRecording, MAX_RECORD_MS);
  } catch (err) {
    statusEl.textContent = `Couldn't access the microphone: ${err?.message || err}`;
  }
}

function stopRecording() {
  clearInterval(timerInterval);
  clearTimeout(stopTimeout);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  recordBtn.classList.remove("recording");
}

recordBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording();
  } else {
    startRecording();
  }
});

playBtn.addEventListener("click", () => {
  if (!recordedDataUrl) return;
  new Audio(recordedDataUrl).play();
});

saveBtn.addEventListener("click", async () => {
  if (!recordedDataUrl) return;
  await chrome.storage.local.set({ nudgeVoiceClip: recordedDataUrl });
  statusEl.textContent = "Saved. Your recorded voice will play for inactivity nudges from now on.";
  previewControls.classList.add("hidden");
  clearControls.classList.remove("hidden");
});

discardBtn.addEventListener("click", () => {
  recordedBlob = null;
  recordedDataUrl = null;
  previewControls.classList.add("hidden");
  recordBtn.classList.remove("hidden");
  statusEl.textContent = "Discarded. Tap the mic to try again.";
});

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("nudgeVoiceClip");
  clearControls.classList.add("hidden");
  recordBtn.classList.remove("hidden");
  statusEl.textContent = "Removed. Nudges will use the default notification sound again.";
});

// Reflect existing state on load
chrome.storage.local.get(["nudgeVoiceClip"]).then(({ nudgeVoiceClip }) => {
  if (nudgeVoiceClip) {
    clearControls.classList.remove("hidden");
    statusEl.textContent = "You already have a saved clip. Record a new one to replace it.";
  }
});
