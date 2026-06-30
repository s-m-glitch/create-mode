// hub.js — Create Hub: create tools, the block commitment, and the
// pay-to-break flow.

const $ = (id) => document.getElementById(id);

// `chrome.storage` is absent in a plain browser preview — degrade gracefully.
const store = typeof chrome !== "undefined" && chrome.storage ? chrome.storage : null;

// ── Create tools: plain routes, no DOM scraping ──
const ROUTES = {
  post: "https://www.linkedin.com/feed/?shareActive=true",
  messages: "https://www.linkedin.com/messaging/",
};
$("post").addEventListener("click", () => (location.href = ROUTES.post));
$("messages").addEventListener("click", () => (location.href = ROUTES.messages));

// ── Block commitment ──
const HOUR = 3_600_000;
const DAY = 86_400_000;
const DURATIONS = [
  { label: "1 hour", ms: HOUR, price: 5 }, // shortest tier — same $5 stake as a day
  { label: "1 day", ms: 1 * DAY, price: 5 },
  { label: "1 week", ms: 7 * DAY, price: 10 },
  { label: "2 weeks", ms: 14 * DAY, price: 25 },
  { label: "1 month", ms: 30 * DAY, price: 100 },
];

// ── Pay-to-break configuration ──
// Backend that creates a Stripe Checkout Session per break (/checkout), records
// the payment (Stripe webhook → KV), and answers /status. The server owns the
// price, so there's no static link to pay without a nonce.
const API_BASE = "https://create-mode-api.vercel.app/api";

// Valid break prices (USD). The authoritative amount lives server-side; this is
// just a client-side guard so we never open checkout for a bogus tier.
const BREAK_PRICES = [5, 10, 25, 100];

const els = {
  commit: $("commit"),
  state: $("commitState"),
  title: $("commitTitle"),
  sub: $("commitSub"),
  durations: $("durations"),
  confirm: $("confirm"),
  confirmText: $("confirmText"),
  confirmGo: $("confirmGo"),
  breakLink: $("breakLink"),
  breakBox: $("breakBox"),
  breakBody: $("breakBody"),
  breakPay: $("breakPay"),
  breakStay: $("breakStay"),
  awaiting: $("awaiting"),
  breakCancel: $("breakCancel"),
};

let currentBlockUntil = null;
let currentBreakPrice = null;
let pending = null; // commit selection awaiting confirmation { ms, until, price }
let pendingBreaks = []; // initiated breaks awaiting redemption: [{ nonce, price, ts }]
let awaitingUI = false; // whether the "finish checkout" box is showing
let breakConfirmOpen = false;
let pollTimer = null;
let polling = false; // in-flight guard so status polls don't overlap
const PAID_TTL_MS = 30 * DAY; // matches the backend's paid-record TTL

