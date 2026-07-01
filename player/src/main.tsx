import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/globals.css";

// QA SP-007 hardening: disable the WebView's native right-click menu in ALL
// builds so the playing <video> has no "Save video as / Save frame as image /
// Copy video address / Inspect" entries, and block dragging the video out.
// NOTE: DevTools ("Inspect" via F12) is a SEPARATE concern — it is compiled OUT
// of the release build (player Cargo.toml enables no `devtools` feature); it is
// only present in `tauri dev`. The shipped .msi has no DevTools at all.
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("dragstart", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
