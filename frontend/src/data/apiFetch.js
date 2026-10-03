// frontend/src/data/apiFetch.js
//
// Drop-in for fetch() on the old /api/* URLs: the request is answered in the
// browser by the ported routes (routes.js) instead of the Express server, so
// the components keep their URLs, params and response handling unchanged.
// Returns the parts of a Response the app uses: ok, status, statusText, json().

import { getApi } from "./engine.js";

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
  const { status, body } = await (signal
    ? Promise.race([
        work,
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true })),
      ])
    : work);

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : String(status),
    json: async () => body,
  };
}
