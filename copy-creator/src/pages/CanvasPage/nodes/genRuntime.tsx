import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useCanvasStore, type CanvasNode } from "../../../stores/canvasStore";
import {
  GEN_WAIT_BLOOM_MS,
  GEN_WAIT_EXIT_MS,
  GEN_WAIT_FUSE_MS,
  GEN_WAIT_LAND_MS,
  GenRuntimeCtx,
  type GenWaitPhase,
  type GenWaitSnap,
} from "./genRuntimeCtx";
import { useNodeErrors } from "./nodeErrors";

// 生成运行时 Provider：发起生成（startGenerate）、批量队列（runBatch）与
// 生成等待编排（流光谢幕相位机）。挂画布整棵返回树外圈——节点体
// （GenImageBody）与批量浮动条（BatchBar）都经 useGenRuntime 取用。
// 等待编排：store 进度 → 本地快照（wait）→ 谢幕相位机，谢幕与 store
// 解耦（条目已被最终刷新裁掉）。

export function GenRuntimeProvider({
  canvasId,
  selectedGenIds,
  children,
}: {
  canvasId: string;
  /** 多选的图像生成节点 id（批量队列）；由 FreeCanvas 按选中集派生。 */
  selectedGenIds: string[];
  children: ReactNode;
}) {
  const genProgress = useCanvasStore((s) => s.genProgress);
  const nodes = useCanvasStore((s) => s.nodes);
  const store = useCanvasStore;
  const setNodeErrors = useNodeErrors((s) => s.setErrors);
  const [genStarting, setGenStarting] = useState(false);
  // 生成等待编排（流光谢幕相位机）：节点 id → 快照。wait 跟随逐张回传；
  // 到齐后 fuse/bloom/exit/land 谢幕与 store 解耦（条目已被最终刷新裁掉）。
  const [genWait, setGenWait] = useState<Record<string, GenWaitSnap>>({});
  const genWaitTimersRef = useRef(new Map<string, number>());

  // 镜像 + 到齐判定：进度条目出现即建快照（仅限节点仍在 generating，
  // 完成后的残留条目不进等待态）；wait 态持续镜像逐张回传；全部槽位
  // 落定即转入谢幕——全部成功走融合庆祝（fuse），有失败/取消走静默
  // 退场（exit）。条目先于事件被裁（切画布等）时按节点最终状态定调，
  // 满额成功仍补融合。genWait 入 deps：land 落格清掉快照后，同节点的
  // 新一轮生成条目能立刻重新入册。
  useEffect(() => {
    setGenWait((prev) => {
      const next = { ...prev };
      let changed = false;
      // 遍历 store 条目与既有快照的并集：条目随最终 canvas-changed 被裁掉
      // 后键会消失，只按条目遍历会让「条目已消失」的定调分支永远轮不到
      // （取消路径必现：received+errors 摸不到 total，快照卡死在 wait）。
      const ids = new Set([...Object.keys(genProgress), ...Object.keys(prev)]);
      for (const nodeId of ids) {
        const prog = genProgress[nodeId];
        const node = nodes.find((n) => n.id === nodeId);
        const meta = node?.metadata;
        const generating = meta?.kind === "gen_image" && meta.status === "generating";
        const snap = next[nodeId];
        if (!snap) {
          if (generating && prog) {
            next[nodeId] = {
              phase: "wait",
              celebrated: false,
              total: prog.total,
              received: prog.received,
              errors: prog.errors,
              requestId: prog.requestId,
              previews: prog.previews,
            };
            changed = true;
          }
          continue;
        }
        if (snap.phase !== "wait") continue;
        if (prog) {
          let cur = snap;
          if (
            prog.received !== snap.received ||
            prog.errors !== snap.errors ||
            prog.total !== snap.total ||
            prog.requestId !== snap.requestId ||
            prog.previews !== snap.previews
          ) {
            cur = {
              ...snap,
              total: prog.total,
              received: prog.received,
              errors: prog.errors,
              requestId: prog.requestId,
              previews: prog.previews,
            };
            next[nodeId] = cur;
            changed = true;
          }
          // 到齐即谢幕：received+errors 摸到 total（取消的槽位不回传，
          // 收不到齐信号，由下方条目消失分支兜底）。
          if (cur.received + cur.errors >= cur.total) {
            const full = cur.errors === 0;
            next[nodeId] = { ...cur, phase: full ? "fuse" : "exit", celebrated: full };
            changed = true;
          }
        } else if (meta?.kind === "gen_image" && meta.status !== "generating") {
          const full =
            meta.status === "done" && meta.images.length === snap.total && snap.errors === 0;
          next[nodeId] = { ...snap, phase: full ? "fuse" : "exit", celebrated: full };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [genProgress, nodes, genWait]);

  // 谢幕节拍：fuse →(950ms)→ bloom →(1200ms)→ exit →(300ms)→ land
  // →(520ms)→ 清快照。定时器按「节点:相位」键入册，effect 因其他节点
  // 变化重跑时已在册的不重排——节拍不漂移；卸载统一清空。
  useEffect(() => {
    const advance = (id: string, phase: GenWaitPhase) =>
      setGenWait((prev) => {
        const snap = prev[id];
        if (!snap || snap.phase === phase) return prev;
        return { ...prev, [id]: { ...snap, phase } };
      });
    const schedule = (key: string, id: string, delay: number, next: GenWaitPhase | null) => {
      if (genWaitTimersRef.current.has(key)) return;
      const timer = window.setTimeout(() => {
        genWaitTimersRef.current.delete(key);
        if (next) advance(id, next);
        else
          setGenWait((prev) => {
            if (!(id in prev)) return prev;
            const rest = { ...prev };
            delete rest[id];
            return rest;
          });
      }, delay);
      genWaitTimersRef.current.set(key, timer);
    };
    for (const [id, snap] of Object.entries(genWait)) {
      if (snap.phase === "fuse") schedule(`fuse:${id}`, id, GEN_WAIT_FUSE_MS, "bloom");
      else if (snap.phase === "bloom") schedule(`bloom:${id}`, id, GEN_WAIT_BLOOM_MS, "exit");
      else if (snap.phase === "exit") schedule(`exit:${id}`, id, GEN_WAIT_EXIT_MS, "land");
      else if (snap.phase === "land") schedule(`land:${id}`, id, GEN_WAIT_LAND_MS, null);
    }
  }, [genWait]);
  useEffect(
    () => () => {
      for (const timer of genWaitTimersRef.current.values()) window.clearTimeout(timer);
      genWaitTimersRef.current.clear();
    },
    [],
  );

  const startGenerate = useCallback(
    async (node: CanvasNode) => {
      setGenStarting(true);
      setNodeErrors((prev) => ({ ...prev, [node.id]: "" }));
      try {
        await store.getState().generateImage(canvasId, node.id);
      } catch (err) {
        setNodeErrors((prev) => ({ ...prev, [node.id]: String(err) }));
      } finally {
        setGenStarting(false);
      }
    },
    [canvasId, store, setNodeErrors],
  );

  // 批量生成：多选图像生成节点 → 队列顺序执行。
  const batchRunningRef = useRef(false);
  const runBatch = useCallback(async () => {
    if (batchRunningRef.current) return;
    batchRunningRef.current = true;
    try {
      for (const id of selectedGenIds) {
        const node = store.getState().nodes.find((n) => n.id === id);
        if (node) await startGenerate(node);
      }
    } finally {
      batchRunningRef.current = false;
    }
    // startGenerate 依赖 canvasId/store，经其闭包稳定；选中集变化由渲染期值传入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGenIds.join(",")]);

  const runtime = {
    genWait,
    genStarting,
    startGenerate,
    runBatch,
  };

  return <GenRuntimeCtx.Provider value={runtime}>{children}</GenRuntimeCtx.Provider>;
}
