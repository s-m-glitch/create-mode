// background.js — service worker.
//
// The feed is blocked until a deadline the user commits to (`blockUntil`,
// an epoch in ms, stored in chrome.storage.local). This worker keeps the
// declarativeNetRequest redirect ruleset in sync with that deadline and
// auto-lifts the block the moment it expires. It never parses the DOM.

const RULESET_ID = "feed_redirect";
const EXPIRY_ALARM = "block-expiry";

function isBlocked(blockUntil, now) {
  return typeof blockUntil === "number" && blockUntil > now;
}

// declarativeNetRequest only redirects NEW requests, so consumption tabs that
// were already loaded (open before the block, or whose content script is
// orphaned after an extension reload/update) won't redirect themselves. When a
// block goes live we proactively sweep open home-feed and notifications tabs
// and send them to the hub. Host permissions for linkedin.com cover the url
// query + tab url + update, so no "tabs" permission is needed.
async function sweepBlockedTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({
      url: [
        "*://*.linkedin.com/feed",
        "*://*.linkedin.com/feed/",
        "*://*.linkedin.com/feed/*",
        "*://*.linkedin.com/notifications",
        "*://*.linkedin.com/notifications/",
        "*://*.linkedin.com/notifications/*",
      ],
    });
  } catch (err) {
    console.error("[Create Mode] could not query tabs:", err);
    return;
  }

  const hub = chrome.runtime.getURL("hub.html");
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let url;
    try {
      url = new URL(tab.url);
    } catch {
      continue;
    }
    // Home feed (never permalinks or the composer) or the notifications page.
    const blocked =
      (/^\/feed\/?$/.test(url.pathname) &&
        !url.searchParams.has("shareActive")) ||
      /^\/notifications\/?$/.test(url.pathname);
    if (blocked) {
      chrome.tabs.update(tab.id, { url: hub }).catch(() => {});
    }
  }
}

// Make the world match storage: enable the redirect while blocked, and
// schedule an alarm to flip everything off the instant the block ends.
async function reconcile() {
  const { blockUntil = null } = await chrome.storage.local.get("blockUntil");
  const now = Date.now();
  const blocked = isBlocked(blockUntil, now);

  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      blocked
        ? { enableRulesetIds: [RULESET_ID] }
        : { disableRulesetIds: [RULESET_ID] }
    );
  } catch (err) {
    console.error("[Create Mode] could not update ruleset:", err);
  }

  await chrome.alarms.clear(EXPIRY_ALARM);
  if (blocked) {
    // Fires when the commitment ends; survives the worker sleeping.
    chrome.alarms.create(EXPIRY_ALARM, { when: blockUntil });
    // Catch any feed/notifications tabs that were already open when blocked.
    sweepBlockedTabs();
  }
}

// Block expired: clear the deadline. The storage write triggers
// reconcile() below (and lets content.js drop its CSS) in one path.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXPIRY_ALARM) {
    chrome.storage.local.set({ blockUntil: null });
  }
});

// Any change to the deadline (a fresh commit, an extension, expiry) re-syncs.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.blockUntil) reconcile();
});

chrome.runtime.onInstalled.addListener(reconcile);
chrome.runtime.onStartup.addListener(reconcile);

// Clicking the toolbar icon opens the Create Hub.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("hub.html") });
});
