import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icons } from "../../components/Icons";
import { useCanvasStore, type CanvasSummary } from "../../stores/canvasStore";

// 画布区（自由生图工作流）页面骨架：顶部画布库条（chips + 新建 + 每画布
// 「⋯」菜单：重命名/删除）+ 主画布区。主画布由 FreeCanvas 承载（阶段 1d
// 接入），本文件持骨架与画布库管理；删除确认文案注明资源库文件不受影响。
export default function CanvasPage() {
  const { t } = useTranslation();
  const canvases = useCanvasStore((s) => s.canvases);
  const activeCanvasId = useCanvasStore((s) => s.activeCanvasId);
  const loadCanvases = useCanvasStore((s) => s.loadCanvases);
  const openCanvas = useCanvasStore((s) => s.openCanvas);
  const createCanvas = useCanvasStore((s) => s.createCanvas);
  const renameCanvas = useCanvasStore((s) => s.renameCanvas);
  const deleteCanvas = useCanvasStore((s) => s.deleteCanvas);
  const bindCanvasEvents = useCanvasStore((s) => s.bindCanvasEvents);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [deleting, setDeleting] = useState<CanvasSummary | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bindCanvasEvents();
    void loadCanvases();
  }, [bindCanvasEvents, loadCanvases]);

  // 「⋯」弹层点外即关。
  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuFor]);

  // 重命名弹窗打开时聚焦全选，直接输入即覆盖默认名。
  useEffect(() => {
    if (renaming) {
      requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    }
  }, [renaming]);

  const activeCanvas = canvases.find((c) => c.id === activeCanvasId) ?? null;

  const submitRename = async () => {
    if (!renaming) return;
    const name = renameInput.trim();
    if (!name) return;
    await renameCanvas(renaming.id, name);
    setRenaming(null);
  };

  return (
    <div className="canvas-page">
      <div className="canvas-topbar">
        <div className="canvas-chips">
          {canvases.map((canvas) => (
            <div
              key={canvas.id}
              className={`canvas-chip ${canvas.id === activeCanvasId ? "active" : ""}`}
              onClick={() => {
                if (canvas.id !== activeCanvasId) void openCanvas(canvas.id);
              }}
              title={t("canvas.canvasMeta", {
                node: canvas.node_count,
                conn: canvas.connection_count,
              })}
            >
              <span>{canvas.name}</span>
              <span
                className="canvas-chip-menu"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor((prev) => (prev === canvas.id ? null : canvas.id));
                }}
              >
                {Icons.more}
              </span>
              {menuFor === canvas.id && (
                <div
                  className="canvas-chip-popover"
                  ref={popoverRef}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => {
                      setRenaming({ id: canvas.id, name: canvas.name });
                      setRenameInput(canvas.name);
                      setMenuFor(null);
                    }}
                  >
                    {Icons.edit}
                    {t("canvas.rename")}
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      setDeleting(canvas);
                      setMenuFor(null);
                    }}
                  >
                    {Icons.delete}
                    {t("canvas.delete")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <button className="canvas-new-btn" onClick={() => void createCanvas()}>
          {Icons.add}
          {t("canvas.newCanvas")}
        </button>
      </div>

      <div className="canvas-main">
        {activeCanvas ? (
          // 阶段 1d 替换为 <FreeCanvas canvasId={activeCanvas.id} />。
          <div className="canvas-empty">
            <span className="canvas-empty-icon">{Icons.canvas}</span>
            <span className="canvas-empty-title">{activeCanvas.name}</span>
            <span className="canvas-empty-hint">
              {t("canvas.canvasMeta", {
                node: activeCanvas.node_count,
                conn: activeCanvas.connection_count,
              })}
            </span>
          </div>
        ) : (
          <div className="canvas-empty">
            <span className="canvas-empty-icon">{Icons.canvas}</span>
            <span className="canvas-empty-title">{t("canvas.empty")}</span>
            <span className="canvas-empty-hint">{t("canvas.emptyHint")}</span>
          </div>
        )}
      </div>

      {renaming && (
        <div
          className="canvas-dialog-overlay"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setRenaming(null);
          }}
        >
          <div className="canvas-dialog">
            <div className="canvas-dialog-title">{t("canvas.renameTitle")}</div>
            <input
              ref={renameInputRef}
              className="canvas-dialog-input"
              value={renameInput}
              placeholder={t("canvas.namePlaceholder")}
              onChange={(e) => setRenameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
            <div className="canvas-dialog-actions">
              <button onClick={() => setRenaming(null)}>{t("common.cancel")}</button>
              <button className="primary" onClick={() => void submitRename()}>
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          message={t("canvas.deleteConfirm", { name: deleting.name })}
          onConfirm={async () => {
            await deleteCanvas(deleting.id);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
