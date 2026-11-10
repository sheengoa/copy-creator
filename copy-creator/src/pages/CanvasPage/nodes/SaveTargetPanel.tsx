import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../../../components/Icons";
import type { ResourceFolder } from "../../../types";
import { useCanvasStore, type CanvasNode } from "../../../stores/canvasStore";
import { flattenResourceGroups, type SaveGroupRow } from "./saveTarget";
import { useSaveRuntime } from "./saveRuntimeCtx";
import { WheelGate } from "./WheelGate";

// 保存目标配置面板（2026-11-10 内嵌化，用户定案「从节点扩展出来，确定
// 后收起，不显乱」）：不再做悬浮弹层——面板直接渲染在节点目标行下方
// （SaveMediaBody），配置区是节点的一部分，确定/收起后节点恢复原状，
// 画布永不被遮挡，也无翻转/视口推算。库目标配「名称 + 分组树」，指定
// 路径目标配「名称 + 重新选目录」。收起：标题行 × / Esc / 点节点外。
// 确定即写详情——详情纳入指纹，管线自动对现有产物重存一份（旧文件保
// 留，冲突加 (1) 序号不覆盖，见 saveTarget.ts）。
//
// 宽度守护（用户 2026-11-11 反馈「节点尺寸不够显示选项时自动调整」）：
// 面板理想宽 222（= 默认 250 节点的内容宽减边框，，按钮行 nowrap 实测单行下限），
// 展开时节点逻辑宽不足 250 则加宽到 250（走 commitLayout 落库，与拖拽
// 手柄同管道，只改 width、高度仍自适应）；加宽持久保留，收起不缩回
// （避免节点尺寸来回跳）。比较用 offsetWidth（布局像素）而非
// getBoundingClientRect（屏幕系，视图缩放 ≠100% 时会误判）。
const PANEL_MIN_WIDTH = 222;
const NODE_FORM_PADDING = 24;

export function SaveTargetPanel({ node, onClose }: { node: CanvasNode; onClose: () => void }) {
  const { t } = useTranslation();
  const runtime = useSaveRuntime();
  const meta = node.metadata;
  const isSaveMeta =
    meta.kind === "save_image" || meta.kind === "save_video" || meta.kind === "save_audio";
  const [name, setName] = useState(isSaveMeta ? (meta.auto_name ?? "") : "");
  const [group, setGroup] = useState(isSaveMeta ? (meta.auto_group ?? "") : "");
  const [rows, setRows] = useState<SaveGroupRow[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void invoke<ResourceFolder[]>("get_resource_groups")
      .then((folders) => {
        if (alive) setRows(flattenResourceGroups(folders));
      })
      .catch(() => {
        // 分组树加载失败：保留已选值，列表留空（确定仍可用）
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // 点节点外收起：面板与宿主节点内的点击不收（目标行 toggle 自理）。
    const onOutside = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (panelRef.current?.contains(target)) return;
      if (panelRef.current?.closest(".pc-node")?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [onClose]);

  // 展开期间宿主节点抬升：相邻节点重叠时配置区不被后序兄弟盖住
  // （pc-node 的 backdrop-filter 自成堆叠上下文，z-index 锁在节点层内）。
  useEffect(() => {
    const host = panelRef.current?.closest(".pc-node") as HTMLElement | null;
    if (!host) return;
    const prev = host.style.zIndex;
    host.style.zIndex = "70";
    return () => {
      host.style.zIndex = prev;
    };
  }, []);

  // 宽度守护：节点逻辑宽不足面板理想宽时自动加宽节点（paint 前完成，
  // 不闪窄帧）。只改 width 落布局，height 仍自适应；加宽持久保留。
  useLayoutEffect(() => {
    const host = panelRef.current?.closest(".pc-node") as HTMLElement | null;
    if (!host) return;
    const need = PANEL_MIN_WIDTH + NODE_FORM_PADDING;
    if (host.offsetWidth >= need - 0.5) return;
    const state = useCanvasStore.getState();
    const current = state.nodes.find((n) => n.id === node.id);
    if (!current) return;
    state.commitLayout(current.canvas_id, [
      { id: current.id, pos_x: current.pos_x, pos_y: current.pos_y, width: need, height: current.height },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅展开挂载时守护一次
  }, []);

  if (meta.kind !== "save_image" && meta.kind !== "save_video" && meta.kind !== "save_audio") return null;
  const isLibrary = meta.auto_target === "library";

  const confirm = () => {
    runtime.setSaveTargetDetails(node.id, isLibrary ? group : "", name.trim());
    onClose();
  };

  return (
    <div
      ref={panelRef}
      className="fc-save-panel"
      role="region"
      aria-label={t("canvas.savePopTitle")}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fc-save-panel-head">
        <span className="fc-save-panel-title">{t("canvas.savePopTitle")}</span>
        <button
          type="button"
          className="fc-save-panel-close"
          aria-label={t("canvas.savePopClose")}
          onClick={onClose}
        >
          {Icons.close}
        </button>
      </div>
      <label className="fc-save-panel-label" htmlFor={`save-panel-name-${node.id}`}>{t("canvas.savePopNameLabel")}</label>
      <input
        id={`save-panel-name-${node.id}`}
        className="fc-save-panel-input"
        type="text"
        value={name}
        placeholder={t("canvas.savePopNamePh")}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="fc-save-panel-hint">{t("canvas.savePopNameHint")}</div>
      {isLibrary ? (
        <>
          <div className="fc-save-panel-label">{t("canvas.savePopGroupLabel")}</div>
          {/* WheelGate：悬浮树上的滚轮只滚列表，不惊动画布缩放 */}
          <WheelGate>
            <div className="fc-save-panel-tree">
              {rows.map((row) => (
                <button
                  key={row.path}
                  type="button"
                  className={`fc-save-panel-item${row.path === group ? " is-active" : ""}`}
                  style={{ paddingLeft: 8 + row.depth * 14 }}
                  aria-pressed={row.path === group}
                  onClick={() => setGroup(row.path)}
                >
                  {Icons.folderFine}
                  <span className="fc-save-panel-item-name">{row.path === "" ? t("canvas.savePopUngrouped") : row.label}</span>
                  <span className="fc-save-panel-item-count">{row.count}</span>
                </button>
              ))}
              {rows.length === 0 && <div className="fc-save-panel-empty">{t("canvas.savePopGroupEmpty")}</div>}
            </div>
          </WheelGate>
        </>
      ) : (
        <div className="fc-save-panel-dirhint">{t("canvas.savePopDirHint", { dir: meta.auto_dir ?? "" })}</div>
      )}
      <div className="fc-save-panel-foot">
        <button
          type="button"
          className="fc-save-panel-link"
          onClick={() => {
            onClose();
            void runtime.pickSaveAutoDir(node.id);
          }}
        >
          {isLibrary ? t("canvas.savePopUseDir") : t("canvas.savePopRePickDir")}
        </button>
        <button type="button" className="fc-save-panel-ghost" onClick={() => { setName(""); setGroup(""); }}>
          {t("canvas.savePopReset")}
        </button>
        <button type="button" className="fc-save-panel-ok" onClick={confirm}>
          {t("canvas.savePopOk")}
        </button>
      </div>
    </div>
  );
}
