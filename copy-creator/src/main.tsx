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

// 浏览器直开 dev 页面（无 Tauri 环境）时注入内存后端，供前端验证与模拟；
// Tauri 应用存在 __TAURI_INTERNALS__，本分支不会执行。import.meta.env.DEV
// 是构建期条件：生产构建中 Vite 将其替换为 false，整个 mock 层（tauriMock
// chunk 连同 mock 媒体资产）成为死代码被摇树剔除，不进发布产物；dev 下
// 运行时判断照常生效。
const boot = async () => {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installBrowserMock } = await import("./dev/tauriMock");
    installBrowserMock();
  }
  return loadRoot();
};

// 根级崩溃兜底：渲染层任何未捕获异常会清空 #root，而透明窗口的空白 =
// 整个应用隐形（2026-11-01「窗口凭空消失」事故的同类根因）。这里兜住
// 渲染异常，保证窗口至少有一块不透明面板与自救入口。文案不经 i18n——
// 崩溃源可能就是 i18n 本身。
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[root] render crash:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "fixed",
            inset: "20px", // 与 --window-shadow-margin / WINDOW_SHADOW_MARGIN 一致
            background: "#FFFFFF",
            borderRadius: 18,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
          }}
        >
          <div style={{ color: "#1C1C1E", fontSize: 14 }}>界面出现异常</div>
          <button
            onClick={() => location.reload()}
            style={{
              padding: "8px 28px",
              borderRadius: 10,
              border: "none",
              background: "#FFFFFF",
              boxShadow:
                "0 1px 3px rgba(0,0,0,0.06), 0 2px 10px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.04)",
              color: "#1C1C1E",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

void boot().then((Root) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <Root />
      </RootErrorBoundary>
    </React.StrictMode>,
  );
});
