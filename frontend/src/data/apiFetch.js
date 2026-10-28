// frontend/src/data/apiFetch.js
//
// Drop-in for fetch() on the old /api/* URLs: the request is answered in the
// browser by the ported routes (routes.js) instead of the Express server, so
// the components keep their URLs, params and response handling unchanged.
// Returns the parts of a Response the app uses: ok, status, statusText, json().

import { getApi } from "./engine.js";
import { trackRequest } from "../pendingRequests";

const abortError = () => new DOMException("The operation was aborted.", "AbortError");
// One value per key, the first (as the server's query parser does).
const firstValues = (params) => {
  const out = {};
  for (const [k, v] of params) if (!(k in out)) out[k] = v;
  return out;
};

export async function apiFetch(input, init = {}) {
  const url = new URL(String(input), window.location.href);
  const at = url.pathname.indexOf("/api/");
  if (at < 0) return fetch(input, init);

  const { signal } = init;
  if (signal?.aborted) throw abortError();

  const work = getApi().then((api) =>
    api.handle(url.pathname.slice(at), firstValues(url.searchParams))
  );
  // Counted until the caller stops waiting: on an abort the query may still
  // run, but nothing on screen depends on it any more.
  const result = await trackRequest(signal
    ? Promise.race([
        work,
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true })),
      ])
    : work);
  const { status, body } = result;

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : String(status),
    json: async () => body,
  };
}
