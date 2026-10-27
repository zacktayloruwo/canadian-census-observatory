// src/pendingRequests.js
//
// Data requests in flight, for the loading indicator (DataLoadingIndicator.jsx):
// `slow` turns true once requests have been pending SLOW_AFTER_MS without a
// break, so quick queries never flash a spinner. Shaped for React's
// useSyncExternalStore. Each edition's apiFetch (data/edition.js) wraps its
// requests in trackRequest().

const SLOW_AFTER_MS = 400;
let pending = 0;
let slow = false;
let slowTimer = null;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
function setPending(n) {
  pending = n;
  if (pending > 0 && !slowTimer && !slow) {
    slowTimer = setTimeout(() => { slowTimer = null; slow = true; emit(); }, SLOW_AFTER_MS);
  } else if (pending === 0) {
    clearTimeout(slowTimer);
    slowTimer = null;
    if (slow) { slow = false; emit(); }
  }
}
export const pendingRequests = {
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  isSlow: () => slow,
};

// Counts `promise` as pending until it settles; returns it unchanged.
export async function trackRequest(promise) {
  setPending(pending + 1);
  try {
    return await promise;
  } finally {
    setPending(pending - 1);
  }
}
