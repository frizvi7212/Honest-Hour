# ADHD-Friendly Work Tracker: "Honest Hour" — Browser Extension
## Project Documentation, Security Audit & Privacy Writeup

| **Documentation** | Part 1 — Project Documentation<br>Part 2 — Pre-Fix Security Audit Report<br>Part 3 — Post-Fix Privacy & Security Writeup (submission-ready) |
| :--- | :--- |
| **Cause Pillar** | Accessibility & Health — supporting ADHD / attention-different learners |
| **Team** | **Fizza Fatima**: Extension Architecture & Activity Detection<br>**Asjid Ilyas**: Privacy & Security Audit |
| **Audit Result** | 6 findings identified — all resolved before submission. No UI or feature changes. |

---

## PART 1 — Project Documentation

### 1. Problem
Self-directed learners (people studying via YouTube, online courses, and browser-based resources instead of structured classrooms) often struggle with **time blindness** — a common ADHD challenge where it's hard to accurately judge how much time has actually passed or how much real work has been done.

Traditional time-tracking apps only check if a window or tab is open. They cannot tell the difference between:
* **Actually working** (reading, writing, engaging with content)
* **Having a screen open** while scrolling a phone, zoning out, or being distracted

This leads to a common, frustrating pattern: someone sits down for 10 hours, feels like they worked the whole time, but only did ~2 hours of real work — and doesn't realize it. Over time this creates self-blame and shame (*"I'm lazy," "I can't focus"*) when the real issue is attention regulation, not effort or character.

### 2. Solution
A Chrome extension that detects real engagement, not just screen-open time:
* Tracks active tab focus + real input activity (typing, mouse movement).
* Distinguishes actual work from idle/passive screen time.
* Shows a simple weekly dashboard: *"You had the screen open for X hours, but were actually active for Y hours."*

**Core differentiator:** Most focus/productivity apps rely on manual timers (Pomodoro-style) or just check window-open state. This detects real engagement automatically, without the user having to start or stop anything.

### 3. Target Audience
**Self-directed learners** — people learning independently through browser-based resources (YouTube, free courses, online reading) rather than a structured classroom. This audience is specifically chosen because their entire learning process already happens in-browser, so a browser extension realistically covers their full workflow (unlike, say, a university student who splits time between Word, VS Code, and PDFs).

### 4. Cause Pillar
**Accessibility & Health** — supporting a population (ADHD / attention-different learners) that is underserved by existing productivity tools, many of which assume neurotypical focus and can reinforce shame rather than help.

### 5. Privacy & Trust Principles
Core to the pitch, not an afterthought:
* **Everything stored locally:** Activity data never leaves the user's device; no server involved.
* **No content logging:** Tracks *that* the user is active, never *what* they typed or which specific content they viewed.
* **No invasive tracking:** No screenshots, no keylogging of actual keystrokes — only activity signals (frequency/timing of input, tab focus).
* **Minimal permissions:** Extension requests only what it strictly needs to function.

### 6. MVP Feature List
| Feature | Description |
| :--- | :--- |
| **Activity/idle detection** | Detects real engagement vs. passive screen time using tab focus + input signals + Chrome's idle API. |
| **Local data storage** | All activity logs stored on-device via `chrome.storage.local`. |
| **Weekly dashboard** | Shows active time vs. total screen-open time, daily/weekly view. |
| **Inactivity nudge** | Gentle notification after 10 minutes of inactivity, reminding user to return to work. |
| **Reading mode** | Manual toggle for reading-only sessions (no typing/clicking expected); pauses inactivity detection for up to 30 minutes so real reading isn't wrongly flagged as idle. |

#### Stretch goals (only if time allows)
* Site blocker (block distracting sites after prolonged inactivity)
* Voice assistant nudge

### 7. Scope
| Component | Scope |
| :--- | :--- |
| **Platform** | Chrome extension only (MVP) |
| **UI** | Tailwind CSS for the popup/dashboard styling |
| **Backend** | None required for MVP — fully local-first |
| **Timeline** | Build within the hackathon window, internal team deadline September 24 (ahead of the official GatewayHacks 2026 submission deadline — confirm exact date on the official rules page) |

---

## PART 2 — Pre-Fix Security Audit Report

This section documents the state of the codebase as originally submitted, before any fixes were applied. It follows a six-part review: permissions, data flow, storage contents, threat modeling, adversarial/edge-case testing, and a summary of findings — directly delivering on the Privacy & Security role described in Part 1.

### 1. Permission Minimization
Every permission declared in `manifest.json` was checked against actual usage in the code.

| Permission | Used for | Verdict | Risk |
| :--- | :--- | :--- | :--- |
| `storage` | Persisting all app state (logs, todos, settings, voice clip) | Justified | Low |
| `tabs` | Reloading tabs open on a blocked host; opening the record page | Justified | Low |
| `notifications` | Inactivity nudge + Study Mode alerts | Justified | Low |
| `alarms` | Heartbeat tick, Study Mode timers | Justified | Low |
| `declarativeNetRequest` | Study Mode site blocking | Justified | Low |
| `offscreen` | Playing the recorded nudge clip (service workers have no audio API) | Justified | Low |
| `host_permissions: <all_urls>` | Content script + site blocking must work on any page — this is the core feature | Justified, but broadest permission in the manifest | **Flag for judges** |

