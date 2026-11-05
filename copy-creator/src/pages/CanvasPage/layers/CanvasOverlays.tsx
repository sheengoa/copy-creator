import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CanvasNode } from "../../../stores/canvasStore";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { joinLibraryPath } from "../../../domain/projectView";
import ProjectFilePickerDialog from "../../ResourcePage/ProjectFilePickerDialog";
import { useCanvasData } from "../dataContext";
import { NodeHint } from "../nodes/NodeHint";
import { WheelGate } from "../nodes/WheelGate";
import { BatchBar } from "../nodes/BatchBar";
import type { ViewState } from "../engine/useViewport";

// 画布浮层集合（自 FreeCanvas.tsx 渲染区零改动搬运，2026-11-03 引擎拆分
// 阶段 6c）：统计卡 / 提示条 / 缩放条 / 空画布种子钮 / 拖放遮罩 / 资源库
// 选择浮层 / 批量生成条壳。（大图灯箱已随「节点禁止点击放大」移除，
// 2026-11-06 用户定案。）

/** 画布信息玻璃卡 + 统计。 */
export function CanvasStatCard({ nodes, connections }: { nodes: CanvasNode[]; connections: unknown[] }) {
  const { t } = useTranslation();
  return (
    <div className="pc-glass fc-statcard">
      <div className="pc-ep-stats">
        <span>{t("canvas.statNodes", { count: nodes.length })}</span>
        <span>{t("project.canvas.statWires", { count: connections.length })}</span>
      </div>
    </div>
  );
}

/** 操作提示条。 */
export function CanvasTip() {
  const { t } = useTranslation();
  return <div className="pc-tip">{t("canvas.tip")}</div>;
}

/** 缩放条（工程画布同款）：缩小 / 百分比 / 放大。 */
export function ZoomBar({ view, zoomAt, vpRef }: {
  view: ViewState;
  zoomAt(mx: number, my: number, factor: number): void;
  vpRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <div className="pc-glass pc-zoombar">
      <NodeHint text={t("project.canvas.zoomOut")}>
        <button
          type="button"
          onClick={() => {
            const rect = vpRef.current?.getBoundingClientRect();
            if (rect) zoomAt(rect.width / 2, rect.height / 2, 1 / 1.2);
          }}
        >
          <span aria-hidden="true">−</span>
        </button>
      </NodeHint>
      <span className="pc-zpct">{Math.round(view.scale * 100)}%</span>
      <NodeHint text={t("project.canvas.zoomIn")}>
        <button
          type="button"
          onClick={() => {
            const rect = vpRef.current?.getBoundingClientRect();
            if (rect) zoomAt(rect.width / 2, rect.height / 2, 1.2);
          }}
        >
          <span aria-hidden="true">+</span>
        </button>
      </NodeHint>
    </div>
  );
}

/** 空画布示意：一键创建 文本→图像生成→预览 最小工作流。 */
export function SeedButton({ nodes, connections, addMenuOpen, onSeed, hidden }: {
  nodes: CanvasNode[];
  connections: unknown[];
  addMenuOpen: boolean;
  onSeed(): void;
  /** 工程作用域隐藏（工程画布的空集引导走默认工作流种子，阶段 E1 迁入）。 */
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  if (hidden || nodes.length || connections.length || addMenuOpen) return null;
  return (
    <button className="fc-seed" onClick={onSeed}>
      <span className="fc-seed-title">{t("canvas.seedCta")}</span>
      <span className="fc-seed-sub">{t("canvas.seedHint")}</span>
    </button>
  );
}

/** 拖放遮罩：OS 文件拖入提示。 */
export function DropHintOverlay({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div className="fc-drop-overlay">
      <span>{t("canvas.dropHint")}</span>
    </div>
  );
}

/** 批量生成浮动条壳（多选图像生成节点时出现；执行走 GenRuntime）。 */
export function BatchBarLayer({ selectedGenIds }: { selectedGenIds: string[] }) {
  return <BatchBar selectedGenIds={selectedGenIds} />;
}

/** 懒加载的资源库选择浮层：画布加载节点「从资源库选择」入口，薄壳复用
 *  工程域的通用选择浮层（搜索/分页/缩略图/导入），点选即回填节点路径。
 *  kinds 透传为浮层的类型白名单（图像节点只见图片、视频工具只见视频）。
 *  选择器给的是库内相对路径——mediaUrl 域层把相对路径拼到存储根（≠资源
 *  库根），必须在这里转成绝对路径落节点，否则缩略图/媒体全部裂图。 */
function LazyLibraryPicker({
  kinds,
  onPick,
  onClose,
}: {
  kinds?: string[];
  onPick: (filePath: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [libraryRoot, setLibraryRoot] = useState("");
  useEffect(() => {
    let alive = true;
    invoke<string>("get_resource_library_path")
      .then((root) => {
        if (alive) setLibraryRoot(root);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <ProjectFilePickerDialog
      title={t("canvas.loadPickerTitle")}
      kindFilter={kinds}
      onPick={(file) => onPick(joinLibraryPath(libraryRoot, file.filePath))}
      onClose={onClose}
    />
  );
}

/** 资源库选择浮层装配：加载节点与抽帧节点的「从资源库选择」入口。
 *  写回意图按 pickerApplyRef（ref 在同一次事件里先于 state 更新，渲染
 *  直读必是新值——引擎既有惯例，定点豁免 react-hooks/refs）。 */
export function LibraryPickerLayer({
  pickerForNode,
  pickerApplyRef,
  pickerKindsRef,
  applyFrameVideo,
  onClose,
}: {
  pickerForNode: string;
  pickerApplyRef: RefObject<"resource" | "frame-video">;
  pickerKindsRef: RefObject<string[] | null>;
  applyFrameVideo(nodeId: string, type: CanvasNode["type"], videoPath: string): Promise<void>;
  onClose(): void;
}) {
  const data = useCanvasData();
  return (
    <WheelGate>
      <LazyLibraryPicker
        // 引擎既有惯例：白名单 ref 在同一次事件里先于 state 更新，
        // 渲染期直读必是新值（见 pickFromLibrary），定点豁免。
        // eslint-disable-next-line react-hooks/refs -- 见上
        kinds={pickerKindsRef.current ?? undefined}
        onPick={(filePath) => {
          const targetId = pickerForNode;
          onClose();
          if (pickerApplyRef.current === "frame-video") {
            const target = data.nodes().find((n) => n.id === targetId);
            if (target) void applyFrameVideo(targetId, target.type, filePath);
            return;
          }
          void data.updateNode(targetId, { resourcePath: filePath });
        }}
        onClose={onClose}
      />
    </WheelGate>
  );
}
