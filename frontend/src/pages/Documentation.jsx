// src/pages/Documentation.jsx
// Sourced live from the external documentation site — no HTML is bundled here.
export default function Documentation() {
  return (
    <iframe
      src="https://zacktayloruwo.github.io/unicen_observatory/docs/html/documentation.html"
      title="Documentation"
      style={{
        display: "block",
        width: "100%",
        height: "calc(100vh - var(--app-shell-header-height) - var(--app-shell-footer-height))",
        border: "none",
      }}
    />
  );
}