const isBlocked = (until) => typeof until === "number" && until > Date.now();

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtRemaining(ms) {
  if (ms <= 0) return "moments";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"}`;
  const days = Math.ceil(ms / DAY);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// For sub-day locks a clock time reads clearer than a date — but a bare time
// is ambiguous if it lands on a different calendar day (e.g. an 11pm + 1hr lock
// ending at 12:40 AM "tomorrow"), so qualify it when the day differs.
function fmtUntil(ts) {
  const now = new Date();
  const target = new Date(ts);
  if (ts - now.getTime() < DAY) {
    const time = target.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return target.getDate() === now.getDate() ? time : `${time} tomorrow`;
  }
  return fmtDate(ts);
}

// Build the duration chips once.
DURATIONS.forEach((d) => {
  const btn = document.createElement("button");
  btn.className = "seg__btn";
  btn.type = "button";
  btn.textContent = d.label;
  btn.addEventListener("click", () => choose(d, btn));
  els.durations.appendChild(btn);
});
els.durations.style.gridTemplateColumns = `repeat(${DURATIONS.length}, 1fr)`;

const clearChips = () =>
  [...els.durations.children].forEach((c) => c.classList.remove("is-pending"));

// A chip can only ever push the deadline further out, never closer.
function targetFor(ms) {
  const now = Date.now();
  const base = isBlocked(currentBlockUntil) ? currentBlockUntil : now;
  return Math.max(base, now + ms);
}

function choose(d, btn) {
  const until = targetFor(d.ms);
  // A shorter pick while blocked would imply a (forbidden) early exit — ignore.
  if (isBlocked(currentBlockUntil) && until <= currentBlockUntil) {
    pending = null;
    clearChips();
    renderPending();
    return;
  }
  pending = { ms: d.ms, until, price: d.price };
  [...els.durations.children].forEach((c) =>
    c.classList.toggle("is-pending", c === btn)
  );
  renderPending();
}

function renderPending() {
  if (!pending || els.durations.hidden) {
    els.confirm.hidden = true;
    return;
  }
  const verb = isBlocked(currentBlockUntil) ? "Extend the lock to" : "Lock the feed until";
  els.confirmText.innerHTML =
    `${verb} <strong>${fmtUntil(pending.until)}</strong>. ` +
    `Breaking early costs <strong>$${pending.price}</strong>.`;
  els.confirm.hidden = false;
}

els.confirmGo.addEventListener("click", () => {
  if (!pending) return;
  currentBlockUntil = pending.until;
  currentBreakPrice = pending.price;
  if (store) store.local.set({ blockUntil: pending.until, breakPrice: pending.price });
  pending = null;
  renderState();
});

// ── Break-and-pay ──
els.breakLink.addEventListener("click", () => {
  breakConfirmOpen = true;
  renderState();
});
els.breakStay.addEventListener("click", () => {
  breakConfirmOpen = false;
  renderState();
});
els.breakPay.addEventListener("click", () => beginBreak(currentBreakPrice));
els.breakCancel.addEventListener("click", cancelBreak);

// Opens checkout for this tier by sending a new tab to our /checkout endpoint,
// which creates the Stripe session (server-set amount) and redirects to it.
// Opening synchronously on the click avoids pop-up blocking. Returns false if
// the price is unknown or the pop-up was blocked, so we don't enter "awaiting"
// with no checkout open.
function openCheckout(price, nonce) {
  if (!BREAK_PRICES.includes(price)) {
    console.warn(`[Create Mode] unknown break price $${price}`);
    return false;
  }
  const win = window.open(
    `${API_BASE}/checkout?price=${encodeURIComponent(price)}&nonce=${encodeURIComponent(nonce)}`,
    "_blank"
  );
  if (!win) {
    alert("Couldn't open the checkout — please allow pop-ups for this page and try again.");
    return false;
  }
  return true;
}

// Polls the backend for this nonce's paid status, with a timeout so a hung
// request can't block the next poll (we also guard against overlap upstream).
function paymentStatus(nonce) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  return fetch(`${API_BASE}/status?nonce=${encodeURIComponent(nonce)}`, {
    signal: ctrl.signal,
  })
    .then((r) => r.json())
    .then((d) => !!d.paid)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

function beginBreak(price) {
  if (!price) return;
  const nonce =
    (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  if (openCheckout(price, nonce) === false) return; // no link for this tier
  pendingBreaks = [...pendingBreaks, { nonce, price, ts: Date.now() }];
  awaitingUI = true;
  breakConfirmOpen = false;
  persistPendingBreaks();
  renderState();
  ensurePolling();
}

function persistPendingBreaks() {
  if (store) store.local.set({ pendingBreaks });
}

// Poll while there's an initiated break to redeem and we're still blocked.
function ensurePolling() {
  if (isBlocked(currentBlockUntil) && pendingBreaks.length > 0) startPolling();
  else stopPolling();
}
function startPolling() {
  if (pollTimer) return; // already running
  pollTimer = setInterval(checkBreak, 3000);
  checkBreak();
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function checkBreak() {
  // Drop breaks whose server record has certainly expired (nothing to redeem).
  const cutoff = Date.now() - PAID_TTL_MS;
  const kept = pendingBreaks.filter((b) => b.ts > cutoff);
  if (kept.length !== pendingBreaks.length) {
    pendingBreaks = kept;
    persistPendingBreaks();
  }
  if (!isBlocked(currentBlockUntil) || pendingBreaks.length === 0) {
    stopPolling();
    return;
  }
  if (polling) return; // don't overlap requests
  polling = true;
  try {
    for (const b of pendingBreaks) {
      if (await paymentStatus(b.nonce)) {
        finalizeBreak();
        return;
      }
    }
  } finally {
    polling = false;
  }
}

function finalizeBreak() {
  stopPolling();
  pendingBreaks = [];
  awaitingUI = false;
  currentBlockUntil = null;
  currentBreakPrice = null;
  if (store) {
    store.local.set({ blockUntil: null, breakPrice: null, pendingBreaks: [] });
  }
  renderState();
}

function cancelBreak() {
  // Dismiss the waiting UI only. We KEEP the nonce and keep polling in the
  // background: if the payment actually went through (a race, or they paid then
  // hit cancel), it must still unlock — never strand a real charge.
  awaitingUI = false;
  renderState();
}

// ── Render ──
// Views in the commit section: idle · blocked · breakConfirm · awaiting.
function renderState() {
  const blocked = isBlocked(currentBlockUntil);
  const awaiting = awaitingUI && blocked;
  const breaking = breakConfirmOpen && blocked && !awaiting;
  els.commit.classList.toggle("is-blocked", blocked);

  // Status + headline + sub
  if (blocked) {
    els.state.textContent = awaiting ? "Breaking…" : "Blocked";
    els.title.hidden = false;
    els.title.textContent = `${fmtRemaining(currentBlockUntil - Date.now())} left`;
    els.sub.textContent = `Locked until ${fmtUntil(currentBlockUntil)}.`;
  } else {
    els.state.textContent = "Not blocked";
    els.title.hidden = true;
    els.sub.textContent = "Get off LinkedIn. Do something productive. Or fun!";
  }

  // Durations + commit confirm: only when not mid-break.
  const showDurations = !awaiting && !breaking;
  els.durations.hidden = !showDurations;
  if (!showDurations) pending = null;
  if (!pending) clearChips();
  renderPending();

  // Break link: blocked, not already breaking/awaiting.
  const showBreakLink = blocked && !breaking && !awaiting;
  els.breakLink.hidden = !showBreakLink;
  if (showBreakLink) {
    els.breakLink.textContent = `Break the lock — $${currentBreakPrice}`;
  }

  // Break confirm box.
  els.breakBox.hidden = !breaking;
  if (breaking) {
    const left = fmtRemaining(currentBlockUntil - Date.now());
    els.breakBody.textContent = `Breaking now ends your commitment ${left} early. You set this stake yourself.`;
    els.breakPay.textContent = `$${currentBreakPrice} — back to the scroll`;
  }

  // Awaiting payment.
  els.awaiting.hidden = !awaiting;
}

// ── Boot ──
if (store) {
  store.local.get(
    { blockUntil: null, breakPrice: null, pendingBreaks: [] },
    (s) => {
      currentBlockUntil = s.blockUntil;
      currentBreakPrice = s.breakPrice;
      pendingBreaks = Array.isArray(s.pendingBreaks) ? s.pendingBreaks : [];
      // Unredeemed breaks only matter while still blocked; otherwise the block
      // already lifted and there's nothing left to unlock.
      if (!isBlocked(currentBlockUntil)) pendingBreaks = [];
      renderState();
      ensurePolling(); // silently redeem a payment made in a prior session
    }
  );
  store.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.blockUntil) currentBlockUntil = changes.blockUntil.newValue;
    if (changes.breakPrice) currentBreakPrice = changes.breakPrice.newValue;
    if (changes.pendingBreaks) {
      pendingBreaks = Array.isArray(changes.pendingBreaks.newValue)
        ? changes.pendingBreaks.newValue
        : [];
    }
    renderState();
    ensurePolling();
  });
} else {
  renderState();
}

// Keep the "X left" countdown honest while the hub sits open.
setInterval(() => {
  if (isBlocked(currentBlockUntil)) renderState();
}, 60_000);
