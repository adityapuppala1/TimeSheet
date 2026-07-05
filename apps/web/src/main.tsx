/**
 * WHAT: Vite/React entry point — mounts `<App/>` into `#root` in `StrictMode`.
 * WHY a separate file from App.tsx: keeps the DOM-mounting concern (which only ever runs once,
 * in the browser) separate from the router/provider tree App.tsx builds (which is what actually
 * grows over time as pages are added).
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

