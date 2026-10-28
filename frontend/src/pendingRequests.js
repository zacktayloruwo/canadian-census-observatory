// src/pendingRequests.js
//
// Data requests in flight, for the loading indicator (DataLoadingIndicator.jsx)
// and the load-error banner (LoadErrorBanner.jsx):
//   slow     turns true once requests have been pending SLOW_AFTER_MS without
//            a break, so quick queries never flash a spinner
//   busy     any request in flight
//   failure  the last failed request (network error, a thrown query in the
//            static edition, or an HTTP 5xx; a 404 is a normal "no data")
//            until a later burst of requests completes with no failure
// Shaped for React's useSyncExternalStore. Each edition's apiFetch
// (data/edition.js) wraps its requests in trackRequest().

const SLOW_AFTER_MS = 400;
let pending = 0;
let slow = false;
let slowTimer = null;
let failure = null;           // { message } | null
let failedInBurst = false;    // a failure since the last idle moment
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
function setPending(n) {
  const wasIdle = pending === 0;
  pending = n;
  if (wasIdle && pending > 0) { failedInBurst = false; emit(); }
  if (pending > 0 && !slowTimer && !slow) {
    slowTimer = setTimeout(() => { slowTimer = null; slow = true; emit(); }, SLOW_AFTER_MS);
  } else if (pending === 0) {
    clearTimeout(slowTimer);
    slowTimer = null;
    slow = false;
    if (!failedInBurst) failure = null;   // a clean burst clears the banner
    emit();
  }
}
function fail(message) {
  failedInBurst = true;
  failure = { message };
  emit();
}
export const pendingRequests = {
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  isSlow: () => slow,
  isBusy: () => pending > 0,
  getFailure: () => failure,
};

// Counts `promise` as pending until it settles and records a failure;
// returns (or rethrows) it unchanged.
export async function trackRequest(promise) {
  setPending(pending + 1);
  try {
    const res = await promise;
    if (res && typeof res.status === "number" && res.status >= 500) fail(`server error ${res.status}`);
    return res;
  } catch (err) {
    if (err?.name !== "AbortError") fail(err?.message ? String(err.message).slice(0, 120) : "network error");
    throw err;
  } finally {
    setPending(pending - 1);
  }
}
