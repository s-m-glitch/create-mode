// content.js — runs at document_start on every *.linkedin.com page.
//
// Scope: hide ONLY secondary "scroll-bait" surfaces via CSS. The home
// feed itself is handled at the network layer (declarativeNetRequest),
// not here. This script never reads or rewrites LinkedIn's DOM logic —
// it only injects a stylesheet, so a stale selector fails gracefully
// (it simply matches nothing).

// ─── SELECTOR CONFIG ─────────────────────────────────────────────────
// LinkedIn obfuscates and ROTATES class names constantly. Keep every
// brittle selector in this one object so updates are a one-stop edit.
//
// Each surface is a LIST of candidate selectors — we hide the union.
// Prefer route/attribute selectors (href, aria-label, data-view-name)
// over obfuscated classes; they survive redesigns far longer.
//
// To update when something stops hiding (or wrongly hides): open the
// element inspector on LinkedIn, find a stable attribute, add/replace a
// selector below. No other file needs to change.
const CONSUMPTION_SURFACES = {
  // 1) "Home" item in the top navigation bar (route-based = most stable).
  homeNav: [
    'header li.global-nav__primary-item:has(a[href*="/feed"])',
    'header a.global-nav__primary-link[href*="/feed"]',
    'a[data-test-global-nav-link="home"]',
  ],

  // 2) Right-rail "LinkedIn News" / trending module.
  rightRailNews: [
    'aside .news-module',
    'section.news-module',
    'div[data-view-name="feed-news-module"]',
    'aside[aria-label*="news" i]',
  ],

  // 3) "People you may know" / discovery cohorts (feed + My Network).
  peopleYouMayKnow: [
    'div.discover-cohort',
    'section[data-view-name="cohort"]',
    'aside section:has([href*="mynetwork"])',
    '.mn-pymk-list',
  ],
};

// The post composer only exists as an overlay ON the feed page
// (/feed/?shareActive=true), so the feed renders behind it. While the
// composer is open we hide this feed "chrome" so nothing is consumable
// behind the modal. The composer modal lives in a SEPARATE overlay layer
// (appended near <body>), so hiding these does not touch it. `main` is the
// semantic feed container — far more stable than obfuscated classes. Stale
// selectors just no-op.
const FEED_CHROME = [
  "main", // the entire feed content area (semantic — survives class churn)
  ".scaffold-layout__main", // belt-and-suspenders
  ".scaffold-layout__sidebar", // left profile rail
  "aside.scaffold-layout__aside", // right rail
  "#global-nav",
  ".global-nav",
];

// Markers that the POST composer specifically is open. We must NOT use a
// generic [role="dialog"] here: the feed page also hosts the messaging
// overlay (also a dialog), which would fool us into thinking the composer is
// still open. The Quill editor is the post composer's most stable signal.
const COMPOSER_MARKERS = [
  ".share-creation-state", // the share modal container
  ".share-box",
  ".ql-editor", // Quill post-body editor
  '[aria-label="Text editor for creating content"]',
];
// ─────────────────────────────────────────────────────────────────────

const STYLE_ID = "create-mode-hide";

function buildHideCss(config) {
  const selectors = Object.values(config).flat();
  // One rule, union of all selectors. Invalid/stale selectors that match
  // nothing are harmless; the browser just skips them.
  return `${selectors.join(",\n")} { display: none !important; }`;
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = buildHideCss(CONSUMPTION_SURFACES);
  // <head> may not exist yet at document_start — fall back to <html>.
  (document.head || document.documentElement).appendChild(style);
}

function removeStyle() {
  document.getElementById(STYLE_ID)?.remove();
}

// `blockUntil` is an epoch in ms; a value in the future means blocked.
function isBlocked(blockUntil) {
  return typeof blockUntil === "number" && blockUntil > Date.now();
}

// ─── FEED ROUTE GUARD ────────────────────────────────────────────────
// declarativeNetRequest only catches real page loads. This catches
// LinkedIn's in-app (SPA) navigations to the feed — clicking the logo,
// closing the composer — and bounces them to the Create Hub while a block
// is live. Pure route logic; no DOM classes for the routing. The page-world
// shim `feed-guard.js` notifies us of every history change via this event.
let blockedNow = false;
const HUB_URL = chrome.runtime.getURL("hub.html");

const onFeedRoute = () => /^\/feed\/?$/.test(location.pathname);
const onNotificationsRoute = () => /^\/notifications\/?$/.test(location.pathname);
const composerOpen = () => onFeedRoute() && /(^|[?&])shareActive/.test(location.search);

