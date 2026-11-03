import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  useProjectStore,
  type ProjectAsset,
  type ProjectScene,
} from "../../stores/projectStore";
import {
  characterAvatarInitial,
  joinLibraryPath,
} from "../../domain/projectView";

import {
  allAssetsOf,
  CARD_GAP,
  CARD_W,
  FRAME_MIN_W,
  FRAME_PAD_TOP,
  INFO_H,
  INFO_W,
  portRatio,
  SCRIPT_W,
  SEG_H,
  SEG_W,
  WIRES_VIEWPORT_PAD,
} from "./ProjectCanvas/layout";
import {
  type EntityPhKind,
  type InfoGroup,
} from "./ProjectCanvas/types";
import { ResourceImage } from "./ResourceMedia";
import { PORT_COLORS, WIRE_TYPE_COLORS } from "./ProjectCanvas/colors";
import { useCanvasGestures } from "./ProjectCanvas/engine/useGestures";
import { useWorkflowSeed } from "./ProjectCanvas/engine/useWorkflowSeed";
import { useDetailActions } from "./ProjectCanvas/engine/useDetailActions";
import { usePorts } from "./ProjectCanvas/engine/usePorts";
import { useNodeMetrics } from "./ProjectCanvas/engine/useNodeMetrics";
import { useDeleteOps } from "./ProjectCanvas/engine/useDeleteOps";
import { useCanvasData } from "./ProjectCanvas/engine/useCanvasData";
import { useGroupOps } from "./ProjectCanvas/engine/useGroupOps";
import { DetailDialog } from "./ProjectCanvas/layers/DetailDialog";
import type { DetailForArg } from "./ProjectCanvas/layers/NodeExtras";
import { MiniMap, ZoomBar } from "./ProjectCanvas/layers/chrome";
import { SceneFrames } from "./ProjectCanvas/layers/SceneFrames";
import { WiresLayer } from "./ProjectCanvas/layers/WiresLayer";
import { ShotCards } from "./ProjectCanvas/layers/ShotCards";
import { InfoNodesLayer, NodeGroupsLayer } from "./ProjectCanvas/layers/InfoLayer";
import {
  EntityPhNodes,
  NoteNodes,
  OutputNode,
  PromptPhNodes,
  SegmentNodes,
} from "./ProjectCanvas/layers/NodeExtras";
import {
  AddBtnBar,
  AddMenuBlock,
  CutTrailLayer,
  EpisodeCard,
  IssueBar,
} from "./ProjectCanvas/layers/CanvasBars";
import {
  DeleteSceneConfirm,
  LocationPickPanel,
  MemberPickPanel,
  PromptPickDialog,
  SceneFormDialog,
  ScriptPickDialog,
  SegmentAttachPicker,
  ShotFormDialog,
} from "./ProjectCanvas/layers/Dialogs";

// ── 模块层已拆出 ProjectCanvas/（types/layout/colors/TextPaperBody，
//    2026-11-03 引擎拆分阶段 11a；下方为组件体）──


/** 工程画布：集素材的无限画布（看/摆/连）。镜头卡与散件坐标持久化进
 *  工程库；资料框（出场角色/出镜道具/剧本）与视口按集记 localStorage。
 *  交互：中键平移、滚轮缩放、左键框选、多选拖动、拖场景标签牌整组
 *  移动、卡头锚点拖出手动连线、点击卡内素材开详情。生成链
 *  （gen_from_asset）自动在容器（镜头卡/散件）之间画实线箭头。 */
