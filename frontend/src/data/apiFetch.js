// frontend/src/data/apiFetch.js
//
// Drop-in for fetch() on the old /api/* URLs: the request is answered in the
// browser by the ported routes (routes.js) instead of the Express server, so
// the components keep their URLs, params and response handling unchanged.
// Returns the parts of a Response the app uses: ok, status, statusText, json().

import { getApi } from "./engine.js";

// Requests in flight, for the loading indicator (DataLoadingIndicator.jsx):
// `slow` turns true once requests have been pending SLOW_AFTER_MS without a
// break, so quick queries never flash a spinner. Shaped for React's
// useSyncExternalStore.
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

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

export async function apiFetch(input, init = {}) {
  const url = new URL(String(input), window.location.href);
  const at = url.pathname.indexOf("/api/");
  if (at < 0) return fetch(input, init);

  const { signal } = init;
  if (signal?.aborted) throw abortError();

  const work = getApi().then((api) =>
    api.handle(url.pathname.slice(at), Object.fromEntries(url.searchParams))
  );
  // Counted until the caller stops waiting: on an abort the query may still
  // run, but nothing on screen depends on it any more.
  setPending(pending + 1);
  let result;
  try {
    result = await (signal
      ? Promise.race([
          work,
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true })),
        ])
      : work);
  } finally {
    setPending(pending - 1);
  }
  const { status, body } = result;

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : String(status),
    json: async () => body,
  };
}
