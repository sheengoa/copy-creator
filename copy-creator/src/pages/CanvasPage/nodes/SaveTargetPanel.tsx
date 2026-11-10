import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../../../components/Icons";
import type { ResourceFolder } from "../../../types";
import type { CanvasNode } from "../../../stores/canvasStore";
import { flattenResourceGroups, type SaveGroupRow } from "./saveTarget";
import { useSaveRuntime } from "./saveRuntimeCtx";

// 保存目标配置面板（2026-11-10 内嵌化，用户定案「从节点扩展出来，确定
// 后收起，不显乱」）：不再做悬浮弹层——面板直接渲染在节点目标行下方
// （SaveMediaBody），配置区是节点的一部分，确定/收起后节点恢复原状，
// 画布永不被遮挡，也无翻转/视口推算。库目标配「名称 + 分组树」，指定
// 路径目标配「名称 + 重新选目录」。收起：标题行 × / Esc / 点节点外。
// 确定即写详情——详情纳入指纹，管线自动对现有产物重存一份（旧文件保
// 留，冲突加 (1) 序号不覆盖，见 saveTarget.ts）。
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
