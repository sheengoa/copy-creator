import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { CanvasNode, CanvasNodeType } from "../../stores/canvasStore";
import { useCanvasData } from "./dataContext";
import { extOf } from "./nodes/exts";
import {
  LIBRARY_PICKER_KINDS,
  loadAllowedExts,
  NODE_DEFAULT_SIZE,
  NODE_DEFS,
  isVideoToolType,
} from "./nodes/registry";
import { groupSnapshotOf, memberFrameOf } from "./engine/groupOps";
import { useViewport } from "./engine/useViewport";
import { useNodeMetrics } from "./engine/useNodeMetrics";
import { useUndoStack } from "./engine/useUndoStack";
import { useClipboardOps } from "./engine/useClipboardOps";
import { useCanvasGestures } from "./engine/useCanvasGestures";
import { useKeyboardShortcuts } from "./engine/useKeyboardShortcuts";
import { useFileDrop } from "./engine/useFileDrop";
import { WiresLayer, CutTrailLayer } from "./layers/WiresLayer";
import { NodeGroupsLayer } from "./layers/NodeGroupsLayer";
import { NodesLayer } from "./layers/NodesLayer";
import { AddMenu } from "./layers/AddMenu";
import { MiniMap } from "./layers/MiniMap";
import {
  CanvasStatCard,
  CanvasTip,
  ZoomBar,
  SeedButton,
  DropHintOverlay,
  LightboxLayer,
  BatchBarLayer,
  LibraryPickerLayer,
} from "./layers/CanvasOverlays";
import { SaveRuntimeProvider } from "./nodes/saveRuntime";
import { GenRuntimeProvider } from "./nodes/genRuntime";
import { useVideoToolRuntimeController } from "./nodes/videoToolRuntime";
import { VideoToolRuntimeProvider } from "./nodes/VideoToolRuntimeProvider";
import { useNodeErrors } from "./nodes/nodeErrors";
import { upstreamMediaOf as upstreamMediaQuery } from "./nodes/upstream";
import type { NodeServices } from "./nodes/types";
import type { ViewState } from "./engine/useViewport";

// 自由生图工作流画布（画布区方案 3.3 + 节点体系 v2）：以旧 ProjectCanvas（已退役）为
// 基座 fork——引擎框架（视口/连线/切线/框选/分组/菜单）自工程画布搬运；
// 连线为「类型化端口」语义（用户 2026-10-31 定案）：生成/加载/输出三类
// 链路，多输入口 + 口名常显 + 类型匹配校验（accepts 矩阵），生成节点的
// 生成前提 = 文本口已连非空文本 + 输出口已连保存/预览。产物由保存节点
// 决定去向（入库 / 另存任意路径），生成节点只暂存在托管目录。

// ── 手势状态类型与连线几何已上移 engine/（gestureTypes.ts / wireGeom.ts）──

