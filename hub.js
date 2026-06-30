// hub.js — Create Hub: create tools, the block commitment, and the
// pay-to-break flow.

const $ = (id) => document.getElementById(id);

// `chrome.storage` is absent in a plain browser preview — degrade gracefully.
const store = typeof chrome !== "undefined" && chrome.storage ? chrome.storage : null;
const extUrl = (p) =>
  typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getURL(p) : p;

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
// While API_BASE is empty we run in MOCK mode: a fake checkout page marks the
// payment "paid" so the flow is clickable without a backend. Set API_BASE to
// the deployed backend to go live — the Payment Links below are already wired.
const API_BASE = "https://create-mode-api.vercel.app/api";

// Stripe Payment Links (LIVE mode), keyed by break price (USD).
const PAYMENT_LINKS = {
  5: "https://buy.stripe.com/3cIcMZ8XMbYZcQygWmdfG01",
  10: "https://buy.stripe.com/dRmeV70rg8MN4k20XodfG00",
  25: "https://buy.stripe.com/28E00d5LAaUV2bUgWmdfG02",
  100: "https://buy.stripe.com/00waER6PE1kldUC5dEdfG03",
};
const MOCK = !API_BASE;

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
let pendingBreak = null; // payment in flight { nonce, price, ts }
let breakConfirmOpen = false;
let pollTimer = null;

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

// For sub-day locks a clock time reads clearer than a date.
function fmtUntil(ts) {
  if (ts - Date.now() < DAY) {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
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

// Opens checkout; returns false if no payment link is configured for this tier
// (e.g. the $1 test chip in live mode), so we don't launch a broken tab.
function openCheckout(price, nonce) {
  if (MOCK) {
    window.open(`${extUrl("mock-pay.html")}?nonce=${encodeURIComponent(nonce)}&price=${price}`, "_blank");
    return true;
  }
  const link = PAYMENT_LINKS[price];
  if (!link) {
    console.warn(`[Create Mode] no payment link configured for $${price}`);
    return false;
  }
  window.open(`${link}?client_reference_id=${encodeURIComponent(nonce)}`, "_blank");
  return true;
}

function paymentStatus(nonce) {
  if (MOCK) {
    return new Promise((resolve) => {
      if (!store) return resolve(false);
      const key = `paid:${nonce}`;
      store.local.get(key, (o) => resolve(!!o[key]));
    });
  }
  return fetch(`${API_BASE}/status?nonce=${encodeURIComponent(nonce)}`)
    .then((r) => r.json())
    .then((d) => !!d.paid)
    .catch(() => false);
}

function beginBreak(price) {
  if (!price) return;
  const nonce =
    (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  if (openCheckout(price, nonce) === false) return; // no link for this tier
  pendingBreak = { nonce, price, ts: Date.now() };
  breakConfirmOpen = false;
  if (store) store.local.set({ pendingBreak });
  renderState();
  startPolling();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(checkBreak, 2500);
  checkBreak();
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function checkBreak() {
  if (!pendingBreak) return stopPolling();
  if (Date.now() - pendingBreak.ts > 3_600_000) return cancelBreak(); // stale > 1h
  if (await paymentStatus(pendingBreak.nonce)) finalizeBreak();
}

function finalizeBreak() {
  stopPolling();
  const nonce = pendingBreak?.nonce;
  pendingBreak = null;
  currentBlockUntil = null;
  currentBreakPrice = null;
  if (store) {
    store.local.set({ blockUntil: null, breakPrice: null, pendingBreak: null });
    if (nonce) store.local.remove(`paid:${nonce}`);
  }
  renderState();
}

function cancelBreak() {
  stopPolling();
  pendingBreak = null;
  if (store) store.local.set({ pendingBreak: null });
  renderState();
}

// ── Render ──
// Views in the commit section: idle · blocked · breakConfirm · awaiting.
function renderState() {
  const blocked = isBlocked(currentBlockUntil);
  const awaiting = !!pendingBreak && blocked;
  const breaking = breakConfirmOpen && blocked && !awaiting;
  els.commit.classList.toggle("is-blocked", blocked);

  // Status + headline + sub
  if (blocked) {
    els.state.textContent = awaiting ? "Breaking…" : "Blocked";
    els.title.hidden = false;
    els.title.textContent = `${fmtRemaining(currentBlockUntil - Date.now())} left`;
    els.sub.textContent = awaiting
      ? `Locked until ${fmtUntil(currentBlockUntil)}.`
      : `Locked until ${fmtUntil(currentBlockUntil)} — extend below, never shorten.`;
  } else {
    els.state.textContent = "Not blocked";
    els.title.hidden = true;
    els.sub.textContent = "Commit to a stretch. No early exit — you can only extend it.";
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
    els.breakLink.textContent = `Need out early? Break the lock — $${currentBreakPrice} — but don't do it.`;
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
    { blockUntil: null, breakPrice: null, pendingBreak: null },
    (s) => {
      currentBlockUntil = s.blockUntil;
      currentBreakPrice = s.breakPrice;
      pendingBreak = s.pendingBreak;
      // A pending break only makes sense while still blocked.
      if (pendingBreak && !isBlocked(currentBlockUntil)) pendingBreak = null;
      renderState();
      if (pendingBreak) startPolling();
    }
  );
  store.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.blockUntil) currentBlockUntil = changes.blockUntil.newValue;
    if (changes.breakPrice) currentBreakPrice = changes.breakPrice.newValue;
    if (changes.pendingBreak) pendingBreak = changes.pendingBreak.newValue;
    renderState();
  });
} else {
  renderState();
}

// Keep the "X left" countdown honest while the hub sits open.
setInterval(() => {
  if (isBlocked(currentBlockUntil)) renderState();
}, 60_000);