No unused or excessive permissions were found. `<all_urls>` is the single highest-risk line in the manifest — it should be called out and explained proactively in any judge Q&A, since the feature genuinely cannot work without it.

### 2. Data-Flow Verification
* Searched the entire codebase for `fetch()`, `XMLHttpRequest`, `WebSocket`, and `sendBeacon` — zero matches in any file.
* Confirmed in Chrome DevTools → Network tab, on both a live webpage and the service worker, that zero outbound requests fire during normal use.
* **Conclusion:** The “nothing leaves your device” claim in the pitch holds up under direct inspection, not just as a stated policy.

### 3. Storage Content Audit
Ran `chrome.storage.local.get(null)` and inspected every key actually written by the code:

| Storage Key | Contents |
| :--- | :--- |
| `dailyLogs` | Hostname only (e.g., `youtube.com`) + open/active seconds per day. Never a full URL, query string, or page title. |
| `todos` | User-typed task text, entered voluntarily. Self-expires after 24h or on completion. |
| `nudgeVoiceClip` | An optional voice clip the user records of themselves, stored as base64 audio. Never uploaded. |
| `studyMode` / `studyDraft` | Session timer state and the user's own block-list input. |

No keystrokes, page content, or screenshots are captured at any point — the content script only reports that an input event fired, never any detail about it.

### 4. Threat Modeling
| Scenario | Outcome |
| :--- | :--- |
| **Device is compromised** | Attacker sees hostnames, timestamps, and an optional self-recorded voice clip — no passwords, no page content, no browsing history beyond domain names. |
| **Another extension tries to read this data** | Not possible — `chrome.storage.local` is sandboxed per-extension by Chrome itself. Confirmed directly, not just assumed. |
| **A webpage tries to spoof or read activity data** | Not possible as shipped — the extension does not declare `externally_connectable`, so a webpage's JavaScript has no path to the extension's messaging API. |

### 5. Adversarial / Edge-Case Testing — Findings
Deliberately tried to break or abuse the extension. Six issues were identified; severities below reflect real-world impact given this is a fully local, no-account, no-backend extension.

| # | Severity | Finding |
| :--- | :--- | :--- |
| **1** | **MEDIUM** | **Fingerprinting risk:** `blocked.html` was web-accessible to `<all_urls>` with a static path, letting any visited website silently detect that the extension is installed. |
| **2** | **LOW** | **Message listeners** in `background.js` and `offscreen.js` did not verify the sender, relying only on the absence of `externally_connectable` for protection (defense-in-depth gap, not an active exploit). |
| **3** | **LOW** | **User-typed hostnames** (Study Mode block-list) were inserted directly into a `declarativeNetRequest` `urlFilter` string without stripping filter-syntax characters (`*`, `|`, `^`), which could produce an unintended block pattern. |
| **4** | **INFO** | **Dead code:** An unused `IDLE_THRESHOLD_SECONDS` constant, left over from an earlier design, referenced nowhere. |
| **5** | **MEDIUM** | `icon48.png` and `icon128.png` shipped with embedded **Canva/XMP metadata**, including the designer's real name and a Facebook Ads attribution ID — ironic and reputationally risky for a privacy-first product, since this metadata ships publicly with the packaged extension. |
| **6** | **DESIGN NOTE** | A tab playing audio (e.g., an auto-playing ad) is credited as fully “active” time even with zero real input. This is a known product trade-off (documented as the “tab audio signal” feature) rather than a security bug, and was left unchanged — flagged here for transparency. |

---

## PART 3 — Privacy & Security Writeup (Post-Fix, Submission-Ready)

This is the final writeup for the submission. All items in Part 2 rated Medium or Low were fixed prior to writing this section; the one Design Note was a deliberate, disclosed product choice and remains unchanged.

### What We Collect
* **Hostname only** (e.g., `youtube.com`) — never a full URL or query string.
* **Aggregate open time** and active time per hostname, per day.
* **To-do items** you type yourself — self-expiring within 24 hours.
* Optionally, a **short voice clip** you record yourself for inactivity nudges.

### Where It Lives
* **Entirely on your device**, in `chrome.storage.local` — a storage area Chrome sandboxes per-extension, so no other extension can read it.
* **Zero network calls** exist anywhere in this codebase — verified by both static code search and live Network-tab inspection, not just a policy statement.
* There is no server, no account, and no sync component.

### What We Deliberately Exclude
* **No full URLs**, query strings, or page content.
* **No keystroke content** — only the fact that an input event occurred.
* **No screenshots**, no camera/video, no background audio capture.
* **No third-party analytics**, ad SDKs, or crash reporters of any kind.

### Threat Model
| If… | Then… |
| :--- | :--- |
| **Your device is compromised** | Worst case exposure is hostnames, timestamps, and an optional self-recorded voice clip — never credentials or content. |
| **Another extension tries to access this data** | Impossible — enforced by Chrome's per-extension storage sandbox. |
| **A website tries to detect or contact the extension** | The extension does not expose itself to web pages, and no static resource is fingerprintable across sessions. |

***

### Honest Hour — *An honest picture, not a judgment.*