export default function FreeCanvas({ canvasId, renderWires, onOpenNodeDetail, overlays }: { canvasId: string; /** 工程作用域注入：双击节点开详情（自由画布不传，无此能力）。 */ onOpenNodeDetail?: (node: CanvasNode) => void; /** 作用域外围件槽位（工程壳的缺项条/集信息卡/新建栏/弹窗）：渲染为 .pc-root 内视口的兄弟层。 */ overlays?: React.ReactNode; /** 连线渲染插槽（工程视图节点化阶段 C）：提供时替代内置连线层，工程作用域经此接入旧 WiresLayer（gen 链/端口线/暂存线/成片线）。 */ renderWires?: (ctx: { view: ViewState; vpSize: { w: number; h: number } | null; liftedWire: { connId: string; fromKey: string } | null; wireDraft: { d: string; invalid: boolean; color?: string } | null; outPointOf(key: string): { x: number; y: number } | null; inPointOf(key: string, portId?: string): { x: number; y: number } | null }) => React.ReactNode }) {
  const { t } = useTranslation();
  // 几何层数据源（dataContext）：默认实现转发 canvasStore；工程视图
  // （ProjectShell）注入工程 provider 后本组件与其引擎链零改动复用。
  const data = useCanvasData();
  const nodes = data.useNodes();
  const connections = data.useConnections();
  const groups = data.useGroups();

  const nodesRef = useRef(nodes);
  const connectionsRef = useRef(connections);
  const selRef = useRef<string[]>([]);

  const [selKeys, setSelKeys] = useState<string[]>([]);
  const setSelection = useCallback((keys: string[]) => {
    selRef.current = keys;
    setSelKeys(keys);
  }, []);

  // 节点错误文案（UI 层小 store nodes/nodeErrors）：取媒/换片失败写。
  const setNodeErrors = useNodeErrors((s) => s.setErrors);
  /** 资源库选择浮层：load 节点的「从资源库选择」。 */
  const [pickerForNode, setPickerForNode] = useState<string | null>(null);
  /** 大图预览（预览图像节点双击）：暂存产物路径。 */
  const [lightboxSrc, setLightboxSrc] = useState("");
  /** 合集行定位请求（2026-11-04）：n 自增让同节点连点也能重触发；
   *  实际平移 + 脉冲在手势钩子构建后的效果里执行（那边才有 pulseNodes）。 */
  const [locate, setLocate] = useState<{ id: string; n: number } | null>(null);

  // 渲染后同步镜像：窗口级手势回调读 ref 免闭包陈旧（react-hooks/refs
  // 禁止渲染期写 ref，统一在 effect 提交）。
  useEffect(() => {
    nodesRef.current = nodes;
    connectionsRef.current = connections;
  }, [nodes, connections]);
  useEffect(() => {
    selRef.current = selKeys;
  }, [selKeys]);

  // ── 视口引擎 + 节点实测（engine/useViewport / useNodeMetrics；fork 自
  //    旧 ProjectCanvas，已退役） ──
  const { vpRef, view, setView, vpSize, saveView, zoomAt, fitAll, fitAttemptedRef } = useViewport(nodes);
  const { nodeMetricsRef, boxOf, outPointOf, inPointOf } = useNodeMetrics(vpRef, view, nodes);

  // ── 撤销栈与删除（engine/useUndoStack） ──
  const { pushUndo, runUndo, deleteNodes } = useUndoStack(setSelection);
  const deleteSelected = useCallback(async () => {
    await deleteNodes(nodesRef, connectionsRef, selRef.current);
  }, [connectionsRef, deleteNodes, nodesRef]);

  // ── 组布局操作（engine/groupOps 纯函数 + 本组件 ref 薄包装） ──
  const groupSnapshot = useCallback(
    (minCount = 2) => groupSnapshotOf(selRef, nodesRef, minCount),
    [nodesRef, selRef],
  );
  // 组成员包围盒：实测尺寸优先（boxOf，nodeMetrics 缓存）。height=null 的
  // 自动高度节点按内容撑开，store 兜底高会比实际矮——只用兜底值时组框
  // 下缘算小，成员向下拖就会跑出框（上/左/右只涉及 x/y min-max 不受
  // 影响）。未实测首帧回退 store 尺寸。
  const memberFrame = useCallback(
    (key: string) => boxOf(key) ?? memberFrameOf(nodesRef, key),
    [boxOf, nodesRef],
  );

  // ── 复制 / 粘贴（engine/useClipboardOps） ──
  const { copySelection, pasteClipboard } = useClipboardOps(
    nodesRef, connectionsRef, selRef, setSelection, pushUndo,
  );

  // ── 上游媒体解析（预览/保存节点取上游产物） ────────────────

  /** 上游产物聚合。null 严格表示「没有上游连接」；连了但暂无产物（生成
   *  中 / 未生成 / 加载节点还没选文件）返回空 paths，供占位文案区分
   *  「未连接上游」与「已连接，等待产物」。聚合与就绪判定查
   *  nodes/upstream 的 def 注册表（gen_image 主图置顶、load_text 文本，
   *  缺省走 resource_path）。 */
  const upstreamMediaOf = useCallback(
    (nodeId: string) => upstreamMediaQuery(nodes, connections, nodeId),
    [connections, nodes],
  );
  // 视频工具运行时（时间轴预取/拖动会话/执行命令）：controller 由本组件
  // 持有（applyFrameVideo 换片也要清会话态），Provider 下发给节点模块。
  const videoToolRuntime = useVideoToolRuntimeController();
  // 资源库浮层的写入意图：加载节点写 resourcePath；视频工具节点写
  // metadata.video_path（视频是输入，产物占 resource_path）。

  const pickerApplyRef = useRef<"resource" | "frame-video">("resource");
  /** 打开浮层时记录的类型白名单（渲染时传给浮层过滤列表；ref 在同一次
   *  事件里先于 setPickerForNode 更新，渲染读到的必是新值）。 */
  const pickerKindsRef = useRef<string[] | null>(null);

  const pickFromLibrary = (node: CanvasNode) => {
    pickerApplyRef.current = isVideoToolType(node.type) ? "frame-video" : "resource";
    pickerKindsRef.current = LIBRARY_PICKER_KINDS[node.type] ?? null;
    setPickerForNode(node.id);
  };

  /** 视频工具节点换视频：清旧产物（resource_path）+ 写新视频路径并重置
   *  选点/选区参数（format 与视频无关，保留用户选择），下游自动保存对
   *  空产物自然停摆。useCallback 化：OS 拖入命中节点时也走这里，引用
   *  稳定才不致全局拖放监听随渲染反复重挂。 */
  const applyFrameVideo = useCallback(
    async (nodeId: string, type: CanvasNodeType, videoPath: string) => {
      const prev = data.nodes().find((n) => n.id === nodeId);
      const prevMeta = prev?.metadata as { format?: unknown } | undefined;
      const prevFormat = typeof prevMeta?.format === "string" ? prevMeta.format : "";
      const base: Record<string, unknown> = { kind: type, video_path: videoPath };
      if (type === "video_seek_frame" || type === "video_to_gif" || type === "video_extract_audio") {
        base.start_secs = 0;
        base.duration_secs = 0;
        base.format = prevFormat;
      }
      // 换视频后旧选点/选区不再成立，会话态一并清；旧视频的轨道失败
      // 记账也清掉（同一坏路径重新选入时允许再试一次），旧错误文案随
      // 换片过期，一并摘除。
      videoToolRuntime.resetToolSession(nodeId, videoPath);
      setNodeErrors((prev) => {
        if (!prev[nodeId]) return prev;
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      await data.updateNode(nodeId, {
        resourcePath: "",
        metadata: JSON.stringify(base),
      });
    },
    [data, setNodeErrors, videoToolRuntime],
  );

  const pickFromDisk = async (node: CanvasNode) => {
    try {
      const allowed = loadAllowedExts(node.type);
      const picked = await invoke<{ path: string }>("canvas_pick_media_file", {
        extensions: allowed,
      });
      // 对话框 filter 可被「所有文件」输入绕过：返回后再按扩展名校验一次。
      if (allowed.length > 0 && !allowed.includes(extOf(picked.path))) {
        setNodeErrors((prev) => ({ ...prev, [node.id]: t("canvas.loadTypeMismatch") }));
        return;
      }
      if (isVideoToolType(node.type)) {
        await applyFrameVideo(node.id, node.type, picked.path);
      } else {
        await data.updateNode(node.id, { resourcePath: picked.path });
      }
    } catch (err) {
      // 用户在系统对话框取消：静默；其余错误在节点上提示。
      const msg = String(err);
      if (!msg.includes("cancelled") && !msg.includes("取消")) {
        setNodeErrors((prev) => ({ ...prev, [node.id]: msg }));
      }
    }
  };
  // 跨模块服务（下发 def.onDoubleClick 与节点模块）。取媒浮层/清除的
  // 写回分派按 def.applyMode：video-tool 写 video_path（applyFrameVideo），
  // resource 直写 resource_path。闭包引用渲染期状态，事件期执行时已初始化。
  const canvasServices: NodeServices = {
    openLightbox: (path) => setLightboxSrc(path),
    upstream: (nodeId) => upstreamMediaOf(nodeId),
    locateNode: (nodeId) => setLocate((p) => ({ id: nodeId, n: (p?.n ?? 0) + 1 })),
    ...(onOpenNodeDetail ? { openNodeDetail: (node: CanvasNode) => onOpenNodeDetail(node) } : {}),
    pickMedia: (node, source) => {
      if (source === "library") pickFromLibrary(node);
      else void pickFromDisk(node);
    },
    clearMedia: (node) => {
      if (isVideoToolType(node.type)) videoToolRuntime.clearFrameVideo(node);
      else void data.updateNode(node.id, { resourcePath: "" });
    },
  };
  // ── 手势会话（engine/useCanvasGestures）：按下分派 + 窗口级 move/up/cancel ──
  const {
    onViewportPointerDown,
    dragRef,
    suppressClickRef,
    cutTrailRef,
    cutTrailUnderRef,
    wireDraft,
    liftedWire,
    addMenu,
    addMenuQuery,
    setAddMenuQuery,
    closeAddMenu,
    discardDetachedWire,
    pulseKeys,
    pulseNodes,
    commitAddNode,
  } = useCanvasGestures({
    vpRef,
    view,
    setView,
    saveView,
    nodesRef,
    connectionsRef,
    selRef,
    setSelection,
    groups,
    memberFrame,
    groupSnapshot,
    boxOf,
    outPointOf,
    inPointOf,
    nodeMetricsRef,
    canvasServices,
    pushUndo,
  });

  // 合集行定位执行（2026-11-04）：canvasServices 先于手势钩子构建，
  // 行点击经 locate 状态中转到这里——先触发边缘脉冲闪烁（复用出生脉冲
  // pc-spawn 的现成视觉语言，不另做一套光晕），源节点四周留 48px 边距
  // 仍不完整可见时再平移居中（缩放不动，与手势平移同落库）。
  // 处理完立即清零：locate 是一次性请求，残留会在 view/memberFrame 等
  // 依赖因无关更新换身份时把旧定位重放（拖拽排序落库即复现，浏览器实测）。
  useEffect(() => {
    if (!locate) return;
    setLocate(null);
    pulseNodes([locate.id]);
    const rect = vpRef.current?.getBoundingClientRect();
    const box = memberFrame(locate.id);
    if (!rect || rect.width === 0 || !box) return;
    const { scale, x, y } = view;
    const pad = 48;
    const sx = box.x * scale + x;
    const sy = box.y * scale + y;
    if (sx >= pad && sy >= pad && sx + box.w * scale <= rect.width - pad && sy + box.h * scale <= rect.height - pad) return;
    const next = {
      x: rect.width / 2 - (box.x + box.w / 2) * scale,
      y: rect.height / 2 - (box.y + box.h / 2) * scale,
      scale,
    };
    setView(next);
    saveView(next);
  }, [locate, memberFrame, pulseNodes, saveView, setLocate, setView, view, vpRef]);

  // ── 键盘快捷键（engine/useKeyboardShortcuts）：删除/撤销/全选/复制粘贴/打组 ──
  useKeyboardShortcuts(
    vpRef,
    nodesRef,
    selRef,
    setSelection,
    !!addMenu,
    copySelection,
    pasteClipboard,
    runUndo,
    deleteSelected,
  );


  // ── 合集节点（唯一多线入口）：成员解析 + 拖拽排序 ─────────

  // ── 生图（图像生成节点）：参数编辑、生成、主图切换 ─────────

  // ── 空画布示意（方案 3.6）：一键创建 文本→图像生成→预览 工作流 ──

  const seedTemplate = useCallback(async () => {
    const rect = vpRef.current?.getBoundingClientRect();
    const center = rect
      ? {
          x: (rect.left + rect.width / 2 - rect.left - view.x) / view.scale,
          y: (rect.top + rect.height / 2 - rect.top - view.y) / view.scale,
        }
      : { x: 0, y: 0 };
    const text = await data.createNode({
      nodeType: "load_text",
      posX: center.x - 420,
      posY: center.y - 60,
      width: NODE_DEFAULT_SIZE.load_text.w,
      height: NODE_DEFAULT_SIZE.load_text.h,
      metadata: JSON.stringify({ kind: "load_text", content: t("canvas.seedPrompt") }),
    });
    if (!text) return;
    const img = await data.createNode({
      nodeType: "gen_image",
      posX: center.x - 60,
      posY: center.y - 130,
      width: NODE_DEFAULT_SIZE.gen_image.w,
      height: NODE_DEFAULT_SIZE.gen_image.h,
    });
    if (!img) return;
    const preview = await data.createNode({
      nodeType: "preview_image",
      posX: center.x + 330,
      posY: center.y - 110,
      width: NODE_DEFAULT_SIZE.preview_image.w,
      height: NODE_DEFAULT_SIZE.preview_image.h,
    });
    await data.connect(text.id, img.id, "text");
    if (preview) await data.connect(img.id, preview.id, "in");
    pushUndo({ kind: "create", ids: [text.id, img.id, ...(preview ? [preview.id] : [])] });
    pulseNodes([text.id, img.id, ...(preview ? [preview.id] : [])]);
    setSelection([text.id, img.id]);
    // 种子完成后整体适配窗口。
    if (fitAll(data.nodes())) {
      fitAttemptedRef.current = true;
    }
  }, [data, fitAll, fitAttemptedRef, pushUndo, pulseNodes, setSelection, t, view.scale, view.x, view.y, vpRef]);

  // ── OS 文件拖入（engine/useFileDrop）：命中加载/抽帧节点 = 加载到该
  //    节点；空白 = 新建加载节点 ──
  const dropHint = useFileDrop(vpRef, view, nodesRef, applyFrameVideo, pulseNodes);


  // ── 渲染 ───────────────────────────────────────────────────

  /** 多选中的可批量生成节点（def.batchGenerate；执行在 GenRuntimeProvider）。 */
  const selectedGenIds = selKeys.filter((id) => {
    const n = nodes.find((m) => m.id === id);
    return !!n && NODE_DEFS[n.type].batchGenerate === true;
  });

  return (
    <GenRuntimeProvider canvasId={canvasId} selectedGenIds={selectedGenIds}>
    <div className="pc-root fc-root">
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
          {renderWires ? (
            renderWires({ view, vpSize, liftedWire, wireDraft, outPointOf, inPointOf })
          ) : (
            <WiresLayer
              connections={connections}
              nodes={nodes}
              view={view}
              vpSize={vpSize}
              liftedWire={liftedWire}
              wireDraft={wireDraft}
              outPointOf={outPointOf}
              inPointOf={inPointOf}
            />
          )}

          <NodeGroupsLayer groups={groups} memberFrame={memberFrame} />

          {/* 保存节点自动保存管线运行时（SaveMediaBody 经 Context 取操作） */}
          <VideoToolRuntimeProvider runtime={videoToolRuntime}>
          <SaveRuntimeProvider>
          <NodesLayer
            nodes={nodes}
            selKeys={selKeys}
            pulseKeys={pulseKeys}
            scale={view.scale}
            canvasServices={canvasServices}
            nodesRef={nodesRef}
            connectionsRef={connectionsRef}
            deleteNodes={deleteNodes}
          />
          </SaveRuntimeProvider>
          </VideoToolRuntimeProvider>
        </div>
        <CutTrailLayer cutTrailUnderRef={cutTrailUnderRef} cutTrailRef={cutTrailRef} />

        {/* 双击空白的节点选择框（ComfyUI 搜索框的对应物） */}
        {addMenu && (
          <AddMenu
            addMenu={addMenu}
            addMenuQuery={addMenuQuery}
            setAddMenuQuery={setAddMenuQuery}
            closeAddMenu={closeAddMenu}
            discardDetachedWire={discardDetachedWire}
            commitAdd={commitAddNode}
            dragRef={dragRef}
            vpRef={vpRef}
            nodes={nodes}
          />
        )}

        <SeedButton
          nodes={nodes}
          connections={connections}
          addMenuOpen={!!addMenu}
          onSeed={() => void seedTemplate()}
          hidden={data.scope === "project"}
        />

        <DropHintOverlay visible={dropHint} />

        <BatchBarLayer selectedGenIds={selectedGenIds} />

        {/* 资源库选择浮层：加载节点与抽帧节点的「从资源库选择」入口 */}
        {pickerForNode && (
          <LibraryPickerLayer
            pickerForNode={pickerForNode}
            pickerApplyRef={pickerApplyRef}
            pickerKindsRef={pickerKindsRef}
            applyFrameVideo={applyFrameVideo}
            onClose={() => setPickerForNode(null)}
          />
        )}

        <LightboxLayer src={lightboxSrc} onClose={() => setLightboxSrc("")} />

        <CanvasStatCard nodes={nodes} connections={connections} />

        <CanvasTip />

        <ZoomBar view={view} zoomAt={zoomAt} vpRef={vpRef} />

        <MiniMap
          nodes={nodes}
          view={view}
          setView={setView}
          saveView={saveView}
          vpSize={vpSize}
          vpRef={vpRef}
        />
        {overlays}
      </div>
    </div>
    </GenRuntimeProvider>
  );
}
