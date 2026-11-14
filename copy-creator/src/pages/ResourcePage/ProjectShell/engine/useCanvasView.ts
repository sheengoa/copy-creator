// 工程画布视图派生与挂剧本分派（自 ProjectCanvas.tsx 组件体搬移，
// 2026-11-03 引擎拆分阶段 11d）。旧画布的详情窗口体系（detailFor/
// memberPick/pickerFor 死状态与 SegmentAttachPicker/MemberPickPanel 死
// 组件）已随节点化退役删除（2026-11-14）；视口区（平行视口状态/定位/
// 滚轮缩放/适配全部）为旧引擎完整复制品——实况引擎在 FreeCanvas 内置
// useViewport，vpRef 从未绑定导致缺项条按钮静默无效，已整体删除并改经
// FreeCanvas overlays 函数形态的实况助手接线（2026-11-14 视口合一）。
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { EpisodeOverview, ProjectScene, ProjectSegment } from "../../../../stores/projectStore";
import { allAssetsOf } from "../layout";
import type { Pos, ScriptPh } from "../types";

type LooseAsset = { id: string; name?: string };

export function useCanvasView(deps: {
  episodeId: string;
  overview: EpisodeOverview | null;
  scenes: ProjectScene[];
  segments: ProjectSegment[];
  looseAssets: LooseAsset[];
  updateEpisode(episodeId: string, patch: { title: string; status: string; script_path?: string }): Promise<unknown>;
  linkNode(
    episodeId: string, kind: string, id: string,
    segmentId: string, port: string, ownerKey?: string,
  ): unknown;
  scriptPhs: ScriptPh[];
  persistScriptPhs(next: ScriptPh[]): void;
  infoOffsets: Record<string, Pos>;
  persistInfoOffsets(next: Record<string, Pos>): void;
  nodeSizes: Record<string, { w: number; h: number }>;
  persistSizes(next: Record<string, { w: number; h: number }>): void;
  dropPendingLinksOf(key: string): void;
  scriptPickTarget: string | null;
  setScriptPickOpen(open: boolean): void;
  setScriptPickTarget(t: string | null): void;
  setPulseKeys(next: string[]): void;
  spawnAnchorRef: { current: { wx: number; wy: number; used: number; snapshot?: string[] } | null };
}) {
  const {
    episodeId, overview, scenes, segments, looseAssets,
    updateEpisode, linkNode,
    scriptPhs, persistScriptPhs, infoOffsets, persistInfoOffsets, nodeSizes,
    persistSizes, dropPendingLinksOf, setScriptPickOpen, setScriptPickTarget,
    setPulseKeys, spawnAnchorRef, scriptPickTarget,
  } = deps;
  const { t } = useTranslation();

  // 真切集（两个非空集 id 之间切换）丢弃未消费的出生锚点与脉冲。
  // episodeId 为空串是 selectEpisode 刷新途中的瞬态（概览先置空再取回）；
  // 空档与随后的「回到原集」都不算切集——否则每次刷新都会把出生锚点误杀。
  // （原同段还清理 detailFor/memberPick/pickerFor 详情窗口状态：旧画布
  // 详情体系已随节点化退役，死状态于 2026-11-14 删除。）
  const prevRealEpisodeRef = useRef(episodeId);
  useEffect(() => {
    if (!episodeId) return;
    if (prevRealEpisodeRef.current === episodeId) return;
    prevRealEpisodeRef.current = episodeId;
    setPulseKeys([]);
    spawnAnchorRef.current = null;
  }, [episodeId, setPulseKeys, spawnAnchorRef]);

  const outputKey = overview?.episode.output_asset_id ?? null;

  // 成片来源显示名：镜头描述或素材名（散件不上画布，旧数据仍可回退显示）。
  const outputSourceLabel: string | null = useMemo(() => {
    if (!outputKey) return null;
    if (outputKey.startsWith("shot:")) {
      const shot = scenes.flatMap((s) => s.shots).find((item) => item.id === outputKey.slice(5));
      return shot?.description || null;
    }
    return (
      looseAssets.find((a) => a.id === outputKey)?.name ||
      allAssetsOf(scenes).find((a) => a.id === outputKey)?.name ||
      null
    );
  }, [outputKey, scenes, looseAssets]);

  // 工作流缺项检查（ComfyUI 缺节点的对应提醒）；「未连成片」可点击
  // 定位到成片节点。有片段时成片由片段按序聚合，不再要求单素材连线。
  const issues = useMemo(() => {
    const list: { key: string; label: string }[] = [];
    if (overview && !overview.episode.script_path) {
      list.push({ key: "script", label: t("project.canvas.checkScript") });
    }
    const emptySegments = segments.filter((item) => !item.asset).length;
    if (emptySegments > 0) {
      list.push({ key: "segAssets", label: t("project.canvas.checkSegAssets", { count: emptySegments }) });
    }
    if (overview && !outputKey && segments.length === 0) {
      list.push({ key: "output", label: t("project.canvas.checkOutput") });
    }
    return list;
  }, [overview, outputKey, segments, t]);

  // 挂剧本（双击空纸片 / 详情窗重挂后从库选文件），按目标节点分派：
  // - 主剧本节点（"script"）：换库内文件做本集剧本，挂接成功即自动接入
  //   所有已有片段的剧本口（linkNode 幂等，重复挂接不会写重）。
  // - 剧本纸片：本集还没剧本时该纸片「转正」为主剧本——位置/尺寸移交、
  //   暂存线由全量接入覆盖、纸片移除；已有剧本时纸片独立持自己的文件
  //   （画布层记忆），不动本集剧本。onPromote 只在转正路径落库成功后
  //   回调（P2-2：详情窗开着跨过转正时，Shell 据此把窗从已消失的纸片
  //   key 改指主剧本，不再停留「未挂接」假状态）。
  const handleScriptPick = useCallback(
    (filePath: string, onPromote?: () => void) => {
      const episode = overview?.episode;
      const target = scriptPickTarget;
      setScriptPickTarget(null);
      if (!episode || !target) {
        setScriptPickOpen(false);
        return;
      }
      let promoted = false;
      const attachEpisode = () => {
        void updateEpisode(episode.id, {
          title: episode.title,
          status: episode.status,
          script_path: filePath,
        }).then(() => {
          segments.forEach((segment) => {
            void linkNode(episode.id, "script", episode.id, segment.id, "script");
          });
          setScriptPickOpen(false);
          if (promoted) onPromote?.();
        });
      };
      if (target === "script") {
        attachEpisode();
        return;
      }
      const phId = target.slice(7);
      if (!scriptPhs.some((item) => item.id === phId)) {
        setScriptPickOpen(false);
        return;
      }
      if (episode.script_path) {
        persistScriptPhs(scriptPhs.map((item) => (item.id === phId ? { ...item, path: filePath } : item)));
        setScriptPickOpen(false);
        return;
      }
      const nextOffsets = { ...infoOffsets };
      const phPos = nextOffsets[target];
      delete nextOffsets[target];
      if (phPos) nextOffsets.script = phPos;
      persistInfoOffsets(nextOffsets);
      const nextSizes = { ...nodeSizes };
      const phSize = nextSizes[target];
      delete nextSizes[target];
      if (phSize) nextSizes.script = phSize;
      persistSizes(nextSizes);
      persistScriptPhs(scriptPhs.filter((item) => item.id !== phId));
      dropPendingLinksOf(target);
      // 清掉出生锚点：转正出的主剧本节点要留在纸片原位，不能被锚点挪走。
      spawnAnchorRef.current = null;
      promoted = true;
      attachEpisode();
    },
    [
      overview, scriptPickTarget, scriptPhs, segments, updateEpisode, linkNode,
      persistScriptPhs, infoOffsets, persistInfoOffsets, nodeSizes, persistSizes, dropPendingLinksOf,
      setScriptPickOpen, setScriptPickTarget, spawnAnchorRef,
    ],
  );

  return {
    outputSourceLabel,
    issues,
    handleScriptPick,
  };
}
