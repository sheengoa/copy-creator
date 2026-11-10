import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
// 避免误触画布手势。标题行 × 显式关闭（另有 Esc / 点外部）。确定即写
// 详情——详情纳入指纹，管线自动对现有产物重存一份（旧文件保留，冲突
// 加 (1) 序号不覆盖，见 saveTarget.ts）。
//
// 视口自适应（用户反馈：节点贴画布下缘时浮层不得弹到可视区外）：
// 打开与分组树加载后按「假设默认下方放置」的几何推算（节点 rect + 浮层
// 实高，坐标系换算带视口缩放 scale），下方溢出且上方放得下则翻到节点
// 上方，两侧都不足则 clamp 贴视口底；水平同理 clamp 在视口内。
const POPOVER_GAP = 8;
const VIEWPORT_INSET = 8;

export function SaveTargetPopover({
  node,
  scale,
  onClose,
}: {
  node: CanvasNode;
  scale: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runtime = useSaveRuntime();
  const meta = node.metadata;
  const isSaveMeta =
    meta.kind === "save_image" || meta.kind === "save_video" || meta.kind === "save_audio";
  const [name, setName] = useState(isSaveMeta ? (meta.auto_name ?? "") : "");
  const [group, setGroup] = useState(isSaveMeta ? (meta.auto_group ?? "") : "");
  const [rows, setRows] = useState<SaveGroupRow[]>([]);
  const [placement, setPlacement] = useState<"bottom" | "top" | "clamp">("bottom");
  const [shift, setShift] = useState({ x: 0, y: 0 });
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

  // 视口自适应推算：CSS 默认下方放置（top: calc(100%+8px)、left:10px），
  // 全部以「bottom 假设」推几何，对当前 placement 幂等（树加载撑高后重跑）。
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    const host = pop.closest(".pc-node");
    const main = pop.closest(".canvas-main");
    if (!host || !main) return;
    const view = Math.max(scale, Number.EPSILON);
    const nodeRect = host.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const popW = popRect.width;
    const popH = popRect.height;
    const gap = POPOVER_GAP * view;
    const inset = VIEWPORT_INSET * view;

    // ── 垂直：默认下方 → 溢出且上方放得下翻到上方，否则 clamp 贴底 ──
    const bottomTop = nodeRect.bottom + gap;
    const overflowBottom = bottomTop + popH - (mainRect.bottom - inset);
    let nextPlacement: "bottom" | "top" | "clamp" = "bottom";
    let nextShiftY = 0;
    if (overflowBottom > 0) {
      const spaceAbove = nodeRect.top - gap - (mainRect.top + inset);
      if (spaceAbove >= popH + gap) {
        nextPlacement = "top";
      } else {
        nextPlacement = "clamp";
        // clamp：从默认位置上移溢出量，浮层底边贴视口底（可盖住节点）。
        nextShiftY = -overflowBottom / view;
      }
    }

    // ── 水平：默认 left:10px → 左右溢出各 clamp 回视口（双侧都窄贴左） ──
    const leftAtDefault = nodeRect.left + 10 * view;
    let nextShiftX = 0;
    const overflowLeft = leftAtDefault - (mainRect.left + inset);
    const overflowRight = leftAtDefault + popW - (mainRect.right - inset);
    if (overflowLeft > 0) nextShiftX = -overflowLeft / view;
    else if (overflowRight > 0) nextShiftX = -overflowRight / view;

    setPlacement(nextPlacement);
    setShift({ x: nextShiftX, y: nextShiftY });
  }, [rows, scale]);

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
      style={{
        left: `calc(10px + ${shift.x}px)`,
        ...(placement === "top"
          ? { top: "auto", bottom: `calc(100% + ${POPOVER_GAP}px)` }
          : placement === "clamp"
            ? { top: `calc(100% + ${POPOVER_GAP + shift.y}px)` }
            : {}),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fc-save-pop-head">
        <span className="fc-save-pop-title">{t("canvas.savePopTitle")}</span>
        <button
          type="button"
          className="fc-save-pop-close"
          aria-label={t("canvas.savePopClose")}
          onClick={onClose}
        >
          {Icons.close}
        </button>
      </div>
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
