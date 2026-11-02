import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore, type CanvasNode } from "../../../stores/canvasStore";
import { isVideoToolType } from "./registry";
import { useNodeErrors } from "./nodeErrors";
import { type TimelineData, type VideoToolDraft, type VideoToolRuntime } from "./videoToolRuntimeCtx";

// 视频工具运行时：时间轴预取（canvas_video_timeline，失败记账防反复探测）、
// 拖动会话态、监视器元素注册、seek/range 手势落点、三个工具命令与首尾帧
// 提取、清片。controller hook 由 FreeCanvas 调用持有（applyFrameVideo 亦
// 需清会话态），Provider 仅把 runtime 下发给节点模块。

export function useVideoToolRuntimeController(): VideoToolRuntime {
  const nodes = useCanvasStore((s) => s.nodes);
  const store = useCanvasStore;
  const setNodeErrors = useNodeErrors((s) => s.setErrors);

  /** 时间轴缓存（按视频路径）：canvas_video_timeline 后端自带产物级缓存，
   *  这里只挡重复 invoke。w/h 是帧宽高（后端 IHDR 实测，读不出为 0），
   *  轨道按它铺格还原画面。轨道失败（非视频/无 ffmpeg）在节点上红字报因。 */
  const [videoTimelines, setVideoTimelines] = useState<Record<string, TimelineData>>({});
  const timelineInflight = useRef<Set<string>>(new Set());

  /** 拖动会话态（key=节点 id）：t=播放头，start/dur=选区；拖动中只影响
   *  显示与预览 seek，松手（onCommit）才落 metadata。draftRef 镜像供
   *  commit 读最新值（提交后镜像，渲染期不写 ref）。 */
  const [videoToolDraft, setVideoToolDraft] = useState<VideoToolDraft>({});
  const videoToolDraftRef = useRef(videoToolDraft);
  useEffect(() => {
    videoToolDraftRef.current = videoToolDraft;
  }, [videoToolDraft]);

  /** 视频预览元素（nodeId → element）：拖播放头/选区时程序 seek 同步画面
   *  （经 MediaPlayback 的 mediaRefCallback 转交；元素宽型与共享组件签名
   *  对齐，调用侧只用 HTMLMediaElement 的 currentTime）。 */
  const videoElsRef = useRef<Record<string, HTMLVideoElement | HTMLAudioElement | null>>({});

  /** 已失败的轨道路径：effect 以 nodes 为依赖，任何节点变动都会重跑——
   *  失败不记账就会对同一坏视频反复 invoke（拖动画布每帧一次 ffmpeg
   *  探测）。重新选片时由 applyFrameVideo 清账允许重试。 */
  const timelineFailedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const node of nodes) {
      if (!isVideoToolType(node.type)) continue;
      const meta = node.metadata as { video_path?: string };
      const vp = meta?.video_path ?? "";
      if (vp && !videoTimelines[vp] && !timelineInflight.current.has(vp) && !timelineFailedRef.current.has(vp)) {
        timelineInflight.current.add(vp);
        invoke<TimelineData>("canvas_video_timeline", { path: vp })
          .then((res) => setVideoTimelines((prev) => ({ ...prev, [vp]: res })))
          .catch((err) => {
            timelineFailedRef.current.add(vp);
            setNodeErrors((prev) => ({ ...prev, [node.id]: String(err) }));
          })
          .finally(() => {
            timelineInflight.current.delete(vp);
          });
      }
    }
  }, [nodes, videoTimelines, setNodeErrors]);

  const seekToolTo = useCallback((nodeId: string, t: number) => {
    setVideoToolDraft((prev) => ({ ...prev, [nodeId]: { ...(prev[nodeId] ?? {}), t } }));
    const el = videoElsRef.current[nodeId];
    if (el) {
      try {
        el.currentTime = t;
      } catch {
        // 元数据未就绪时忽略：video 元素会延迟生效或自然失败。
      }
    }
  }, []);

  const rangeToolTo = useCallback((nodeId: string, start: number, dur: number, seekPreview: boolean) => {
    setVideoToolDraft((prev) => ({ ...prev, [nodeId]: { ...(prev[nodeId] ?? {}), start, dur } }));
    if (seekPreview) {
      const el = videoElsRef.current[nodeId];
      // 暂停中才把画面拨到选区起点（拖动实时跟手）；播放中不打断——
      // 越出选区的部分由 onTimeUpdate 的循环钳制拉回选区内。
      if (el && el.paused) {
        try {
          el.currentTime = start;
        } catch {
          // 元数据未就绪时忽略。
        }
      }
    }
  }, []);

  const commitVideoTool = useCallback((nodeId: string) => {
    const d = videoToolDraftRef.current[nodeId];
    if (!d) return;
    const node = store.getState().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const meta = node.metadata;
    if (meta.kind !== "video_seek_frame" && meta.kind !== "video_to_gif" && meta.kind !== "video_extract_audio") return;
    const patch: Record<string, unknown> = {};
    if (d.t !== undefined) patch.start_secs = d.t;
    if (d.start !== undefined) patch.start_secs = d.start;
    if (d.dur !== undefined) patch.duration_secs = d.dur;
    void store.getState().updateNode(nodeId, { metadata: JSON.stringify({ ...meta, ...patch }) });
  }, [store]);

  const [frameBusy, setFrameBusy] = useState<Record<string, boolean>>({});

  const runVideoTool = useCallback(
    async (node: CanvasNode) => {
      const kind = node.metadata.kind;
      if (kind !== "video_seek_frame" && kind !== "video_to_gif" && kind !== "video_extract_audio") return;
      const videoPath = node.metadata.video_path;
      if (!videoPath) return;
      // 抽帧的播放头除了轨道拖动（松手即落 metadata）还会被原生进度条
      // 拖动改写（只进 draft）——执行前把 draft 冲进 metadata，保证「所见
      // 时间 = 所抽帧」；选区两参数只走轨道手势，本就落库。
      const draft = videoToolDraftRef.current[node.id];
      let meta = node.metadata;
      if (kind === "video_seek_frame" && draft?.t !== undefined && draft.t !== meta.start_secs) {
        meta = { ...meta, start_secs: draft.t };
        await store.getState().updateNode(node.id, { metadata: JSON.stringify(meta) });
      }
      setFrameBusy((prev) => ({ ...prev, [node.id]: true }));
      try {
        let res: { path: string };
        if (kind === "video_seek_frame") {
          res = await invoke<{ path: string }>("canvas_seek_video_frame", {
            path: videoPath,
            secs: meta.start_secs,
          });
        } else if (kind === "video_to_gif") {
          res = await invoke<{ path: string }>("canvas_convert_video_gif", {
            path: videoPath,
            start: meta.start_secs,
            duration: meta.duration_secs > 0 ? meta.duration_secs : 3.0,
          });
        } else {
          res = await invoke<{ path: string }>("canvas_extract_audio", {
            path: videoPath,
            start: meta.start_secs,
            duration: meta.duration_secs,
            format: meta.format || "mp3",
          });
        }
        await store.getState().updateNode(node.id, { resourcePath: res.path });
        setNodeErrors((prev) => {
          if (!prev[node.id]) return prev;
          const next = { ...prev };
          delete next[node.id];
          return next;
        });
      } catch (err) {
        setNodeErrors((prev) => ({ ...prev, [node.id]: String(err) }));
      } finally {
        setFrameBusy((prev) => ({ ...prev, [node.id]: false }));
      }
    },
    [store, setNodeErrors],
  );

  const runFrameExtract = useCallback(
    async (node: CanvasNode) => {
      if (node.metadata.kind !== "video_first_frame" && node.metadata.kind !== "video_last_frame") return;
      const videoPath = node.metadata.video_path;
      if (!videoPath) return;
      setFrameBusy((prev) => ({ ...prev, [node.id]: true }));
      try {
        const res = await invoke<{ path: string }>("canvas_extract_video_frame", {
          path: videoPath,
          which: node.type === "video_last_frame" ? "last" : "first",
        });
        await store.getState().updateNode(node.id, { resourcePath: res.path });
        setNodeErrors((prev) => {
          if (!prev[node.id]) return prev;
          const next = { ...prev };
          delete next[node.id];
          return next;
        });
      } catch (err) {
        setNodeErrors((prev) => ({ ...prev, [node.id]: String(err) }));
      } finally {
        setFrameBusy((prev) => ({ ...prev, [node.id]: false }));
      }
    },
    [store, setNodeErrors],
  );

  const clearFrameVideo = useCallback(
    (node: CanvasNode) => {
      if (!isVideoToolType(node.type)) return;
      setVideoToolDraft((prev) => {
        if (!prev[node.id]) return prev;
        const next = { ...prev };
        delete next[node.id];
        return next;
      });
      // 音轨节点的格式选择与视频无关，清片换片时保留（applyFrameVideo 读
      // prevMeta.format 回写）；卸载的监视器元素引用一并清掉。
      const keepFormat =
        node.metadata.kind === "video_extract_audio" && node.metadata.format
          ? { format: node.metadata.format }
          : {};
      delete videoElsRef.current[node.id];
      void store.getState().updateNode(node.id, {
        resourcePath: "",
        metadata: JSON.stringify({ kind: node.type, video_path: "", ...keepFormat }),
      });
    },
    [store],
  );

  const resetToolSession = useCallback((nodeId: string, videoPath: string) => {
    timelineFailedRef.current.delete(videoPath);
    setVideoToolDraft((p) => {
      if (!p[nodeId]) return p;
      const next = { ...p };
      delete next[nodeId];
      return next;
    });
  }, []);

  const registerVideoEl = useCallback(
    (nodeId: string, el: HTMLVideoElement | HTMLAudioElement | null) => {
      videoElsRef.current[nodeId] = el;
    },
    [],
  );

  const getVideoEl = useCallback(
    (nodeId: string): HTMLVideoElement | HTMLAudioElement | null => videoElsRef.current[nodeId] ?? null,
    [],
  );

  return {
    videoTimelines,
    videoToolDraft,
    setVideoToolDraft,
    registerVideoEl,
    getVideoEl,
    frameBusy,
    seekToolTo,
    rangeToolTo,
    commitVideoTool,
    runVideoTool,
    runFrameExtract,
    clearFrameVideo,
    resetToolSession,
  };
}
