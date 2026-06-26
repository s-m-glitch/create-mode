// hub.js — Create Hub buttons + the feed-block commitment.

const $ = (id) => document.getElementById(id);

// ── Create tools: plain routes, no DOM scraping ──
// "Write a post" uses the composer URL, which rules.json exempts from the
// feed redirect.
const ROUTES = {
  post: "https://www.linkedin.com/feed/?shareActive=true",
  messages: "https://www.linkedin.com/messaging/",
};
$("post").addEventListener("click", () => (location.href = ROUTES.post));
$("messages").addEventListener("click", () => (location.href = ROUTES.messages));

// ── Block commitment ──
const DAY = 86_400_000;
const DURATIONS = [
  { label: "5 min", ms: 5 * 60_000 }, // TEMP: test option — remove before real use
  { label: "1 day", ms: 1 * DAY },
  { label: "1 week", ms: 7 * DAY },
  { label: "2 weeks", ms: 14 * DAY },
  { label: "1 month", ms: 30 * DAY },
];

const els = {
  commit: $("commit"),
  state: $("commitState"),
  title: $("commitTitle"),
  sub: $("commitSub"),
  durations: $("durations"),
  confirm: $("confirm"),
  confirmText: $("confirmText"),
  confirmGo: $("confirmGo"),
};

let pending = null; // { ms, until } awaiting confirmation
let currentBlockUntil = null;

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

// Build the four duration chips once.
DURATIONS.forEach(({ label, ms }) => {
  const btn = document.createElement("button");
  btn.className = "seg__btn";
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", () => choose(ms, btn));
  els.durations.appendChild(btn);
});

// Size the segmented control to however many durations exist.
els.durations.style.gridTemplateColumns = `repeat(${DURATIONS.length}, 1fr)`;

// A chip can only ever push the deadline further out, never closer.
function targetFor(ms) {
  const now = Date.now();
  const base = isBlocked(currentBlockUntil) ? currentBlockUntil : now;
  return Math.max(base, now + ms);
}

function choose(ms, btn) {
  const until = targetFor(ms);

  // If already blocked, a shorter pick wouldn't change anything — ignore it
  // so the confirm never implies a (forbidden) early exit.
  if (isBlocked(currentBlockUntil) && until <= currentBlockUntil) {
    pending = null;
    renderPending();
    return;
  }

  pending = { ms, until };
  [...els.durations.children].forEach((c) =>
    c.classList.toggle("is-pending", c === btn)
  );
  renderPending();
}

function renderPending() {
  if (!pending) {
    els.confirm.hidden = true;
    return;
  }
  const verb = isBlocked(currentBlockUntil) ? "Extend the block to" : "Block the feed until";
  els.confirmText.innerHTML = `${verb} <strong>${fmtDate(pending.until)}</strong>. No undo.`;
  els.confirm.hidden = false;
}

els.confirmGo.addEventListener("click", () => {
  if (!pending) return;
  if (store) store.local.set({ blockUntil: pending.until });
  pending = null;
});

function render(blockUntil) {
  currentBlockUntil = blockUntil;
  const blocked = isBlocked(blockUntil);
  els.commit.classList.toggle("is-blocked", blocked);

  if (blocked) {
    els.state.textContent = "Blocked";
    els.title.hidden = false;
    els.title.textContent = `${fmtRemaining(blockUntil - Date.now())} left`;
    els.sub.textContent = `Locked until ${fmtDate(blockUntil)} — extend below, never shorten.`;
  } else {
    els.state.textContent = "Not blocked";
    els.title.hidden = true;
    els.sub.textContent = "Commit to a stretch. No early exit — you can only extend it.";
  }

  // A live deadline change invalidates any pending selection.
  pending = null;
  [...els.durations.children].forEach((c) => c.classList.remove("is-pending"));
  renderPending();
}

// `chrome.storage` is absent in a plain browser preview — degrade gracefully.
const store = typeof chrome !== "undefined" && chrome.storage ? chrome.storage : null;

if (store) {
  store.local.get({ blockUntil: null }, ({ blockUntil }) => render(blockUntil));
  store.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.blockUntil) render(changes.blockUntil.newValue);
  });
} else {
  render(null);
}

// Keep the "X left" countdown honest while the hub sits open.
setInterval(() => {
  if (isBlocked(currentBlockUntil)) render(currentBlockUntil);
}, 60_000);
