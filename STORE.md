# Publishing Create Mode — Chrome Web Store (Unlisted)

"Unlisted" means anyone with the link can install it, but it won't appear in
search or the public store. It still goes through Google's review (usually a few
hours to a few days), and once approved it installs like any normal extension
and **auto-updates**.

## Build artifacts (already generated — in `dist/`, git-ignored)

- **`dist/create-mode.zip`** — the package you upload.
- **`dist/screenshot.png`** — 1280×800 listing screenshot.

Rebuild the zip anytime after code changes:

```sh
cd ~/Desktop/time
rm -f dist/create-mode.zip
zip -q dist/create-mode.zip manifest.json background.js content.js feed-guard.js \
  hub.html hub.css hub.js rules.json \
  icons/icon16.png icons/icon48.png icons/icon128.png \
  fonts/switzer-400.woff2 fonts/switzer-500.woff2 fonts/switzer-700.woff2 fonts/switzer-800.woff2
```

## One-time account setup

1. Open the **Developer Dashboard**: <https://chrome.google.com/webstore/devconsole>
2. Sign in with the Google account you want to own the extension.
3. Pay the **one-time $5** registration fee and verify your email.

## Create & submit the item

1. **Add new item** → upload `dist/create-mode.zip`.
2. Fill in the listing (copy below).
3. Add `dist/screenshot.png` under **Screenshots**.
4. Set **Visibility → Unlisted**.
5. **Submit for review.** After approval you'll get a shareable install link.

---

## Listing copy (paste-ready)

**Name:** Create Mode

**Summary** (≤132 chars):
> Use LinkedIn to create, don't consume. Blocks the home feed and notifications; keeps posting and messaging fully working.

**Category:** Productivity  **Language:** English

**Detailed description:**

> Create Mode turns LinkedIn into a tool for creating instead of scrolling.
>
> When you commit to a block, the home feed and notifications are redirected — at
> the network layer, before they render — to a clean "Create Hub" with two doors:
> write a post, or open your messages. Everything you need to create stays fully
> functional; the infinite scroll and the notification dopamine loop simply
> aren't reachable.
>
> It's a commitment device, not a toggle. You choose how long to block — a day, a
> week, two weeks, a month — and there's no early exit. You can only ever extend a
> block, never cut it short. When the time is up, the block lifts on its own.
>
> • Blocks the home feed and notifications
> • Keeps posting, the composer, messaging, and profiles working
> • Timed commitments — break early only by paying a stake you set
> • No account, no tracking, no analytics
>
> Thesis: create, don't consume.

---

## Single purpose (paste-ready)

> Create Mode blocks LinkedIn's consumption surfaces (the home feed and
> notifications) for a user-committed time period, while keeping creation
> surfaces (posting and messaging) fully functional.

## Permission justifications (paste-ready, per permission)

- **declarativeNetRequest** — Redirects the LinkedIn home feed and notifications
  pages to the extension's own Create Hub at the network layer, so those pages
  never load while a block is active.
- **storage** — Stores a single value locally (the block's end timestamp) so the
  block persists across browser restarts.
- **alarms** — Schedules a timer to automatically end the block when the
  committed period expires.
- **Host permission `*://*.linkedin.com/*`** — Needed to redirect feed/
  notifications requests on linkedin.com, hide the feed behind the post composer,
  and redirect already-open LinkedIn tabs when a block begins.
- **Host permission `https://create-mode-api.vercel.app/*`** — Used only when a
  user chooses to pay to break a lock early: the extension checks our own
  endpoint whether that payment cleared.

## Privacy / data use answers

- **Does this item collect user data?** No personal data.
- **Data sold/transferred?** No.
- **What it stores:** one local timestamp (`blockUntil`) in `chrome.storage.local`.
  No account, no analytics.
- **Network:** none during normal use. Only when a user chooses to **pay to break
  a lock**, the extension (a) opens Stripe's hosted checkout and (b) polls our
  backend with a random, anonymous id to learn whether that payment cleared.
  Payment is handled entirely by Stripe; card data never touches the extension.
  No personal data is sent to our backend.
- **Remote code?** No. No executable remote code, and **no external requests at
  all** — the Switzer font is bundled locally (`fonts/`), so the extension works
  fully offline during normal use.

---

## Pushing updates later

1. Make your changes, bump `"version"` in `manifest.json` (e.g. `1.0.0` → `1.0.1`).
2. Rebuild the zip (command above).
3. Dashboard → your item → **Package → Upload new package** → submit.
4. Installed users auto-update within a few hours.
