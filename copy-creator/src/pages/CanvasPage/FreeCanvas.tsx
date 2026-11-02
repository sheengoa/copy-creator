import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ImageLightbox } from "../../components/ImageLightbox";
import { joinLibraryPath } from "../../domain/projectView";
import ProjectFilePickerDialog from "../ResourcePage/ProjectFilePickerDialog";
import {
  useCanvasStore,
  type CanvasNode,
  type CanvasNodeType,
} from "../../stores/canvasStore";
import { extOf } from "./nodes/exts";
import {
  LIBRARY_PICKER_KINDS,
  loadAllowedExts,
  menuGroups,
  menuIconOf,
  NODE_DEFAULT_SIZE,
  NODE_DEFS,
  outMediaColor,
  PORT_DEFS,
  isVideoToolType,
} from "./nodes/registry";
import { NodeHint } from "./nodes/NodeHint";
import { NodeShell } from "./nodes/shell";
import { WheelGate } from "./nodes/WheelGate";
import { MINI_H, MINI_W, WIRES_VIEWPORT_PAD } from "./engine/gestureTypes";
import { nodeSize, wirePathD } from "./engine/wireGeom";
import { groupSnapshotOf, memberFrameOf } from "./engine/groupOps";
import { useViewport } from "./engine/useViewport";
import { useNodeMetrics } from "./engine/useNodeMetrics";
import { useUndoStack } from "./engine/useUndoStack";
import { useClipboardOps } from "./engine/useClipboardOps";
import { useCanvasGestures } from "./engine/useCanvasGestures";
import { useKeyboardShortcuts } from "./engine/useKeyboardShortcuts";
import { useFileDrop } from "./engine/useFileDrop";
import { useMediaUrl } from "./nodes/mediaPath";
import { SaveRuntimeProvider } from "./nodes/saveRuntime";
import { GenRuntimeProvider } from "./nodes/genRuntime";
import { BatchBar } from "./nodes/BatchBar";
import { useVideoToolRuntimeController } from "./nodes/videoToolRuntime";
import { VideoToolRuntimeProvider } from "./nodes/VideoToolRuntimeProvider";
import { useNodeErrors } from "./nodes/nodeErrors";
import { upstreamMediaOf as upstreamMediaQuery } from "./nodes/upstream";
import type { NodeServices } from "./nodes/types";

// 自由生图工作流画布（画布区方案 3.3 + 节点体系 v2）：以 ProjectCanvas 为
// 基座 fork——引擎框架（视口/连线/切线/框选/分组/菜单）自工程画布搬运；
// 连线为「类型化端口」语义（用户 2026-10-31 定案）：生成/加载/输出三类
// 链路，多输入口 + 口名常显 + 类型匹配校验（accepts 矩阵），生成节点的
// 生成前提 = 文本口已连非空文本 + 输出口已连保存/预览。产物由保存节点
// 决定去向（入库 / 另存任意路径），生成节点只暂存在托管目录。

// ── 手势状态类型与连线几何已上移 engine/（gestureTypes.ts / wireGeom.ts）──

