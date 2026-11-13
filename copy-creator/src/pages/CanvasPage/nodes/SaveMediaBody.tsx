import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { useNodeErrors } from "./nodeErrors";
import { NodeHint } from "./NodeHint";
import { SaveMediaBox } from "./SaveMediaBox";
import { SaveTargetPanel } from "./SaveTargetPanel";
import { useSaveRuntime } from "./saveRuntimeCtx";
import type { NodeProps } from "./types";

// 保存三族内容层（三类型 100% 共享，差异仅产物形态）：断链图形 → 目标
// 选择组（问号点明二选一）→ 等待产物（骑顶边状态点）/ 产物（SaveMediaBox，
// 失败保留红叉点重试）→ 目标行（分组 · 名称预览，点行在节点内展开配置
// 面板，确定后收起，2026-11-10 用户定案「从节点扩展出来不显乱」）。
// 自动保存管线见 saveRuntime.tsx。
export function SaveMediaBody({ node, services }: NodeProps) {
  const { t } = useTranslation();
  const nodeErrors = useNodeErrors((s) => s.errors);
  const runtime = useSaveRuntime();
  const [panelOpen, setPanelOpen] = useState(false);
  const servicesRef = useRef(services);
  useEffect(() => {
    servicesRef.current = services;
  });
  // 展开（false→true）后守护视口：节点长高可能溢出画布视口（贴底节点
  // 确定按钮会被推出可视区），revealNode 最小平移夹回。ref 取 services
  // 避免父层每渲染新对象导致重复触发。
  useEffect(() => {
    if (panelOpen) servicesRef.current.revealNode(node.id);
  }, [panelOpen, node.id]);
  const meta = node.metadata;
  if (meta.kind !== "save_image" && meta.kind !== "save_video" && meta.kind !== "save_audio") return null;
  const upstream = services.upstream(node.id);
  const hasProduct = !!upstream?.paths.length;
  const autoTarget = meta.auto_target ?? "";
  const autoState = meta.auto_state ?? "";
  const autoError = meta.auto_error ?? "";
  // 目标行文案：库目标=分组名（空=未分组），指定路径=目录路径；名称空=
  // 「用产物原名」弱化显示（2026-11-14 命名一次性：保存成功清名后目标
  // 行一眼可辨「名字已清」）。点击开浮层改分组/基名（详情变更自动重存）。
  const groupName = (meta.auto_group ?? "").trim() || t("canvas.savePopUngrouped");
  const nameText = (meta.auto_name ?? "").trim();
  const targetLabel =
    autoTarget === "dir" ? (
      <span className="fc-save-target-text">{meta.auto_dir ?? ""}</span>
    ) : (
      <span className="fc-save-target-text">
        {groupName}
        <span className="fc-save-target-sep">{" · "}</span>
        <span className={nameText ? undefined : "fc-save-target-default"}>
          {nameText || t("canvas.savePopDefaultName")}
        </span>
      </span>
    );
  // 目标状态点：骑在等待产物区顶边中央（与选择组问号同一位置
  // 语言）。中心为对应目标的精致小版图标（资源库=文件夹、
  // 指定路径=下载），笔画重与问号一致；红叉=失败，点重试；
  // 点绿点回目标选择。产物到位后绿点退场——图像即输出，不
  // 再挂状态点（用户 2026-11-01 定案），输出删掉回到等待态
  // 再恢复；仅保存失败保留红叉点重试。
  const saveDot = (
    <NodeHint
      text={
        autoState === "error"
          ? `${autoError} · ${t("canvas.saveAutoRetry")}`
          : autoState === "saving"
            ? t("canvas.saveAutoSaving")
            : `${autoTarget === "dir" ? (meta.auto_dir ?? "").split(/[\\/]/).pop() : t("canvas.saveAutoLibraryLbl")} · ${t("canvas.saveAutoChange")}`
      }
    >
      <button
        type="button"
        className={`fc-save-dot${autoState === "error" ? " is-error" : ""}${autoState === "saving" ? " is-saving" : ""}`}
        aria-label={
          autoState === "error"
            ? t("canvas.saveAutoRetry")
            : autoTarget === "dir"
              ? (meta.auto_dir ?? "")
              : t("canvas.saveAutoLibraryLbl")
        }
        onClick={autoState === "error" ? () => runtime.retrySaveAuto(node.id) : () => runtime.clearSaveAutoTarget(node.id)}
      >
        <span className="fc-save-dot-ring">
          {autoState === "error" ? Icons.close : autoTarget === "dir" ? Icons.saveTrayFine : Icons.folderFine}
        </span>
      </button>
    </NodeHint>
  );
  return (
    <>
      <div className="fc-node-form">
        {!upstream ? (
          /* 未连接：断链图形，无文字 */
          <div className="fc-save-wait">{Icons.link}</div>
        ) : !autoTarget ? (
          /* 连线后的下一步：虚线选择组（问号点明二选一），点选即设 */
          <div className="fc-save-choose">
            <span className="fc-save-help">{Icons.help}</span>
            <NodeHint text={t("canvas.saveAutoLibrary")}>
              <button
                type="button"
                className="fc-save-opt"
                aria-label={t("canvas.saveAutoLibrary")}
                onClick={() => runtime.setSaveAutoTarget(node.id, "library", "")}
              >
                {Icons.folderFine}
              </button>
            </NodeHint>
            <NodeHint text={t("canvas.saveAutoDir")}>
              <button
                type="button"
                className="fc-save-opt"
                aria-label={t("canvas.saveAutoDir")}
                onClick={() => void runtime.pickSaveAutoDir(node.id)}
              >
                {Icons.saveTrayFine}
              </button>
            </NodeHint>
          </div>
        ) : (
          <>
            {/* 目标已设：等待产物时骑等待区顶边中央的 16px 状态点
                （外环 + 内圈 + 对应目标的精致小版图标，与问号同构
                同笔画重）——绿=就绪，点回目标选择，悬停浮出目
                标名。产物一到媒体盒即输出本身，状态点退场（用
                户 2026-11-01 定案：有图就不显示小绿点，输出删掉
                回到等待态再恢复）；仅保存失败保留红叉点重试。 */}
            {!hasProduct ? (
              /* 等待产物：沙漏图形（更高的区域） */
              <div className="fc-save-stage">
                {saveDot}
                {Icons.hourglass}
              </div>
            ) : (
              <div className="fc-save-stage filled">
                {autoState === "error" && saveDot}
                {/* 多图观看：单图/缩略图格由 +N 角标切换（SaveMediaBox） */}
                <SaveMediaBox
                  paths={upstream.paths}
                  kind={node.type === "save_image" ? "image" : node.type === "save_video" ? "video" : "audio"}
                />
              </div>
            )}
            {autoState === "error" && autoError && <div className="fc-gen-warn">{autoError}</div>}
            {/* 目标行：分组 · 名称 一眼可见；点行节点内展开配置面板（toggle） */}
            <button
              type="button"
              className="fc-save-target"
              aria-label={t("canvas.savePopTitle")}
              aria-expanded={panelOpen}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setPanelOpen((open) => !open);
              }}
            >
              {autoTarget === "dir" ? Icons.saveTrayFine : Icons.folderFine}
              {targetLabel}
              <span className="fc-save-target-edit">{panelOpen ? Icons.chevronDown : Icons.edit}</span>
            </button>
            {/* 配置面板：节点内嵌展开（非悬浮层），确定/收起后节点恢复原状 */}
            {panelOpen && <SaveTargetPanel node={node} onClose={() => setPanelOpen(false)} />}
          </>
        )}
        {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
      </div>
    </>
  );
}
