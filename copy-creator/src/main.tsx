import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/index.css";
import "./i18n";

const params = window.location.search;
const isRadialWindow = params.includes("radial=1");
const isClipboardCreateWindow = params.includes("clipboard-create=1");

// 每种窗口只加载自己需要的根组件，避免弹窗窗口解析整套主应用代码。
const loadRoot = async () => {
  if (isRadialWindow) return (await import("./components/RadialMenu")).default;
  if (isClipboardCreateWindow) return (await import("./components/ClipboardCreateDialog")).default;
  return (await import("./App")).default;
};

void loadRoot().then((Root) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
});
