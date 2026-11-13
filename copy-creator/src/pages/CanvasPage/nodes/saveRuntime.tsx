import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore, type SaveMediaMeta } from "../../../stores/canvasStore";
import { SaveRuntimeCtx, type SaveRuntime } from "./saveRuntimeCtx";
import { saveBaseNameOf, savedFingerprintAfter, saveDirFileNameOf, saveFingerprintOf } from "./saveTarget";
import { upstreamMediaOf } from "./upstream";

// 自动保存管线运行时 Provider（决策 19：连线后的下一步是选保存位置，
// 产物一出现即自动落盘）。挂画布节点层外圈，SaveMediaBody 经
// useSaveRuntime（saveRuntimeCtx）取用户操作；触发 effect 在此
// 自驱动（依赖 store 订阅）。目标详情（库内分组 auto_group + 基名
// auto_name）纳入指纹：详情变更即对现有产物自动重存一份，旧文件保留
// （2026-11-10 用户定案：分组/基名可配 + 冲突加 (1) 不覆盖）。
//
// 命名一次性（2026-11-14 用户定案：名字属于上一批产物，下一批不继承）
// ——保存成功即清 auto_name；指纹同步按空名重算落库（savedFingerprint-
// After），否则管线下一拍因指纹不符把现有产物冗余重存一份。分组路径
// 保留记忆（下次保存沿用上次分组，可再改）。

export function SaveRuntimeProvider({ children }: { children: ReactNode }) {
  const nodes = useCanvasStore((s) => s.nodes);
  const connections = useCanvasStore((s) => s.connections);
  const store = useCanvasStore;

  /** 按节点 id 读最新 metadata 合并写回（自动保存各步都基于 store 最新
   *  值，避免拖动等并发更新被旧闭包覆盖）。 */
  const writeSaveMeta = useCallback(
    (nodeId: string, patch: Partial<SaveMediaMeta>) => {
      const node = store.getState().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const meta = node.metadata;
      if (meta.kind !== "save_image" && meta.kind !== "save_video" && meta.kind !== "save_audio") return;
      void store.getState().updateNode(nodeId, { metadata: JSON.stringify({ ...meta, ...patch }) });
    },
    [store],
  );

  const setSaveAutoTarget = useCallback(
    (nodeId: string, target: "library" | "dir", dir: string) => {
      writeSaveMeta(nodeId, {
        auto_target: target,
        auto_dir: dir,
        auto_group: "",
        auto_name: "",
        auto_state: "",
        auto_error: "",
        auto_fingerprint: "",
      });
    },
    [writeSaveMeta],
  );

  const setSaveTargetDetails = useCallback(
    (nodeId: string, group: string, name: string) => {
      writeSaveMeta(nodeId, {
        auto_group: group,
        auto_name: name,
        auto_state: "",
        auto_error: "",
        auto_fingerprint: "",
      });
    },
    [writeSaveMeta],
  );

  const clearSaveAutoTarget = useCallback(
    (nodeId: string) => {
      writeSaveMeta(nodeId, {
        auto_target: "",
        auto_dir: "",
        auto_group: "",
        auto_name: "",
        auto_state: "",
        auto_error: "",
        auto_fingerprint: "",
      });
    },
    [writeSaveMeta],
  );

  const pickSaveAutoDir = useCallback(
    async (nodeId: string) => {
      try {
        const dir = await invoke<string>("canvas_pick_save_dir");
        if (!dir) return; // 用户取消
        setSaveAutoTarget(nodeId, "dir", dir.replace(/[\\/]+$/, ""));
      } catch {
        // 目录选择取消/失败：保持未设置态
      }
    },
    [setSaveAutoTarget],
  );

  /** 自动保存在飞锁：节点 id 级，跨 StrictMode 双跑与快速重渲染同拍生效。 */
  const autoSaveInFlightRef = useRef<Set<string>>(new Set());

  const runAutoSave = useCallback(
    async (nodeId: string, target: "library" | "dir", dir: string, paths: string[], group: string, name: string) => {
      // 在飞锁（ref 级，同拍即生效）：StrictMode 下 effect 双跑共用同一
      // 快照，auto_state 检查拦不住同一拍的重入，这里保证单节点不并发
      // 导出（开发模式防双份入库，生产同样受益）。
      if (autoSaveInFlightRef.current.has(nodeId)) return;
      autoSaveInFlightRef.current.add(nodeId);
      writeSaveMeta(nodeId, { auto_state: "saving", auto_error: "" });
      try {
        const base = dir.replace(/[\\/]+$/, "");
        for (const [index, path] of paths.entries()) {
          if (target === "library") {
            await invoke("canvas_save_to_library", {
              sourcePath: path,
              groupPath: group,
              baseName: saveBaseNameOf(name, paths.length, index),
            });
          } else {
            const fileName = saveDirFileNameOf(path, name, paths.length, index);
            await invoke("canvas_export_to_path", { sourcePath: path, target: `${base}/${fileName}` });
          }
        }
        // 成功即清命名（命名一次性，不带入下一批）+ 指纹按空名对齐：
        // 下一拍 paths 不变时指纹匹配不再重存；用户再设新名走详情变更
        // 语义照常触发重存。
        writeSaveMeta(nodeId, {
          auto_state: "saved",
          auto_error: "",
          auto_fingerprint: savedFingerprintAfter(paths, group),
          auto_name: "",
          status: "saved",
          target: target === "library" ? "library" : "path",
          saved_path: target === "dir" ? base : "",
        });
      } catch (err) {
        // 失败不落指纹：徽章转红示错，点徽章重试（避免持续失败时自动重试风暴）
        writeSaveMeta(nodeId, { auto_state: "error", auto_error: String(err) });
      } finally {
        autoSaveInFlightRef.current.delete(nodeId);
      }
    },
    [writeSaveMeta],
  );

  /** 自动保存管线：目标已设的保存节点，上游产物 + 目标详情指纹变化即
   *  自动导出。error 态停自动重试（等用户点徽章），saving 态防并发。 */
  useEffect(() => {
    for (const node of nodes) {
      const meta = node.metadata;
      if (meta.kind !== "save_image" && meta.kind !== "save_video" && meta.kind !== "save_audio") continue;
      const target = meta.auto_target ?? "";
      if (!target || target === "error") continue;
      if (meta.auto_state === "saving" || meta.auto_state === "error") continue;
      const paths = upstreamMediaOf(nodes, connections, node.id)?.paths ?? [];
      if (!paths.length) continue;
      const group = meta.auto_group ?? "";
      const name = meta.auto_name ?? "";
      const fingerprint = saveFingerprintOf(paths, group, name);
      if (meta.auto_fingerprint === fingerprint) continue;
      void runAutoSave(node.id, target === "dir" ? "dir" : "library", meta.auto_dir ?? "", paths, group, name);
    }
  }, [nodes, connections, runAutoSave]);

  const runtime: SaveRuntime = {
    setSaveAutoTarget,
    setSaveTargetDetails,
    clearSaveAutoTarget,
    pickSaveAutoDir,
    retrySaveAuto: (nodeId) => writeSaveMeta(nodeId, { auto_state: "", auto_error: "" }),
  };

  return <SaveRuntimeCtx.Provider value={runtime}>{children}</SaveRuntimeCtx.Provider>;
}
