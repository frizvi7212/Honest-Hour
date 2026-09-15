# Honest Hour

Chrome extension (Manifest V3) that tracks real engagement — not just screen-open time —
so self-directed learners get an honest "active X of Y hours" picture instead of self-blame.

## Load it in Chrome (no build step needed)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select this `honest-hour` folder
5. Click the extension icon in the toolbar to open the dashboard

If you edit any file, go to `chrome://extensions` and click the refresh icon on the
Honest Hour card. If `manifest.json` itself changed (new permission, new file), do a full
**Remove** and **Load unpacked** again rather than just refreshing — Chrome doesn't always
pick up manifest changes on a plain reload. Any tab that was already open before a reload
also needs its own page refresh (F5), since its content script instance goes stale otherwise.

## What's here

| File | Purpose |
|---|---|
| `manifest.json` | Extension config: permissions, background worker, content script, popup |
| `background.js` | Service worker — activity detection, storage writes, notifications, Study Mode, alarms |
| `content.js` | Injected into every frame of every page — detects real input events, pings background |
| `popup.html/js/css` | The dashboard — today's stats, week view, top sites, to-do list, settings, Study Mode setup |
| `record.html/js` | Standalone page for recording a custom nudge voice clip (mic access needs its own tab, not the popup) |
| `blocked.html/js` | Shown in place of a site blocked during Study Mode, with its own live countdown |
| `offscreen.html/js` | Invisible page whose only job is playing the recorded nudge clip — service workers have no audio API of their own |
| `icons/` | Placeholder icons (swap these for real branding) |

## Features

- **Activity detection**: real input (keydown/mouse/scroll/touch) across every frame on a
  page, not just top-level — proportionally credited as it happens, not sampled as an
  all-or-nothing snapshot per tick. Accuracy doesn't depend on how often the tick fires.
- **Tab audio signal**: a playing video/podcast counts as active even with zero input.
- **Reading mode**: 30-minute manual toggle that pauses idle checks entirely.
- **Configurable check-in frequency and nudge threshold** (both in the popup). Sub-minute
  values only work while loaded unpacked — `chrome.alarms` clamps packed/published
  extensions to a 1-minute floor.
- **Inactivity nudge**: a notification once per idle stretch, optionally paired with a
  locally recorded voice clip (never uploaded — see `record.html`).
- **Dashboard**: today's open vs. active time, 7-day history, top sites today ranked by
  actual active time (not just open time).
- **To-do list**: persists across popup close/reopen, but self-cleans — checked items
  vanish instantly, anything left unchecked expires after 24 hours.
- **Study Mode**: custom-duration timer with a site blocklist enforced via
  `declarativeNetRequest`. No pause or early exit once started. Already-open tabs on a
  blocked site are force-reloaded immediately rather than waiting for the next navigation.

## Privacy

- Only `hostname` is stored (e.g. `youtube.com`), never full URLs.
- No page content, no keystrokes, no screenshots — the content script only reports *that*
  an input event fired, never any detail about it.
- All data lives in `chrome.storage.local`; nothing is sent anywhere. No `fetch` or
  `XMLHttpRequest` calls exist anywhere in this codebase — verify directly in DevTools →
  Network on any tracked page.
- The recorded nudge voice clip is stored the same way, locally, and is never uploaded —
  there is no server component to this extension at all.

## Known limitations (worth knowing before a demo)

- `chrome.alarms` isn't perfectly precise — Chrome may delay firing an alarm (never early),
  especially on battery or when the window isn't focused. This is a platform limitation, not
  a bug. It's most visible when testing with very short intervals (15–30s); at the real
  5–10 minute scale it's negligible.
- OS-level notification settings (e.g. Windows Focus Assist) can silently suppress the
  nudge toast even when `chrome.notifications.create` succeeds without error. Check the
  OS's own notification center if a nudge seems to have "not fired."
- Sub-minute check-in/nudge intervals only work while loaded unpacked in developer mode.
- Study Mode's block only catches full-page navigations (`main_frame`), not background
  sub-resource requests — this is intentional, to avoid breaking unrelated sites that
  happen to load something from a blocked domain.

## Not yet built

- [ ] Tune the default active/idle thresholds against real usage
- [ ] Swap placeholder icons for real ones
- [ ] Replace plain CSS in `popup.css` with compiled Tailwind (CDN is blocked by MV3 CSP —
      needs a local build step, e.g. `npx tailwindcss -i input.css -o popup.css --minify`)
- [ ] Data retention/cleanup (e.g. trim `dailyLogs` older than N weeks)
- [ ] UI pass — the popup has grown a lot; consider collapsible sections or tabs instead
      of one long scroll

## Known gotchas already handled

- Service worker never trusts in-memory state across restarts — activity timestamps and
  the active-time accumulator both persist to `chrome.storage.local`, not just memory.
- Activity crediting happens synchronously in memory on each ping (not a storage
  read-modify-write), to avoid a race condition when multiple frames on the same page
  ping near-simultaneously.
- Uses `chrome.storage.local`, not `localStorage` (the latter doesn't work reliably in MV3
  service workers).
- `sendMessage` calls from content scripts are wrapped in both `.catch()` and a synchronous
  `try/catch`, since a stale content script (after an extension reload) can throw either way.
