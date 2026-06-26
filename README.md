# Create Mode

A Manifest V3 Chrome extension that turns LinkedIn into a creation tool, not a
consumption one. The home feed **and notifications** are redirected to a clean
**Create Hub** at the network layer (so they never render — no flash), while
posting, messaging, and profiles all keep working normally.

> Thesis: **create, not consume.**

## What it does

- **Redirects the feed and notifications.** `www.linkedin.com/feed/` and
  `/notifications/` are redirected to the extension's Create Hub via
  `declarativeNetRequest` — the request is rewritten before any HTML loads.
- **Leaves the creation surfaces alone.** `/messaging`, `/in/*` profiles,
  single-post permalinks (`/feed/update/<urn>`), and the post composer
  (`/feed/?shareActive=true`) are untouched.
- **Hides scroll-bait.** While a block is live, a `document_start` content
  script injects CSS that hides the Home nav item, the right-rail
  news/trending module, and "People you may know." Selectors live in one config
  object and fail gracefully.
- **Commitment, not a toggle.** You don't flip the feed off — you commit to
  blocking it for **1 day, 1 week, 2 weeks, or 1 month**. There's no early exit:
  you can only ever *extend* the deadline, never shorten or cancel it. The block
  auto-lifts when the time is up. The deadline lives in `chrome.storage.local`
  and survives restarts; a `chrome.alarms` timer flips it off on expiry.

## File tree

```
create-mode/
├── manifest.json    MV3 manifest, permissions, ruleset + content-script registration
├── rules.json       declarativeNetRequest static rules (redirect + composer exemption)
├── background.js    service worker — syncs the redirect ruleset to the block deadline + alarm
├── content.js       document_start (isolated) — hides surfaces + route guard
├── feed-guard.js    document_start (MAIN world) — reports SPA navigations to content.js
├── hub.html         the Create Hub page (web_accessible_resource)
├── hub.css          hub styling — quiet, dark, editorial
├── hub.js           hub buttons + the block-duration commitment
└── README.md        this file
```

## Load it (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser — Edge, Brave,
   Arc).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select this `create-mode/` folder.
5. The extension is live, but **dormant** until you commit. Pin it from the
   puzzle-piece menu if you like — clicking its toolbar icon opens the Create
   Hub anytime.
6. Click the toolbar icon, pick a duration (1 day / 1 week / 2 weeks / 1 month),
   and confirm. The feed is now blocked until that date.

To verify: with a block live, go to `https://www.linkedin.com/feed/` and
`/notifications/` — both should land on the Create Hub. Then confirm
`/messaging`, your profile, and "Write a post" still work. Before you commit (or
after the block expires), everything loads normally.

After editing any file, return to `chrome://extensions` and click the **reload**
↻ icon on the Create Mode card.

## Why this architecture

LinkedIn obfuscates and rotates its CSS class names constantly, so the design
leans on **URL/route logic over DOM logic** wherever possible:

- The feed block is a **network redirect keyed on the URL**, not a DOM element
  we wait for and hide — that's why there's no flash of feed content.
- The hub's buttons navigate to **stable routes**, not in-page clicks.
- The only class-based logic is the CSS that hides three secondary modules, and
  every brittle selector is quarantined in the `CONSUMPTION_SURFACES` object at
  the top of `content.js`. A selector that goes stale simply matches nothing
  (graceful failure) — fix it there, nowhere else.

## Two-layer feed block (SPA-proof)

`declarativeNetRequest` only intercepts real network navigations (typing the
URL, hard links, the login redirect). LinkedIn is a single-page app, so an
*in-app* navigation back to the feed — clicking the LinkedIn logo, or closing
the composer — can re-render the feed via `history.pushState` without a network
request the redirect can catch. So the block has two layers:

1. **Network layer** — `rules.json` redirects real feed loads before any HTML
   renders (no flash). Because that only catches *new* requests, when a block
   goes live `background.js` also sweeps already-open feed/notifications tabs
   (`sweepBlockedTabs`) and sends them to the hub — covering tabs opened before
   the block, or whose content script was orphaned by an extension reload.
2. **Route layer** — `feed-guard.js` runs in the page's MAIN world, wraps
   `history.pushState`/`replaceState`, and fires a `create-mode:nav` event on
   every client-side navigation. `content.js` (isolated world) listens and, if
   a block is live and the route is a blocked one, calls `location.replace()`
   to the hub. The page-world shim is needed because an isolated content script
   can't intercept the page's own `History` object.

Both layers share one route definition (`isBlockedRoute`) — `/feed` or `/feed/`
and `/notifications`, never `/feed/update/<urn>` permalinks and never
`?shareActive=` (the composer).

### Composer mode (the tricky bit)

The post composer only exists as an overlay on the feed page
(`/feed/?shareActive=true`), so the feed renders *behind* it — and LinkedIn
often closes the composer **without changing the URL**, so a URL-only guard
can't catch the close. While a block is live and the composer is open,
`content.js` therefore:

- hides the feed "chrome" behind the modal (the `FEED_CHROME` selectors — the
  composer modal lives in a separate overlay layer, so it stays visible), and
- watches the composer dialog with a `MutationObserver`; the moment it closes
  (posted or dismissed), it `location.replace()`s to the hub instead of
  revealing the feed.

Net effect: you can open the composer and post, but you can never "X out" into
the feed.

## Customizing

- **Selectors changed?** Edit the `CONSUMPTION_SURFACES` object in `content.js`.
- **Different block durations?** Edit the `DURATIONS` array in `hub.js`.
- **Different routes on the hub?** Edit `ROUTES` in `hub.js`.
- **Block more than the feed?** Add rules to `rules.json` (bump the `id`s).
- **Icons** are intentionally omitted to keep the tree dependency-free; add an
  `"icons"` block and an `"action": { "default_icon": ... }` to the manifest if
  you want a custom toolbar glyph.