// Consumption surfaces we bounce to the hub (mirrors rules.json): the home
// feed itself (/feed or /feed/ — never /feed/update/<urn> permalinks, and
// never the composer ?shareActive=...) and the notifications page. Messaging,
// profiles, and post permalinks are left alone.
function isBlockedRoute() {
  return (onFeedRoute() && !composerOpen()) || onNotificationsRoute();
}

// ── Composer mode ──
// The composer is an overlay on the feed page, and LinkedIn closes it WITHOUT
// removing it from the DOM or changing the URL (no mutation, no history
// event). So we can't rely on either — we POLL whether the composer is
// actually visible. While it's open we blank everything except the composer;
// the moment it's gone we bounce to the hub instead of revealing the feed.
const COMPOSER_STYLE_ID = "create-mode-composer";
let composerTimer = null;
let sawComposer = false;

function injectComposerStyle() {
  if (document.getElementById(COMPOSER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = COMPOSER_STYLE_ID;
  // Hide the feed content (the composer modal lives in a separate overlay
  // layer, so it stays) AND lock scrolling outright — so even if a feed
  // element slips past FEED_CHROME, it can't be scrolled or browsed.
  style.textContent = [
    "html, body { overflow: hidden !important; }",
    `${FEED_CHROME.join(",\n")} { visibility: hidden !important; }`,
  ].join("\n");
  (document.head || document.documentElement).appendChild(style);
}

function removeComposerStyle() {
  document.getElementById(COMPOSER_STYLE_ID)?.remove();
}

// The POST composer counts as open only if one of its specific markers is
// present AND laid out (getClientRects is empty for display:none / detached
// nodes). Specific markers avoid the messaging overlay false-positive.
function composerVisible() {
  return COMPOSER_MARKERS.some((sel) => {
    const el = document.querySelector(sel);
    return !!el && el.getClientRects().length > 0;
  });
}

function startComposerWatch() {
  injectComposerStyle();
  if (composerTimer) return;
  sawComposer = false;
  composerTimer = setInterval(() => {
    if (!blockedNow) return stopComposerWatch();
    if (!composerOpen()) {
      // URL left the composer (e.g. dropped to /feed/) — re-route.
      stopComposerWatch();
      evaluate();
      return;
    }
    if (composerVisible()) {
      sawComposer = true;
    } else if (sawComposer) {
      // It was open and is now closed → don't reveal the feed.
      leaveForHub();
    }
    // If the composer NEVER appears (e.g. LinkedIn renamed the editor classes
    // in COMPOSER_MARKERS), we deliberately do NOT redirect: the composer modal
    // lives outside the hidden `main`, so it's still usable. Trapping the user
    // away from a working composer would break the core "post" action. The feed
    // stays hidden behind it; worst case is a blank page if the composer truly
    // failed to open, which the user can simply navigate away from.
  }, 250);
}

function stopComposerWatch() {
  if (composerTimer) clearInterval(composerTimer);
  composerTimer = null;
  removeComposerStyle();
}

function leaveForHub() {
  console.info("[Create Mode] leaving feed → Create Hub");
  stopComposerWatch();
  location.replace(HUB_URL);
}

// Single source of truth for what to do on the current route while blocked.
function evaluate() {
  if (!blockedNow) {
    stopComposerWatch();
    return;
  }
  if (composerOpen()) {
    startComposerWatch(); // allow the composer, blank the feed behind it
  } else if (isBlockedRoute()) {
    leaveForHub();
  } else {
    stopComposerWatch();
  }
}

window.addEventListener("create-mode:nav", evaluate);
window.addEventListener("popstate", evaluate);

// Hide the consumption surfaces + arm the route guard only while a block is
// live. When dormant, leave LinkedIn entirely alone.
function applyBlocked(blocked) {
  blockedNow = blocked;
  // Diagnostic: confirms in DevTools whether blocking is actually armed.
  console.info(
    `[Create Mode] ${blocked ? "ON — feed blocked" : "off — dormant"} @ ${location.pathname}${location.search}`
  );
  blocked ? injectStyle() : removeStyle();
  evaluate();
}

chrome.storage.local.get({ blockUntil: null }, ({ blockUntil }) => {
  applyBlocked(isBlocked(blockUntil));
});

// React live to a new block / extension / expiry without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.blockUntil) {
    applyBlocked(isBlocked(changes.blockUntil.newValue));
  }
});