export default function FreeCanvas({ canvasId }: { canvasId: string }) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const connections = useCanvasStore((s) => s.connections);
  const groups = useCanvasStore((s) => s.groups);

  const store = useCanvasStore;
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
  //    ProjectCanvas，回灌对齐点不变） ──
  const { vpRef, view, setView, vpSize, saveView, zoomAt, fitAll, fitAttemptedRef } = useViewport(canvasId, nodes);
  const { nodeMetricsRef, boxOf, outPointOf, inPointOf } = useNodeMetrics(vpRef, view, nodes);

  // ── 撤销栈与删除（engine/useUndoStack） ──
  const { pushUndo, runUndo, deleteNodes } = useUndoStack(canvasId, setSelection);
  const deleteSelected = useCallback(async () => {
    await deleteNodes(nodesRef, connectionsRef, selRef.current);
  }, [connectionsRef, deleteNodes, nodesRef]);

  // ── 组布局操作（engine/groupOps 纯函数 + 本组件 ref 薄包装） ──
  const groupSnapshot = useCallback(
    (minCount = 2) => groupSnapshotOf(selRef, nodesRef, minCount),
    [nodesRef, selRef],
  );
  const memberFrame = useCallback((key: string) => memberFrameOf(nodesRef, key), [nodesRef]);

  // ── 复制 / 粘贴（engine/useClipboardOps） ──
  const { copySelection, pasteClipboard } = useClipboardOps(
    canvasId, nodesRef, connectionsRef, selRef, setSelection, pushUndo,
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
      const prev = store.getState().nodes.find((n) => n.id === nodeId);
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
      await store.getState().updateNode(nodeId, {
        resourcePath: "",
        metadata: JSON.stringify(base),
      });
    },
    [store, setNodeErrors, videoToolRuntime],
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
        await store.getState().updateNode(node.id, { resourcePath: picked.path });
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
    pickMedia: (node, source) => {
      if (source === "library") pickFromLibrary(node);
      else void pickFromDisk(node);
    },
    clearMedia: (node) => {
      if (isVideoToolType(node.type)) videoToolRuntime.clearFrameVideo(node);
      else void store.getState().updateNode(node.id, { resourcePath: "" });
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
  } = useCanvasGestures({
    canvasId,
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

  // ── 键盘快捷键（engine/useKeyboardShortcuts）：删除/撤销/全选/复制粘贴/打组 ──
  useKeyboardShortcuts(
    canvasId,
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
    const st = store.getState();
    const text = await st.createNode({
      canvasId,
      nodeType: "load_text",
      posX: center.x - 420,
      posY: center.y - 60,
      width: NODE_DEFAULT_SIZE.load_text.w,
      height: NODE_DEFAULT_SIZE.load_text.h,
      metadata: JSON.stringify({ kind: "load_text", content: t("canvas.seedPrompt") }),
    });
    if (!text) return;
    const img = await st.createNode({
      canvasId,
      nodeType: "gen_image",
      posX: center.x - 60,
      posY: center.y - 130,
      width: NODE_DEFAULT_SIZE.gen_image.w,
      height: NODE_DEFAULT_SIZE.gen_image.h,
    });
    if (!img) return;
    const preview = await st.createNode({
      canvasId,
      nodeType: "preview_image",
      posX: center.x + 330,
      posY: center.y - 110,
      width: NODE_DEFAULT_SIZE.preview_image.w,
      height: NODE_DEFAULT_SIZE.preview_image.h,
    });
    await st.connect(canvasId, text.id, img.id, "text");
    if (preview) await st.connect(canvasId, img.id, preview.id, "in");
    pushUndo({ kind: "create", ids: [text.id, img.id, ...(preview ? [preview.id] : [])] });
    pulseNodes([text.id, img.id, ...(preview ? [preview.id] : [])]);
    setSelection([text.id, img.id]);
    // 种子完成后整体适配窗口。
    if (fitAll(store.getState().nodes)) {
      fitAttemptedRef.current = true;
    }
  }, [canvasId, fitAll, fitAttemptedRef, pushUndo, pulseNodes, setSelection, store, t, view.scale, view.x, view.y, vpRef]);

  // ── OS 文件拖入（engine/useFileDrop）：命中加载/抽帧节点 = 加载到该
  //    节点；空白 = 新建加载节点 ──
  const dropHint = useFileDrop(canvasId, vpRef, view, nodesRef, applyFrameVideo, pulseNodes);


  // ── 渲染 ───────────────────────────────────────────────────

  /** 多选中的可批量生成节点（def.batchGenerate；执行在 GenRuntimeProvider）。 */
  const selectedGenIds = selKeys.filter((id) => {
    const n = nodes.find((m) => m.id === id);
    return !!n && NODE_DEFS[n.type].batchGenerate === true;
  });

  // 连线层（卡片之下）：按视口尺寸渲染 + 平移组换算世界坐标。
  const wiresVis = {
    x: -view.x / view.scale - WIRES_VIEWPORT_PAD,
    y: -view.y / view.scale - WIRES_VIEWPORT_PAD,
    w: ((vpSize?.w ?? 0) || 1600) / view.scale + WIRES_VIEWPORT_PAD * 2,
    h: ((vpSize?.h ?? 0) || 900) / view.scale + WIRES_VIEWPORT_PAD * 2,
  };

  // 迷你地图比例：内容包围盒铺满小地图。
  const miniBBox = (() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const size = nodeSize(n);
      minX = Math.min(minX, n.pos_x);
      minY = Math.min(minY, n.pos_y);
      maxX = Math.max(maxX, n.pos_x + size.w);
      maxY = Math.max(maxY, n.pos_y + size.h);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  })();
  const miniRatio = miniBBox
    ? Math.min(MINI_W / Math.max(miniBBox.w, 1), MINI_H / Math.max(miniBBox.h, 1))
    : 1;

  // 菜单条目数据（menuGroups/menuIconOf）在 nodes/registry；这里只保留
  // 连线续接的 accepts 过滤（拖线/摘线到空白时只列能接上的节点类型）。
  const menuFilterType = (type: CanvasNodeType): boolean => {
    const pending = addMenu?.wire ?? (addMenu?.detached ? { fromKey: addMenu.detached.fromKey, fromDir: "in" as const, fromPortId: "" } : null);
    if (!pending) return true;
    const fromNode = nodes.find((n) => n.id === pending.fromKey);
    if (!fromNode) return true;
    if (pending.fromDir === "out") {
      // 正拖：新节点需要能接住上游类型的输入口。
      return PORT_DEFS[type].ins.some((p) => p.accepts.includes(fromNode.type));
    }
    if (pending.fromDir === "in" && !addMenu?.detached) {
      // 反拖：新节点是上游，需有 out 且被源输入口接受。
      const inDef = PORT_DEFS[fromNode.type].ins.find((p) => p.id === pending.fromPortId);
      return !!PORT_DEFS[type].out && (!inDef || inDef.accepts.includes(type));
    }
    // 摘线：新节点作为下游，需要能接住原上游的口。
    return PORT_DEFS[type].ins.some((p) => p.accepts.includes(fromNode.type));
  };

  const lightboxUrl = useMediaUrl(lightboxSrc);

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
          <svg
            className="pc-wires"
            aria-hidden="true"
            style={{
              left: wiresVis.x,
              top: wiresVis.y,
              width: wiresVis.w,
              height: wiresVis.h,
            }}
          >
            <g transform={`translate(${-wiresVis.x}, ${-wiresVis.y})`}>
              {connections.map((conn) => {
                // 被摘下的线（拿着换目标中）暂时隐藏，收尾时转接或放回。
                if (liftedWire && conn.id === liftedWire.connId) return null;
                const from = nodes.find((n) => n.id === conn.from_node);
                const to = nodes.find((n) => n.id === conn.to_node);
                if (!from || !to) return null;
                const a = outPointOf(from.id);
                const b = inPointOf(to.id, conn.to_port || PORT_DEFS[to.type].ins[0]?.id || "in");
                if (!a || !b) return null;
                const d = wirePathD(a, b);
                return (
                  <g key={conn.id} className="pc-wire" data-cut={conn.id}>
                    <path className="pc-wire-hit" d={d} />
                    <path className="pc-wire-line" d={d} style={{ stroke: outMediaColor(from.type) }} />
                  </g>
                );
              })}
              {wireDraft && (
                <path
                  className={`pc-wire-temp${wireDraft.invalid ? " invalid" : ""}`}
                  d={wireDraft.d}
                  style={wireDraft.color ? { stroke: wireDraft.color } : undefined}
                />
              )}
            </g>
          </svg>

          {/* 节点分组框（Ctrl+G）：框自适应成员包围盒，渲染在节点层之下。
              memberFrame 读 nodeMetrics 实测缓存（手势层维护的 ref）——
              引擎既有惯例：测量值以 ref 承载、渲染期直读，React Compiler
              的 refs 规则不适用于该模式（工程画布同款），定点豁免。 */}
          {/* eslint-disable-next-line react-hooks/refs -- 引擎实测缓存渲染期直读，见上 */ }
          {groups.map((group) => {
            const frames = group.members
              .map((key) => memberFrame(key))
              .filter((f): f is { x: number; y: number; w: number; h: number } => f !== null);
            if (frames.length === 0) return null;
            const pad = 14;
            const left = Math.min(...frames.map((f) => f.x)) - pad;
            const top = Math.min(...frames.map((f) => f.y)) - pad - 18;
            const right = Math.max(...frames.map((f) => f.x + f.w)) + pad;
            const bottom = Math.max(...frames.map((f) => f.y + f.h)) + pad;
            return (
              <div
                key={group.id}
                data-group={group.id}
                className="pc-nodegroup"
                style={{ left, top, width: right - left, height: bottom - top }}
              >
                <div className="pc-nodegroup-label">{group.label}</div>
              </div>
            );
          })}

          {/* 保存节点自动保存管线运行时（SaveMediaBody 经 Context 取操作） */}
          <VideoToolRuntimeProvider runtime={videoToolRuntime}>
          <SaveRuntimeProvider>
          {nodes.map((node) => {
            const selected = selKeys.includes(node.id);
            const size = nodeSize(node);
            // meta 提前捕获为 const：闭包（onClick/onBlur）拿不到属性
            // 链的判窄，const 变量的判窄可以跨闭包保留。
            // ── 节点体：全部 22 种类型经注册表 def.Component 分发（新增
            // 节点 = 写一个 Body 模块 + def 登记，此处不再有类型分支）。──
            const Body = NODE_DEFS[node.type].Component;
            const body: ReactNode = (
              <Body
                node={node}
                selected={selected}
                pulsing={pulseKeys.includes(node.id)}
                autoHeight={node.height == null}
                scale={view.scale}
                services={canvasServices}
              />
            );

            return (
              <NodeShell
                key={node.id}
                def={NODE_DEFS[node.type]}
                node={node}
                selected={selected}
                pulsing={pulseKeys.includes(node.id)}
                size={size}
                onDelete={(id) => void deleteNodes(nodesRef, connectionsRef, [id])}
              >
                {body}
              </NodeShell>
            );
          })}
          </SaveRuntimeProvider>
          </VideoToolRuntimeProvider>
        </div>
        {/* 刀切痕层：视口直下的绝对定位层（pc-world 之后 → 盖在卡片上）。 */}
        <svg className="pc-trailayer" aria-hidden="true">
          <polyline ref={cutTrailUnderRef} className="pc-wire-cut-under" points="" />
          <polyline ref={cutTrailRef} className="pc-wire-cut" points="" />
        </svg>

        {/* 双击空白的节点选择框（ComfyUI 搜索框的对应物）：按生成/加载/
            输出三类分组。左上角锚在指针处；贴近视口下缘时按剩余空间限高，
            分组列表区内滚动——底部被裁掉又滚不到的项等于选不了。 */}
        {addMenu && (
          <WheelGate>
            <div
              // 菜单锚定读视口实测尺寸（vpRef）——引擎既有惯例：视口实测
              // 以 ref 承载、弹出时直读，定点豁免 react-hooks/refs。
              className="pc-addmenu"
              style={{
                // eslint-disable-next-line react-hooks/refs -- 视口实测渲染期直读，见上
                left: Math.max(8, Math.min(addMenu.sx, (vpRef.current?.clientWidth ?? 600) - 266)),
                top: addMenu.sy,
                // eslint-disable-next-line react-hooks/refs -- 同上
                maxHeight: Math.max(150, (vpRef.current?.clientHeight ?? 600) - addMenu.sy - 12),
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
            <input
              className="pc-addmenu-search"
              placeholder={t("project.canvas.addNodeSearch")}
              value={addMenuQuery}
              onChange={(event) => setAddMenuQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // 取消菜单＝不建节点直接退出：摘下的线就此断开。
                  if (addMenu.detached) discardDetachedWire(addMenu.detached);
                  closeAddMenu();
                }
              }}
              // 聚焦必须带 preventScroll：默认聚焦会滚动视口容器把输入框
              // 露出来，表现为整个画布节点集体平移。
              ref={(el) => {
                el?.focus({ preventScroll: true });
              }}
            />
            <div className="pc-addmenu-list">
            {menuGroups
              .map((group) => ({
                ...group,
                types: group.types.filter(
                  (type) =>
                    t(`canvas.node.${type}`).toLowerCase().includes(addMenuQuery.trim().toLowerCase()) &&
                    menuFilterType(type),
                ),
              }))
              .filter((group) => group.types.length > 0)
              .map((group) => (
                <div key={group.key} className="pc-addmenu-group">
                  <div className="pc-addmenu-group-title">{t(`canvas.menu.${group.key}`)}</div>
                  {group.types.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className="pc-addmenu-item"
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        event.preventDefault();
                        // 立即捕获指针：菜单按钮随 setAddMenu(null) 卸载，
                        // 卸载后浏览器释放捕获，pointerup 按 hit-test 落到
                        // 视口、照常冒泡给 window 的 onUp 收尾。
                        try {
                          event.currentTarget.setPointerCapture(event.pointerId);
                        } catch {
                          // 指针已不可捕获（合成事件等）：退化为无捕获。
                        }
                        dragRef.current = {
                          kind: "addnode", sx: event.clientX, sy: event.clientY, moved: false,
                          fox: addMenu.wx, foy: addMenu.wy, frameKey: type,
                          wire: addMenu.wire,
                          detached: addMenu.detached,
                        };
                        closeAddMenu();
                      }}
                    >
                      {menuIconOf(type)}
                      <span>{t(`canvas.node.${type}`)}</span>
                      <small>{t(`canvas.typeHint.${type}`)}</small>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            </div>
          </WheelGate>
        )}

        {/* 空画布示意：一键创建 文本→图像生成→预览 最小工作流 */}
        {!nodes.length && !connections.length && !addMenu && (
          <button className="fc-seed" onClick={() => void seedTemplate()}>
            <span className="fc-seed-title">{t("canvas.seedCta")}</span>
            <span className="fc-seed-sub">{t("canvas.seedHint")}</span>
          </button>
        )}

        {/* 拖放遮罩：OS 文件拖入提示 */}
        {dropHint && (
          <div className="fc-drop-overlay">
            <span>{t("canvas.dropHint")}</span>
          </div>
        )}

        {/* 批量生成浮动条：多选图像生成节点时出现（执行走 GenRuntime） */}
        <BatchBar selectedGenIds={selectedGenIds} />

        {/* 资源库选择浮层：加载节点与抽帧节点的「从资源库选择」入口 */}
        {pickerForNode && (
          <WheelGate>
            <LazyLibraryPicker
              // 引擎既有惯例：白名单 ref 在同一次事件里先于 state 更新，
              // 渲染期直读必是新值（见 pickFromLibrary），定点豁免。
              // eslint-disable-next-line react-hooks/refs -- 见上
              kinds={pickerKindsRef.current ?? undefined}
              onPick={(filePath) => {
                const targetId = pickerForNode;
                setPickerForNode(null);
                if (pickerApplyRef.current === "frame-video") {
                  const target = store.getState().nodes.find((n) => n.id === targetId);
                  if (target) void applyFrameVideo(targetId, target.type, filePath);
                  return;
                }
                void store.getState().updateNode(targetId, { resourcePath: filePath });
              }}
              onClose={() => setPickerForNode(null)}
            />
          </WheelGate>
        )}

        {/* 大图预览（预览图像节点双击） */}
        {lightboxUrl && (
          <WheelGate>
            <ImageLightbox src={lightboxUrl} alt="" onClose={() => setLightboxSrc("")} />
          </WheelGate>
        )}

        {/* 画布信息玻璃卡 + 统计 */}
        <div className="pc-glass fc-statcard">
          <div className="pc-ep-stats">
            <span>{t("canvas.statNodes", { count: nodes.length })}</span>
            <span>{t("project.canvas.statWires", { count: connections.length })}</span>
          </div>
        </div>

        <div className="pc-tip">{t("canvas.tip")}</div>

        {/* 缩放条（工程画布同款）：缩小 / 百分比 / 放大 */}
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

        {/* 迷你地图（工程画布同款）：节点包围盒 + 视口矩形，点击跳转 */}
        {miniBBox && (
          <NodeHint text={t("project.canvas.minimap")} className="is-minimap">
            <div className="pc-glass pc-minimap">
            <svg
              width={MINI_W}
              height={MINI_H}
              viewBox={`0 0 ${MINI_W} ${MINI_H}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                const wx = (e.clientX - rect.left) / miniRatio + miniBBox.x;
                const wy = (e.clientY - rect.top) / miniRatio + miniBBox.y;
                const vpRect = vpRef.current?.getBoundingClientRect();
                if (!vpRect) return;
                setView((prev) => {
                  const next = {
                    ...prev,
                    x: vpRect.width / 2 - wx * prev.scale,
                    y: vpRect.height / 2 - wy * prev.scale,
                  };
                  saveView(next);
                  return next;
                });
              }}
            >
              {nodes.map((node) => {
                const size = nodeSize(node);
                return (
                  <rect
                    key={node.id}
                    x={(node.pos_x - miniBBox.x) * miniRatio}
                    y={(node.pos_y - miniBBox.y) * miniRatio}
                    width={Math.max(3, size.w * miniRatio)}
                    height={Math.max(2.5, size.h * miniRatio)}
                    rx="1.5"
                    fill="var(--text-tertiary)"
                  />
                );
              })}
              <rect
                x={(((-view.x / view.scale) - miniBBox.x) * miniRatio)}
                y={(((-view.y / view.scale) - miniBBox.y) * miniRatio)}
                width={((vpSize?.w ?? 1200) / view.scale) * miniRatio}
                height={((vpSize?.h ?? 700) / view.scale) * miniRatio}
                fill="rgba(127,127,140,.1)"
                stroke="var(--text-primary)"
                strokeWidth="1.2"
                rx="2"
              />
            </svg>
          </div>
          </NodeHint>
        )}
      </div>
    </div>
    </GenRuntimeProvider>
  );
}

/** 弹层滚轮隔离：视口滚轮缩放挂在原生非被动监听上（React 合成事件的
 *  stopPropagation 拦不住它），弹层内的滚轮必须在原生层停掉冒泡——否则
 *  缩放监听的 preventDefault 会把弹层自身的默认滚动一并杀掉，表现为
 *  「列表滚不动、画布在缩放」。资源库弹窗 / 大图灯箱 / 节点选择框都用。 */
// ── 生成等待「流光」动效（2026-11-01 原型定稿移植） ─────────────

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
