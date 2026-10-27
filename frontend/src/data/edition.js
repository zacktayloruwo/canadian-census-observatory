// src/data/edition.js — static (DuckDB-WASM) edition
//
// Everything the shared frontend needs that differs between the two editions.
// The server edition (unicen_js) has its own copy of this file with the same
// exports; tools/sync-frontend.sh copies every other frontend file from there.
//
//   API_BASE       origin the /api/* URLs are built on
//   apiFetch       fetch() for those URLs
//   startEdition() called once from main.jsx before React renders

import { getApi } from "./engine.js";

// The /api/* URLs are answered in the browser by routes.js (see apiFetch.js);
// the origin only has to make them absolute.
export const API_BASE = window.location.origin;

export { apiFetch } from "./apiFetch.js";

// Start the data engine (DuckDB-WASM + lookups) now rather than at the first
// API call from an effect, so it loads while React renders the shell.
export function startEdition() {
  getApi().catch((err) => console.error("[data] start-up failed:", err));
}
