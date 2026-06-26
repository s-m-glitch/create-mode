// mock-pay.js — stand-in for Stripe checkout. Marks the break "paid" in
// chrome.storage so the hub's poll unlocks. Replaced by real Stripe Payment
// Links + webhook in production.

const params = new URLSearchParams(location.search);
const nonce = params.get("nonce");
const price = params.get("price") || "0";

document.getElementById("amount").textContent = `$${price}`;

document.getElementById("pay").addEventListener("click", () => {
  if (typeof chrome !== "undefined" && chrome.storage && nonce) {
    chrome.storage.local.set({ [`paid:${nonce}`]: true });
  }
  document.getElementById("checkout").style.display = "none";
  document.getElementById("done").style.display = "block";
});
