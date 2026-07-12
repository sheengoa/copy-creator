import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import RadialMenu from "./components/RadialMenu";
import ClipboardCreateDialog from "./components/ClipboardCreateDialog";
import "./styles/index.css";
import "./i18n";

const params = window.location.search;
const isRadialWindow = params.includes("radial=1");
const isClipboardCreateWindow = params.includes("clipboard-create=1");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isRadialWindow ? (
      <RadialMenu />
    ) : isClipboardCreateWindow ? (
      <ClipboardCreateDialog />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
