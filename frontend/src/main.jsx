// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import "@mantine/core/styles.css";
import "leaflet/dist/leaflet.css";
import "./theme.css";
import { MantineProvider, createTheme, Input } from "@mantine/core";
import App from "./App.jsx";
import { getApi } from "./data/engine.js";
import { TEXT_DIM, BORDER_CONTROL } from "./config";

// Contrast fixes applied once, at the theme, rather than at each call site.
//
// Mantine's default input border is gray-4 (#ced4da, 1.49:1 on white), below the
// 3:1 WCAG 1.4.11 asks of a control boundary.  Overriding the Input component is
// preferred to redefining --mantine-color-gray-4, which is used elsewhere.
const theme = createTheme({
  components: {
    Input: Input.extend({
      styles: { input: { borderColor: BORDER_CONTROL } },
    }),
  },
});

// Three greys, all measured too light against white, all fixable at the variable
// rather than the call site:
//   --mantine-color-dimmed          #868e96  3.32:1  every `c="dimmed"`
//   --mantine-color-placeholder     #adb5bd  2.07:1  every Select/TextInput
//   --mantine-color-disabled-color  #adb5bd  2.07:1  disabled control labels
// The last one matters most: a disabled control still states the current value
// (the Percent segment says which mode the map is in), so it has to stay legible.
const cssVariablesResolver = () => ({
  variables: {},
  light: {
    "--mantine-color-dimmed": TEXT_DIM,
    "--mantine-color-placeholder": TEXT_DIM,
    "--mantine-color-disabled-color": TEXT_DIM,
  },
  dark: {
    "--mantine-color-dimmed": "#9aa0a6",
    "--mantine-color-placeholder": "#9aa0a6",
    "--mantine-color-disabled-color": "#9aa0a6",
  },
});

// Start the data engine (DuckDB-WASM + lookups) now rather than at the first
// API call from an effect, so it loads while React renders the shell.
getApi().catch((err) => console.error("[data] start-up failed:", err));

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MantineProvider
      defaultColorScheme="light"
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
    >
      <App />
    </MantineProvider>
  </React.StrictMode>
);
