// 工程画布视口与详情窗口状态（自 ProjectCanvas.tsx 组件体零改动搬移，
// 2026-11-03 引擎拆分阶段 11d）：detailFor/memberPick/pickerFor 详情
// states、片段挂产出、成片来源显示、卡片默认尺寸、视口按集记忆、滚轮
// 缩放（原生非被动监听）、聚焦滚动归零、适配全部、缺项提醒与定位。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EpisodeOverview, ProjectScene, ProjectSegment } from "../../../../stores/projectStore";
import { allAssetsOf, CARD_GAP, CARD_W, FRAME_MIN_W, FRAME_PAD_TOP, INFO_H, INFO_W, SCRIPT_W, SEG_H, SEG_W } from "../layout";
import type { CanvasLayout, EntityPhKind, Pos, ScriptPh, WireBox } from "../types";
import type { DetailForArg } from "../layers/NodeExtras";

type LooseAsset = { id: string; name?: string };

export function useCanvasView(deps: {
  episodeId: string;
  overview: EpisodeOverview | null;
  scenes: ProjectScene[];
  segments: ProjectSegment[];
  looseAssets: LooseAsset[];
  segPos: Record<string, Pos>;
  entityPhs: { id: string; kind: EntityPhKind; x: number; y: number }[];
  infoPos: { frame: Pos; map: Record<string, Pos> };
  infoNodes: import("../types").CanvasInfo[];
  outputBox: WireBox | null;
  layout: Omit<CanvasLayout, "infoFramePos">;
  sizeOfNode(key: string): { w: number; h: number } | null;
  infoNodePos(key: string): Pos;
  updateEpisode(episodeId: string, patch: { title: string; status: string; script_path?: string }): Promise<unknown>;
  linkNode(
    episodeId: string, kind: string, id: string,
    segmentId: string, port: string, ownerKey?: string,
  ): unknown;
  linkAsset(input: { filePath: string; kind: string; name: string; episodeId: string; shotId: string }): Promise<{ id: string } | null>;
  setSegmentAsset(segmentId: string, assetId: string): unknown;
  selectEpisode(id: string): unknown;
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
  armSpawnAt(x: number, y: number): void;
}) {
  const {
    episodeId, overview, scenes, segments, looseAssets, segPos, entityPhs,
    infoPos, infoNodes, outputBox, layout, sizeOfNode, infoNodePos,
    updateEpisode, linkNode, linkAsset, setSegmentAsset, selectEpisode,
    scriptPhs, persistScriptPhs, infoOffsets, persistInfoOffsets, nodeSizes,
    persistSizes, dropPendingLinksOf, setScriptPickOpen, setScriptPickTarget,
    setPulseKeys, spawnAnchorRef, armSpawnAt, scriptPickTarget,
  } = deps;
  const { t } = useTranslation();

  // ── 节点详情窗口：双击节点弹出的独立预览窗口（预览 + 信息 + 上传/
  // 库选）。资料类带 当前/全部 切换；片段窗口按 角色/场景/道具 三区块
  // 各自独立切换。 ──
  const [detailFor, setDetailFor] = useState<DetailForArg | null>(null);
  // 成员装入面板（多选 + 装入确认）：eph 加载 / 组追加裁剪 / 默认节点转组。
  // （pending 只是面板内的勾选草稿，点「装入」才由 applyMemberPick 落地。）
  const [memberPick, setMemberPick] = useState<
    | { mode: "eph"; ephId: string; kind: EntityPhKind; pending: string[] }
    | { mode: "grp"; groupId: string; kind: EntityPhKind; pending: string[] }
    | { mode: "convert"; sourceKey: string; kind: EntityPhKind; pending: string[] }
    | null
  >(null);
  // 详情窗口内「从资源库选择」的二级选择器目标（片段挂产出）。
  const [pickerFor, setPickerFor] = useState<`segment:${string}` | null>(null);
  const [detailError, setDetailError] = useState("");
  // 真切集（两个非空集 id 之间切换）才关闭详情窗口与其二级选择器，并
  // 丢弃未消费的出生锚点与脉冲。episodeId 为空串是 selectEpisode 刷新
  // 途中的瞬态（概览先置空再取回）；空档与随后的「回到原集」都不算切
  // 集——否则每次刷新都会把打开中的窗口、出生锚点误杀。
  const prevRealEpisodeRef = useRef(episodeId);
  useEffect(() => {
    if (!episodeId) return;
    if (prevRealEpisodeRef.current === episodeId) return;
    prevRealEpisodeRef.current = episodeId;
    setDetailFor(null);
    setPickerFor(null);
    setMemberPick(null);
    setDetailError("");
    setPulseKeys([]);
    spawnAnchorRef.current = null;
  }, [episodeId, setPulseKeys, spawnAnchorRef]);
  useEffect(() => {
    setDetailError("");
  }, [detailFor]);

  // 详情窗口 → 从资源库选择：片段挂产出。
  const attachSegmentFromLibrary = (segmentId: string, file: { filePath: string; kind: string; name: string }) => {
    // linkAsset 内部会整刷概览（画布随之重挂、UI 状态清空），窗口主动关；
    // setSegmentAsset 只落库且发生在重取快照之后，末尾再刷一次让片段
    // 缩略图立即出现，否则要等下次刷新。
    setPickerFor(null);
    setDetailFor(null);
    void linkAsset({
      filePath: file.filePath,
      kind: file.kind,
      name: file.name,
      episodeId,
      shotId: "",
    }).then(async (asset) => {
      if (!asset) return;
      await setSegmentAsset(segmentId, asset.id);
      await selectEpisode(episodeId);
    });
  };
  // 空白资料节点的「加载」已并入成员装入面板（applyMemberPick 的 eph 分支）：

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

  const cardSizeOf = useCallback(
    (shotId: string) => {
      const card = layout.cards.find((c) => c.shot.id === shotId);
      return { w: card?.w ?? CARD_W, h: card?.h ?? 120 };
    },
    [layout],
  );

  // ── 视口：按集记 localStorage ──
  const vpRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 24, y: 12, scale: 0.85 });
  const [vpSize, setVpSize] = useState<{ w: number; h: number } | null>(null);
  const saveView = useCallback(
    (next: { x: number; y: number; scale: number }) => {
      try {
        window.localStorage.setItem(`project_canvas_view_${episodeId}`, JSON.stringify(next));
      } catch {
        // 存储不可用：仅不记忆视口。
      }
    },
    [episodeId],
  );
  // 出生锚点的屏幕坐标换算版（vpRef 在本节声明，故放在此处）。
  const armSpawnFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const rect = vpRef.current?.getBoundingClientRect();
      if (!rect) return;
      armSpawnAt((clientX - rect.left - view.x) / view.scale, (clientY - rect.top - view.y) / view.scale);
    },
    [armSpawnAt, view.x, view.y, view.scale],
  );

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

  const locateOutput = useCallback(() => {
    const el = vpRef.current;
    if (!el || !outputBox) return;
    const next = {
      x: el.clientWidth / 2 - (outputBox.x + outputBox.w / 2) * view.scale,
      y: el.clientHeight / 2 - (outputBox.y + outputBox.h / 2) * view.scale,
      scale: view.scale,
    };
    setView(next);
    saveView(next);
  }, [outputBox, view.scale, setView, saveView]);

  // 提醒条「N 个片段未挂产出」：定位到第一个空片段。
  const locateEmptySegment = useCallback(() => {
    const el = vpRef.current;
    const target = segments.find((item) => !item.asset);
    const p = target ? segPos[target.id] : null;
    if (!el || !p) return;
    const next = {
      x: el.clientWidth / 2 - (p.x + SEG_W / 2) * view.scale,
      y: el.clientHeight / 2 - (p.y + SEG_H / 2) * view.scale,
      scale: view.scale,
    };
    setView(next);
    saveView(next);
  }, [segments, segPos, view.scale, setView, saveView]);

  // 剧本节点定位（视口居中到剧本纸片；纸片可被拖离资料框，用覆盖位置）。
  // key 缺省为主剧本节点，缺项提醒定位空纸片时传纸片 key。
  const locateScript = useCallback(
    (key = "script") => {
      const el = vpRef.current;
      const p = infoNodePos(key);
      if (!el || !p) return;
      const size = sizeOfNode(key) ?? { w: SCRIPT_W, h: INFO_H + 40 };
      const next = {
        x: el.clientWidth / 2 - (p.x + size.w / 2) * view.scale,
        y: el.clientHeight / 2 - (p.y + size.h / 2) * view.scale,
        scale: view.scale,
      };
      setView(next);
      saveView(next);
    },
    [infoNodePos, sizeOfNode, view.scale, setView, saveView],
  );

  // 挂剧本（双击空纸片 / 详情窗重挂后从库选文件），按目标节点分派：
  // - 主剧本节点（"script"）：换库内文件做本集剧本，挂接成功即自动接入
  //   所有已有片段的剧本口（linkNode 幂等，重复挂接不会写重）。
  // - 剧本纸片：本集还没剧本时该纸片「转正」为主剧本——位置/尺寸移交、
  //   暂存线由全量接入覆盖、纸片移除；已有剧本时纸片独立持自己的文件
  //   （画布层记忆），不动本集剧本。
  const handleScriptPick = useCallback(
    (filePath: string) => {
      const episode = overview?.episode;
      const target = scriptPickTarget;
      setScriptPickTarget(null);
      if (!episode || !target) {
        setScriptPickOpen(false);
        return;
      }
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
      attachEpisode();
    },
    [
      overview, scriptPickTarget, scriptPhs, segments, updateEpisode, linkNode,
      persistScriptPhs, infoOffsets, persistInfoOffsets, nodeSizes, persistSizes, dropPendingLinksOf,
      setScriptPickOpen, setScriptPickTarget, spawnAnchorRef,
    ],
  );

  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const update = () => setVpSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitAll = useCallback(() => {
    const el = vpRef.current;
    if (!el) return;
    // 包围盒 = 基础布局 ∪ 拖动过的资料节点实际位置 ∪ 片段实际位置 ∪
    // 成片节点：自由拖动/改尺寸之后，「适配全部」仍覆盖所有内容。
    let worldW = layout.worldW;
    let worldH = layout.worldH;
    infoNodes.forEach((node) => {
      const p = infoNodePos(node.key);
      worldW = Math.max(worldW, p.x + node.w + 40);
      worldH = Math.max(worldH, p.y + node.h + 40);
    });
    // 空白资料节点可能被拖到世界任意角落，同样要进包围盒。
    entityPhs.forEach((ph) => {
      const p = infoNodePos(`eph:${ph.id}`);
      worldW = Math.max(worldW, p.x + INFO_W + 40);
      worldH = Math.max(worldH, p.y + INFO_H + 40);
    });
    Object.values(segPos).forEach((p) => {
      worldW = Math.max(worldW, p.x + SEG_W + 40);
      worldH = Math.max(worldH, p.y + SEG_H + 200);
    });
    const outputRight = outputBox ? outputBox.x + outputBox.w + 60 : 0;
    // 空资料框不渲染，也不参与包围盒（否则空集会多出一块 invisible 区域）。
    const infoGridBottom = infoNodes.length > 0
      ? infoPos.frame.y + FRAME_PAD_TOP + Math.ceil(infoNodes.length / 3) * (INFO_H + CARD_GAP)
      : 0;
    worldW = Math.max(worldW, infoNodes.length > 0 ? infoPos.frame.x + FRAME_MIN_W + 60 : 0, outputRight);
    worldH = Math.max(worldH, infoGridBottom + 60);
    const scale = Math.min(el.clientWidth / worldW, el.clientHeight / worldH, 1);
    const next = {
      x: Math.max(12, (el.clientWidth - worldW * scale) / 2),
      y: Math.max(8, (el.clientHeight - worldH * scale) / 2),
      scale,
    };
    setView(next);
    saveView(next);
  }, [layout, infoPos, infoNodes, infoNodePos, segPos, saveView, outputBox, entityPhs]);

  const initializedRef = useRef("");
  useEffect(() => {
    if (!episodeId || initializedRef.current === episodeId) return;
    initializedRef.current = episodeId;
    let stored: { x: number; y: number; scale: number } | null;
    try {
      const raw = window.localStorage.getItem(`project_canvas_view_${episodeId}`);
      stored = raw ? (JSON.parse(raw) as { x: number; y: number; scale: number }) : null;
    } catch {
      stored = null;
    }
    if (stored && Number.isFinite(stored.scale)) {
      setView(stored);
    } else {
      fitAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId, infoPos]);

  const zoomAt = useCallback(
    (mx: number, my: number, factor: number) => {
      setView((prev) => {
        const ns = Math.min(2.2, Math.max(0.3, prev.scale * factor));
        const next = {
          x: mx - (mx - prev.x) * (ns / prev.scale),
          y: my - (my - prev.y) * (ns / prev.scale),
          scale: ns,
        };
        saveView(next);
        return next;
      });
    },
    [saveView],
  );

  // 滚轮缩放走原生非被动监听：React 合成 onWheel 是 passive 的，
  // preventDefault 不生效（ctrl+滚轮会触发网页缩放）。
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // 视口永远不该被滚动（平移/缩放都走 transform）：overflow:hidden 的
  // 容器仍会被「聚焦滚动」推动——弹层搜索框、便签输入框等聚焦在视口
  // 边缘外时，浏览器会滚动容器把聚焦元素露出，表现为整个画布节点集体
  // 平移（连线/断线时位置漂移的根源）。这里把任何滚动立即归零，根治
  // 所有聚焦滚动路径；归零引发的再入 scroll 事件值为 0，不会成环。
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollLeft !== 0 || el.scrollTop !== 0) el.scrollTo(0, 0);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);


  return {
    detailFor, setDetailFor,
    memberPick, setMemberPick,
    pickerFor, setPickerFor,
    detailError, setDetailError,
    attachSegmentFromLibrary,
    outputKey, outputSourceLabel, cardSizeOf,
    vpRef, view, setView, vpSize, setVpSize, saveView,
    armSpawnFromEvent,
    issues,
    locateOutput, locateEmptySegment, locateScript,
    handleScriptPick,
    fitAll, zoomAt,
  };
}
