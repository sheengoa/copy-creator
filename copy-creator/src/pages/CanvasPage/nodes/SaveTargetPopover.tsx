import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../../../components/Icons";
import type { ResourceFolder } from "../../../types";
import type { CanvasNode } from "../../../stores/canvasStore";
import { flattenResourceGroups, type SaveGroupRow } from "./saveTarget";
import { useSaveRuntime } from "./saveRuntimeCtx";

// 保存目标配置浮层（2026-11-10）：库目标配「名称 + 分组树」，指定路径
// 目标配「名称 + 重新选目录」。挂在节点层（fc-node-form 是滚动容器会
// 裁剪，浮层由调用方渲染在其外、以 pc-node 为定位锚）；指针事件止泡，
// 避免误触画布手势。确定即写详情——详情纳入指纹，管线自动对现有产物
// 重存一份（旧文件保留，冲突加 (1) 序号不覆盖，见 saveTarget.ts）。
export function SaveTargetPopover({ node, onClose }: { node: CanvasNode; onClose: () => void }) {
  const { t } = useTranslation();
  const runtime = useSaveRuntime();
  const meta = node.metadata;
  const isSaveMeta =
    meta.kind === "save_image" || meta.kind === "save_video" || meta.kind === "save_audio";
  const [name, setName] = useState(isSaveMeta ? (meta.auto_name ?? "") : "");
  const [group, setGroup] = useState(isSaveMeta ? (meta.auto_group ?? "") : "");
  const [rows, setRows] = useState<SaveGroupRow[]>([]);
  const popRef = useRef<HTMLDivElement>(null);

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
    const onOutside = (event: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as globalThis.Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [onClose]);

  // 节点重叠时浮层不被后序兄弟节点盖住：pc-node 的 backdrop-filter 自成
  // 堆叠上下文，浮层 z-index 锁在节点层内——打开期间把宿主节点整体
  // 抬升到画布节点之上，关闭还原。
  useEffect(() => {
    const host = popRef.current?.closest(".pc-node") as HTMLElement | null;
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
      ref={popRef}
      className="fc-save-pop"
      role="dialog"
      aria-label={t("canvas.savePopTitle")}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fc-save-pop-title">{t("canvas.savePopTitle")}</div>
      <label className="fc-save-pop-label" htmlFor={`save-pop-name-${node.id}`}>{t("canvas.savePopNameLabel")}</label>
      <input
        id={`save-pop-name-${node.id}`}
        className="fc-save-pop-input"
        type="text"
        value={name}
        placeholder={t("canvas.savePopNamePh")}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="fc-save-pop-hint">{t("canvas.savePopNameHint")}</div>
      {isLibrary ? (
        <>
          <div className="fc-save-pop-label">{t("canvas.savePopGroupLabel")}</div>
          <div className="fc-save-pop-tree">
            {rows.map((row) => (
              <button
                key={row.path}
                type="button"
                className={`fc-save-pop-item${row.path === group ? " is-active" : ""}`}
                style={{ paddingLeft: 10 + row.depth * 14 }}
                aria-pressed={row.path === group}
                onClick={() => setGroup(row.path)}
              >
                {Icons.folderFine}
                <span className="fc-save-pop-item-name">{row.path === "" ? t("canvas.savePopUngrouped") : row.label}</span>
                <span className="fc-save-pop-item-count">{row.count}</span>
              </button>
            ))}
            {rows.length === 0 && <div className="fc-save-pop-empty">{t("canvas.savePopGroupEmpty")}</div>}
          </div>
        </>
      ) : (
        <div className="fc-save-pop-dirhint">{t("canvas.savePopDirHint", { dir: meta.auto_dir ?? "" })}</div>
      )}
      <div className="fc-save-pop-foot">
        <button
          type="button"
          className="fc-save-pop-link"
          onClick={() => {
            onClose();
            void runtime.pickSaveAutoDir(node.id);
          }}
        >
          {isLibrary ? t("canvas.savePopUseDir") : t("canvas.savePopRePickDir")}
        </button>
        <button type="button" className="fc-save-pop-ghost" onClick={() => { setName(""); setGroup(""); }}>
          {t("canvas.savePopReset")}
        </button>
        <button type="button" className="fc-save-pop-ok" onClick={confirm}>
          {t("canvas.savePopOk")}
        </button>
      </div>
    </div>
  );
}