export default function ProjectCanvas({
  libraryRoot,
  overlay,
  onOpenAsset,
  onPickForShot,
}: {
  libraryRoot: string;
  /** 集信息玻璃卡内容（标题/状态/角色/剧本入口），由 ProjectView 组装。 */
  overlay?: React.ReactNode;
  onOpenAsset: (asset: ProjectAsset) => void;
  onPickForShot: (shotId: string) => void;
}) {
  const { t } = useTranslation();
  const {
    overview,
    locations,
    loadLocations,
    saveCanvasLayout,
    unlinkAssets,
    saveScene,
    deleteScene,
    saveShot,
    deleteShot,
    setEpisodeOutput,
    setEpisodeLocations,
    setEpisodeProps,
    setEpisodeCharacters,
    updateEpisode,
    addSegment,
    removeSegment,
    moveSegment,
    setSegmentAsset,
    selectEpisode,
    linkNode,
    unlinkNode,
    linkAsset,
    characters,
    props,
    prompts,
    loadPrompts,
    loadCharacters,
    loadProps,
  } = useProjectStore(
    useShallow((state) => ({
      overview: state.overview,
      locations: state.locations,
      loadLocations: state.loadLocations,
      saveCanvasLayout: state.saveCanvasLayout,
      unlinkAssets: state.unlinkAssets,
      saveScene: state.saveScene,
      deleteScene: state.deleteScene,
      saveShot: state.saveShot,
      deleteShot: state.deleteShot,
      setEpisodeOutput: state.setEpisodeOutput,
      setEpisodeLocations: state.setEpisodeLocations,
      setEpisodeProps: state.setEpisodeProps,
      setEpisodeCharacters: state.setEpisodeCharacters,
      updateEpisode: state.updateEpisode,
      addSegment: state.addSegment,
      removeSegment: state.removeSegment,
      moveSegment: state.moveSegment,
      setSegmentAsset: state.setSegmentAsset,
      selectEpisode: state.selectEpisode,
      linkNode: state.linkNode,
      unlinkNode: state.unlinkNode,
      linkAsset: state.linkAsset,
      characters: state.characters,
      props: state.props,
      prompts: state.prompts,
      loadPrompts: state.loadPrompts,
      loadCharacters: state.loadCharacters,
      loadProps: state.loadProps,
    })),
  );
  const episodeId = overview?.episode.id ?? "";
  const scenes = useMemo(() => overview?.scenes ?? [], [overview]);
  const looseAssets = useMemo(() => overview?.loose_assets ?? [], [overview]);
  const links = useMemo(() => overview?.links ?? [], [overview]);
  const episodeLocations = useMemo(() => overview?.locations ?? [], [overview]);
  const episodeProps = useMemo(() => overview?.props ?? [], [overview]);
  const segments = useMemo(() => overview?.segments ?? [], [overview]);
  const nodeLinks = useMemo(() => overview?.node_links ?? [], [overview]);

  // 出场角色/出场场景/出场道具/剧本：资料框数据源（均为 overview 带出）。
  const castCharacters = useMemo(() => overview?.characters ?? [], [overview]);

  // ── 数据层（engine/useCanvasData，2026-11-03 阶段 11d）：按集
  //    localStorage 状态+addMenu+选择器开关+布局派生，零改动搬移 ──
  const {
    setInfoFramePos, saveInfoFramePos,
    setOutputPos, saveOutputPos,
    selKeys, selRef, setSelection,
    notes, setNotes, persistNotes, editingNoteId, setEditingNoteId, noteDraft, setNoteDraft, addNote,
    addMenu, setAddMenu, addMenuQuery, setAddMenuQuery,
    locationPickOpen, setLocationPickOpen,
    scriptPickOpen, setScriptPickOpen, scriptPickTarget, setScriptPickTarget,
    scriptPhs, persistScriptPhs, addScriptPh,
    promptPhs, persistPromptPhs, addPromptPh,
    promptPickOpen, setPromptPickOpen, promptPickTarget, setPromptPickTarget, promptPickQuery, setPromptPickQuery,
    entityPhs, persistEntityPhs, addEntityPh,
    infoGroups, persistInfoGroups,
    layout, infoNodes, infoPos,
    pos, setPos,
    outputBox,
    segPos, setSegPos, persistSegments,
    nodeSizes, setNodeSizes, persistSizes, sizeOfNode,
    infoOffsets, setInfoOffsets, persistInfoOffsets,
    persistCards, infoNodePos,
  } = useCanvasData({
    episodeId, overview, scenes, segments, castCharacters, episodeLocations,
    episodeProps, characters, locations, props, loadPrompts, loadCharacters,
    loadLocations, loadProps, saveCanvasLayout,
  });
  // ── 组操作与画布层机制（engine/useGroupOps，2026-11-03 阶段 11d）：
  //    组拖/暂存线/存量清理/分组/撤销/剪贴板/出生锚点，零改动搬移 ──
  const {
    groupSnapshot,
    moveGroupTo,
    persistPositions,
    pendingLinks,
    persistPendingLinks,
    dropPendingLinksOf,
    nodeGroups,
    persistNodeGroups,
    memberFrame,
    pushUndo,
    runUndo,
    groupingRef,
    copySelection,
    pasteClipboard,
    armSpawnAt,
    spawnAnchorRef,
    pulseKeys,
    setPulseKeys,
  } = useGroupOps({
    selRef, pos, segPos, infoOffsets, notes, outputBox, infoNodePos, setPos, setSegPos,
    setNotes, setInfoOffsets, setOutputPos, persistCards, persistSegments,
    persistNotes, persistInfoOffsets, saveOutputPos, episodeId, overview,
    infoNodes, entityPhs, persistEntityPhs, scriptPhs, persistScriptPhs,
    promptPhs, persistPromptPhs, saveCanvasLayout, setSelection,
    sizeOfNode, addNote, addEntityPh, addSegment,
    setNodeSizes, persistSizes, removeSegment,
  });

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

  // ── 默认工作流模板（engine/useWorkflowSeed，2026-11-03 阶段 11d）：
  //    首次进入空集自动铺片段+占位骨架，代码零改动搬移 ──
  useWorkflowSeed({
    episodeId, overview, addSegment, layout, persistEntityPhs,
    persistPromptPhs, persistScriptPhs, persistInfoOffsets, persistPendingLinks,
  });

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

  // ── 连线几何与节点实测尺寸（engine/useNodeMetrics，2026-11-03
  //    阶段 11d）：wires 聚合/ResizeObserver 实测/锚点解析，零改动搬移 ──
  const {
    wires,
    nodeMetrics,
    nodeMetricsRef,
    boxOf,
    outPointOf,
    ownerKeyOfLink,
  } = useNodeMetrics({
    vpRef, view, layout, scenes, links, nodeSizes, infoNodes, segments,
    promptPhs, entityPhs, pos, cardSizeOf, outputBox, segPos, sizeOfNode,
    infoNodePos, infoGroups,
  });
  // ── 端口语义与色通道（engine/usePorts，2026-11-03 阶段 11d）：
  //    顶掉/去重/接口表/实体色/key 解析/自动接回，代码零改动搬移 ──
  const {
    displacePortLinks,
    segWires,
    portsOf,
    nodeWireColorOf,
    nodeKeyParts,
    autoConnectNewNode,
  } = usePorts({
    overview, unlinkNode, pendingLinks, persistPendingLinks, nodeLinks,
    ownerKeyOfLink, scenes, infoGroups, entityPhs, episodeId, linkNode,
    setEpisodeOutput,
  });

  const inPointOf = useCallback(
    (key: string, portId?: string): { x: number; y: number } | null => {
      const box = boxOf(key);
      if (!box) return null;
      const ins = portsOf(key).ins;
      const pid = portId ?? ins[0]?.id;
      const off = pid ? nodeMetrics.ports[key]?.[pid] : undefined;
      if (off) return { x: box.x + off.x, y: box.y + off.y };
      const index = portId ? ins.findIndex((p) => p.id === portId) : 0;
      return { x: box.x, y: box.y + box.h * portRatio(index < 0 ? 0 : index, Math.max(ins.length, 1)) };
    },
    [boxOf, portsOf, nodeMetrics],
  );

  // ── 手势引擎（engine/useGestures，2026-11-03 阶段 11b）：DragState 按下
  //    分派 + 窗口级 move/up/cancel + 切线/摘线/双击判定，代码零改动搬移 ──
  const {
    scenePos,
    onViewportPointerDown,
    dragRef,
    suppressClickRef,
    wireDraft,
    liftedWire,
    cutTrailRef,
    cutTrailUnderRef,
    openInfoDetail,
    discardDetachedWire,
    setLiftedWire,
  } = useCanvasGestures({
    vpRef, view, setView, saveView, layout, pos, setPos, segPos, setSegPos, outputBox,
    notes, setNotes, nodeSizes, setNodeSizes, infoGroups, infoNodes, infoNodePos,
    entityPhs, promptPhs, segments, segWires, nodeLinks, pendingLinks,
    persistPendingLinks, nodeGroups, memberFrame, groupSnapshot, selRef,
    setSelection, moveGroupTo, persistPositions, pushUndo, persistCards,
    saveCanvasLayout, saveInfoFramePos, saveOutputPos, setEpisodeOutput,
    episodeId, persistNotes, addNote, addEntityPh, addPromptPh, persistSegments,
    linkNode, unlinkNode, unlinkAssets, nodeKeyParts, addSegment,
    autoConnectNewNode, persistSizes, persistInfoOffsets, setInfoFramePos,
    setInfoOffsets, setOutputPos, infoPos, portsOf, boxOf, outPointOf, inPointOf,
    nodeMetricsRef, sizeOfNode, addMenu, setAddMenu, setAddMenuQuery,
    ownerKeyOfLink, displacePortLinks, nodeWireColorOf, setDetailFor,
    setScriptPickTarget, setScriptPickOpen, setPromptPickTarget,
    setPromptPickOpen, setEditingNoteId, setNoteDraft, onOpenAsset,
    onPickForShot, scenes,
  });

  // ── 节点操作 ──
  // 节点接口圆点（ComfyUI 式）：输入口列在左缘（片段六口按列分布）、
  // 输出口在右缘实心类型色，hover 浮现接口名称；按下即拖出连线，从
  // 节点接口（ComfyUI K 采样器同款行位）：实心类型色圆点落在卡内、
  // 紧贴左右两缘；输入列自顶部起贴左缘，输出贴右缘且与首行输入同一
  // 水平行；接口名称常显。端口坐标由实测驱动连线锚点。
  // 输入口优先用端口专属色（片段六口每口一色），未命中回退类型色。
  const portBar = (key: string) => {
    const { ins, out } = portsOf(key);
    if (ins.length === 0 && !out) return null;
    const rows = Math.max(ins.length, out ? 1 : 0);
    return (
      <div className="pc-port-bar">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="pc-port-row">
            {ins[i] ? (
              <>
                <span
                  className="pc-port pc-port-in"
                  data-port="in"
                  data-port-id={ins[i].id}
                  style={{ background: PORT_COLORS[ins[i].id] ?? WIRE_TYPE_COLORS[ins[i].accepts[0] ?? ""] ?? undefined }}
                />
                <span className="pc-port-name">{ins[i].label}</span>
              </>
            ) : null}
            {i === 0 && out ? (
              <>
                <span className="pc-port-name pc-port-name-out">{out.label}</span>
                <span
                  className="pc-port pc-port-out"
                  data-port="out"
                  style={{ background: nodeWireColorOf(key) ?? WIRE_TYPE_COLORS[out.type] ?? "#94a3b8" }}
                />
              </>
            ) : null}
          </div>
        ))}
      </div>
    );
  };

  const shotNoOf = useCallback(
    (sceneId: string, shotId: string): number => {
      const scene = scenes.find((item) => item.id === sceneId);
      const index = scene ? scene.shots.findIndex((shot) => shot.id === shotId) : -1;
      return index + 1;
    },
    [scenes],
  );

  // ── 场景/镜头快速管理 ──
  const [sceneForm, setSceneForm] = useState<{ id?: string; heading: string; locationId: string } | null>(null);
  const [shotForm, setShotForm] = useState<{ id: string; sceneId: string; description: string; dialogue: string } | null>(null);
  const [deleteSceneTarget, setDeleteSceneTarget] = useState<ProjectScene | null>(null);

  useEffect(() => {
    if ((sceneForm || shotForm) && locations.length === 0) void loadLocations();
  }, [sceneForm, shotForm, locations.length, loadLocations]);

  const submitSceneForm = () => {
    const draft = sceneForm;
    setSceneForm(null);
    if (!draft || !draft.heading.trim()) return;
    void saveScene({
      id: draft.id,
      episodeId,
      heading: draft.heading.trim(),
      locationId: draft.locationId,
      note: "",
    });
  };

  const submitShotForm = () => {
    const draft = shotForm;
    setShotForm(null);
    if (!draft) return;
    void saveShot({
      id: draft.id || undefined,
      sceneId: draft.sceneId,
      description: draft.description.trim(),
      dialogue: draft.dialogue.trim(),
      status: "none",
      camera: "",
      duration: "",
    });
  };



  // 连线层几何：SVG 尺寸恒等于视口（世界单位，外沿加少量余量），世界
  // 坐标经一层平移换算为 SVG 局部坐标。此前 SVG 按整个世界范围铺（宽度
  // 可达近万 px 的巨型图层），在部分 WebView2 的 GPU 栅格化下超限整层
  // 不绘制，用户端表现为所有连线与拖线草稿不可见；等视口图层在任何
  // 缩放下屏幕栅格尺寸都恒等于视口，从根上消除该问题。
  const wiresVis = {
    x: -view.x / view.scale - WIRES_VIEWPORT_PAD,
    y: -view.y / view.scale - WIRES_VIEWPORT_PAD,
    w: ((vpSize?.w ?? 0) || 1600) / view.scale + WIRES_VIEWPORT_PAD * 2,
    h: ((vpSize?.h ?? 0) || 900) / view.scale + WIRES_VIEWPORT_PAD * 2,
  };

  // 尺寸手柄（四角）：双击不冒泡到节点，避免连点手柄误开详情窗口。
  const resizeHandle = (
    <>
      {(["nw", "ne", "sw", "se"] as const).map((corner) => (
        <span
          key={corner}
          className={`pc-resize ${corner}`}
          data-corner={corner}
          aria-hidden="true"
        />
      ))}
    </>
  );

  // ── 节点详情窗口：按 detailFor 组装条目（预览 + 信息 + 动作）──
  const closeDetail = () => {
    setDetailFor(null);
    setPickerFor(null);
    setMemberPick(null);
    setDetailError("");
  };
  // 窗口惯例：Esc 关闭最上层（二级选择器/装入面板开着时先关它）。
  useEffect(() => {
    if (!detailFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (memberPick) {
        setMemberPick(null);
        return;
      }
      if (pickerFor) {
        setPickerFor(null);
        return;
      }
      setDetailFor(null);
      setDetailError("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailFor, pickerFor, memberPick]);
  // ── 组成员操作：装入/移除/自动同步连线。连线语义 = 组内全部成员
  // 接入片段，所以成员变化要把 node_link 同步到位。 ──
  const entitiesOfKind = useCallback(
    (kind: EntityPhKind) => {
      const episodeList =
        kind === "character" ? castCharacters : kind === "location" ? episodeLocations : episodeProps;
      const globalList = kind === "character" ? characters : kind === "location" ? locations : props;
      // 集关联为主、全局库兜底：组成员在集关联写入空档/缺失时（装入的
      // 关联落库失败或尚未整刷回来）仍可解析出成员实体，组节点不消失。
      const seen = new Set(episodeList.map((e) => e.id));
      return [...episodeList, ...globalList.filter((e) => !seen.has(e.id))];
    },
    [castCharacters, episodeLocations, episodeProps, characters, locations, props],
  );
  // 资料卡新预览：首图大卡片。实体参考图取角色头像/场景与道具参考图；
  // 无图时用类型色淡底 + 名字首字占位（同一卡片形态）。
  const entityRefOf = useCallback(
    (kind: EntityPhKind, entity: { avatar_path?: string; ref_path?: string }) =>
      kind === "character" ? (entity.avatar_path ?? "") : (entity.ref_path ?? ""),
    [],
  );
  const photoMainOf = (name: string, refPath: string) =>
    refPath ? (
      <ResourceImage
        path={joinLibraryPath(libraryRoot, refPath)}
        alt={name}
        className="pc-photo-img"
      />
    ) : (
      <>
        <span className="pc-photo-init">{characterAvatarInitial(name)}</span>
        <span className="pc-photo-sub">{t("project.canvas.noRefImage")}</span>
      </>
    );
  const kindTextOf = useCallback(
    (kind: EntityPhKind) =>
      t(kind === "character" ? "project.canvas.typeCharacter" : kind === "location" ? "project.canvas.typeLocation" : "project.canvas.typeProp"),
    [t],
  );
  const groupWiredPorts = useCallback(
    (group: InfoGroup) => {
      const seen = new Set<string>();
      const out: { to_segment: string; to_port: string }[] = [];
      (overview?.node_links ?? []).forEach((l) => {
        if (l.from_kind !== group.kind || !group.members.includes(l.from_id)) return;
        // 只认本组名下的线：共享成员（同时在其他组）的他组线不算本组
        // 的口。旧数据线无 owner，按成员匹配回退（历史互斥下等价）。
        if (l.owner_key && l.owner_key !== `grp:${group.id}`) return;
        const k = `${l.to_segment}|${l.to_port}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ to_segment: l.to_segment, to_port: l.to_port });
      });
      return out;
    },
    [overview],
  );
  const unlinkEntityLinks = useCallback(
    // ownerKey 传入（组移除成员）时只删该组名下的线——共享成员在其他
    // 组的连线保留；旧数据线无 owner（历史互斥语义下该实体只可能在这
    // 一个组里）视为本组一并清。不传（实体移出本集）全删。
    async (kind: EntityPhKind, entityId: string, ownerKey?: string) => {
      const rows = (overview?.node_links ?? []).filter((l) =>
        l.from_kind === kind && l.from_id === entityId &&
        (ownerKey ? !l.owner_key || l.owner_key === ownerKey : true),
      );
      for (const row of rows) await unlinkNode(row.from_kind, row.from_id, row.to_segment, row.to_port, row.owner_key);
    },
    [overview, unlinkNode],
  );
  const associateEntities = useCallback(
    async (kind: EntityPhKind, ids: string[]) => {
      if (!episodeId || !overview || ids.length === 0) return;
      const episode = overview.episode;
      if (kind === "character") await setEpisodeCharacters(episodeId, [...new Set([...(episode.character_ids ?? []), ...ids])]);
      else if (kind === "location") await setEpisodeLocations(episodeId, [...new Set([...(episode.location_ids ?? []), ...ids])]);
      else await setEpisodeProps(episodeId, [...new Set([...(episode.prop_ids ?? []), ...ids])]);
    },
    [episodeId, overview, setEpisodeCharacters, setEpisodeLocations, setEpisodeProps],
  );
  // ── 详情窗动作集（engine/useDetailActions，2026-11-03 阶段 11d）：
  //    本机上传/打开定位/组员增删，代码零改动搬移 ──
  const { uploadViaImport, handleLocate, removeGroupMember, addGroupMember } = useDetailActions({
    libraryRoot, setDetailError, episodeId, infoGroups, persistInfoGroups,
    infoOffsets, persistInfoOffsets, infoNodePos, unlinkEntityLinks,
    groupWiredPorts, linkNode, associateEntities,
  });
  // ── 删除语义/键盘/成员装入（engine/useDeleteOps，2026-11-03 阶段
  //    11d）：删除分流+撤销快照+Delete 键+applyMemberPick，零改动搬移 ──
  const {
    removeInfoEntity,
    removeGroup,
    detachScript,
    removeScriptPh,
    removePromptPh,
    removeEntityPh,
    handlePromptPick,
    closePromptPick,
    applyMemberPick,
  } = useDeleteOps({
    notes, setNotes, persistNotes, entityPhs, persistEntityPhs, scriptPhs,
    persistScriptPhs, promptPhs, persistPromptPhs, pendingLinks,
    persistPendingLinks, infoGroups, persistInfoGroups, infoNodePos,
    infoOffsets, persistInfoOffsets, nodeGroups, persistNodeGroups, selKeys,
    setSelection, memberPick, setMemberPick, detailFor, setDetailFor,
    pickerFor, episodeId, overview, unlinkNode, linkNode,
    associateEntities, unlinkEntityLinks, groupWiredPorts,
    removeSegment, deleteShot, setEpisodeCharacters,
    setEpisodeLocations, setEpisodeProps, setEpisodeOutput, copySelection,
    pasteClipboard, runUndo, pushUndo, memberFrame,
    groupingRef, promptPickTarget, setPromptPickTarget,
    updateEpisode, dropPendingLinksOf,
    vpRef, addMenu, wireDraft, locationPickOpen, sceneForm, shotForm,
    deleteSceneTarget, scriptPickOpen, setPromptPickOpen, setPromptPickQuery,
    setPulseKeys, spawnAnchorRef,
  });

  // ── 节点详情窗口（layers/DetailDialog，2026-11-03 阶段 11d）：按
  //    detailFor 组装预览/信息/动作，IIFE 组装体零改动搬移 ──
  const detailDialog = (
    <DetailDialog
      detailFor={detailFor}
      detailError={detailError}
      overview={overview}
      libraryRoot={libraryRoot}
      segments={segments}
      scriptPhs={scriptPhs}
      infoGroups={infoGroups}
      promptPhs={promptPhs}
      entityPhs={entityPhs}
      prompts={prompts}
      kindTextOf={kindTextOf}
      uploadViaImport={uploadViaImport}
      handleLocate={handleLocate}
      removeGroupMember={removeGroupMember}
      addGroupMember={addGroupMember}
      castCharacters={castCharacters}
      episodeLocations={episodeLocations}
      episodeProps={episodeProps}
      entitiesOfKind={entitiesOfKind}
      setPromptPickTarget={setPromptPickTarget}
      setMemberPick={setMemberPick}
      closeDetail={closeDetail}
      attachSegmentFromLibrary={attachSegmentFromLibrary}
      setScriptPickTarget={setScriptPickTarget}
      setScriptPickOpen={setScriptPickOpen}
      setPickerFor={setPickerFor}
      setPromptPickOpen={setPromptPickOpen}
      setDetailFor={setDetailFor}
    />
  );

  return (
    <div className="pc-root">
      <div
        ref={vpRef}
        className="pc-viewport"
        onPointerDown={onViewportPointerDown}
        onClickCapture={(e) => {
          if (!suppressClickRef.current) return;
          e.stopPropagation();
          e.preventDefault();
          suppressClickRef.current = false;
        }}
      >
        <div
          className="pc-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <SceneFrames
            scenes={scenes}
            scenePos={scenePos}
            layout={layout}
            pos={pos}
            setSceneForm={setSceneForm}
            setShotForm={setShotForm}
            setDeleteSceneTarget={setDeleteSceneTarget}
          />

          <WiresLayer
            wires={wires}
            segWires={segWires}
            pendingLinks={pendingLinks}
            liftedWire={liftedWire}
            wireDraft={wireDraft}
            outputBox={outputBox}
            segments={segments}
            overview={overview}
            wiresVis={wiresVis}
            outPointOf={outPointOf}
            inPointOf={inPointOf}
            portsOf={portsOf}
            nodeWireColorOf={nodeWireColorOf}
          />
          <ShotCards
            cards={layout.cards}
            pos={pos}
            selKeys={selKeys}
            nodeSizes={nodeSizes}
            sizeOfNode={sizeOfNode}
            shotNoOf={shotNoOf}
            portBar={portBar}
            resizeHandle={resizeHandle}
            libraryRoot={libraryRoot}
            onPickForShot={onPickForShot}
            setShotForm={setShotForm}
            deleteShot={deleteShot}
          />

          <NodeGroupsLayer nodeGroups={nodeGroups} memberFrame={memberFrame} />
          <InfoNodesLayer
            infoNodes={infoNodes}
            infoGroups={infoGroups}
            infoNodePos={infoNodePos}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            pulseKeys={pulseKeys}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            libraryRoot={libraryRoot}
            entitiesOfKind={entitiesOfKind}
            entityRefOf={entityRefOf}
            photoMainOf={photoMainOf}
            openInfoDetail={openInfoDetail}
            removeGroup={removeGroup}
            detachScript={detachScript}
            removeScriptPh={removeScriptPh}
            removeInfoEntity={removeInfoEntity}
          />

          <EntityPhNodes
            entityPhs={entityPhs}
            infoNodePos={infoNodePos}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            setDetailFor={setDetailFor}
            removeEntityPh={removeEntityPh}
          />
          <PromptPhNodes
            promptPhs={promptPhs}
            prompts={prompts}
            infoNodePos={infoNodePos}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            setPromptPickTarget={setPromptPickTarget}
            setPromptPickOpen={setPromptPickOpen}
            setDetailFor={setDetailFor}
            removePromptPh={removePromptPh}
          />
          <SegmentNodes
            segments={segments}
            segPos={segPos}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            libraryRoot={libraryRoot}
            moveSegment={moveSegment}
            setDetailFor={setDetailFor}
            removeSegment={removeSegment}
          />
          <OutputNode
            outputBox={outputBox}
            segments={segments}
            outputSourceLabel={outputSourceLabel}
            episodeId={episodeId}
            sizeOfNode={sizeOfNode}
            nodeSizes={nodeSizes}
            selKeys={selKeys}
            portBar={portBar}
            resizeHandle={resizeHandle}
            setEpisodeOutput={setEpisodeOutput}
          />
          <NoteNodes
            notes={notes}
            selKeys={selKeys}
            sizeOfNode={sizeOfNode}
            resizeHandle={resizeHandle}
            editingNoteId={editingNoteId}
            noteDraft={noteDraft}
            setNoteDraft={setNoteDraft}
            setEditingNoteId={setEditingNoteId}
            persistNotes={persistNotes}
          />
        </div>

        <CutTrailLayer cutTrailUnderRef={cutTrailUnderRef} cutTrailRef={cutTrailRef} />

        <IssueBar
          issues={issues}
          scriptPhs={scriptPhs}
          segments={segments}
          locateOutput={locateOutput}
          locateScript={locateScript}
          armSpawnFromEvent={armSpawnFromEvent}
          addScriptPh={addScriptPh}
          locateEmptySegment={locateEmptySegment}
          setDetailFor={setDetailFor}
        />
        <AddMenuBlock
          addMenu={addMenu}
          addMenuQuery={addMenuQuery}
          setAddMenuQuery={setAddMenuQuery}
          setAddMenu={setAddMenu}
          discardDetachedWire={discardDetachedWire}
          setLiftedWire={setLiftedWire}
          armSpawnAt={armSpawnAt}
          addScriptPh={addScriptPh}
          setLocationPickOpen={setLocationPickOpen}
          dragRef={dragRef}
        />

        <EpisodeCard overlay={overlay} scenes={scenes} looseAssets={looseAssets} wires={wires} />

        <div className="pc-tip">{t("project.canvas.tip")}</div>

        <ZoomBar view={view} zoomAt={zoomAt} fitAll={fitAll} vpRef={vpRef} />
        <MiniMap
          scenes={scenes}
          scenePos={scenePos}
          layout={layout}
          pos={pos}
          view={view}
          vpSize={vpSize}
          vpRef={vpRef}
          setView={setView}
          saveView={saveView}
        />
        <AddBtnBar onPickForShot={onPickForShot} setSceneForm={setSceneForm} />
      </div>

      <SceneFormDialog
        sceneForm={sceneForm}
        setSceneForm={setSceneForm}
        locations={locations}
        submitSceneForm={submitSceneForm}
      />

      <ShotFormDialog
        shotForm={shotForm}
        setShotForm={setShotForm}
        submitShotForm={submitShotForm}
      />

      <DeleteSceneConfirm
        deleteSceneTarget={deleteSceneTarget}
        setDeleteSceneTarget={setDeleteSceneTarget}
        deleteScene={deleteScene}
      />
      {/* 节点详情预览窗口：双击节点的独立窗口（预览 + 信息 + 上传/库选） */}
      {detailDialog}
      <SegmentAttachPicker
        pickerFor={pickerFor}
        setPickerFor={setPickerFor}
        attachSegmentFromLibrary={attachSegmentFromLibrary}
      />
      <ScriptPickDialog
        scriptPickOpen={scriptPickOpen}
        setScriptPickTarget={setScriptPickTarget}
        setScriptPickOpen={setScriptPickOpen}
        handleScriptPick={handleScriptPick}
      />
      <PromptPickDialog
        promptPickOpen={promptPickOpen}
        closePromptPick={closePromptPick}
        promptPickQuery={promptPickQuery}
        setPromptPickQuery={setPromptPickQuery}
        prompts={prompts}
        handlePromptPick={handlePromptPick}
      />
      <LocationPickPanel
        locationPickOpen={locationPickOpen}
        setLocationPickOpen={setLocationPickOpen}
        episodeId={episodeId}
        locationIds={overview?.episode.location_ids ?? []}
        setEpisodeLocations={setEpisodeLocations}
      />
      <MemberPickPanel
        memberPick={memberPick}
        setMemberPick={setMemberPick}
        kindTextOf={kindTextOf}
        applyMemberPick={applyMemberPick}
      />
    </div>
  );
}
