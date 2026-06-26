// feed-guard.js — runs in the PAGE (MAIN) world, not the isolated content
// script world.
//
// LinkedIn is a single-page app: it swaps the URL with history.pushState /
// replaceState and renders the feed WITHOUT a network request, so the
// declarativeNetRequest redirect never sees those hops. A content script in
// the isolated world can't intercept the page's own History object (separate
// JS worlds), so this minimal shim runs in the page world: it wraps the
// history methods and forwards a DOM event after every client-side
// navigation. content.js listens for that event and decides whether to
// bounce the route. This shim changes nothing else about the page.
(() => {
  const ping = () => window.dispatchEvent(new Event("create-mode:nav"));

  const wrap = (original) =>
    function () {
      const result = original.apply(this, arguments);
      ping();
      return result;
    };

  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener("popstate", ping);
})();
