// 工程画布默认工作流骨架（自 ProjectCanvas.tsx 组件体零改动搬移，
// 2026-11-03 引擎拆分阶段 11d）：首次进入无工作流数据的集自动铺两个
// 片段 + 各 5 个空白占位节点 + 暂存连线；标记落 localStorage 防重建。
import { useEffect } from "react";
import { useProjectStore, type EpisodeOverview } from "../../../../stores/projectStore";
import { INFO_H, INFO_W, SCRIPT_W, SEG_W, WORLD_MARGIN } from "../layout";
import type { CanvasLayout, EntityPh, PendingLink, Pos, PromptPh, ScriptPh } from "../types";

export function useWorkflowSeed(deps: {
  episodeId: string;
  overview: EpisodeOverview | null;
  addSegment(episodeId: string): Promise<{ id: string } | null>;
  layout: Omit<CanvasLayout, "infoFramePos">;
  persistEntityPhs(next: EntityPh[]): void;
  persistPromptPhs(next: PromptPh[]): void;
  persistScriptPhs(next: ScriptPh[]): void;
  persistInfoOffsets(next: Record<string, Pos>): void;
  persistPendingLinks(next: PendingLink[]): void;
}) {
  const {
    episodeId, overview, addSegment, layout, persistEntityPhs,
    persistPromptPhs, persistScriptPhs, persistInfoOffsets, persistPendingLinks,
  } = deps;

  // ── 默认工作流模板：首次进入某集画布且集内尚无任何工作流数据时，
  // 自动铺一套连线完整的骨架——两个空片段，每个片段各配 5 个空白占位
  // 节点（角色/场景/道具/提示词/剧本）并连好对应输入口，「其他」口留空；
  // 片段→成片是隐式聚合线。占位节点双击填充具体内容，用户在其上自由
  // 增删连线。标记落 localStorage，此后即使删光片段也不再重建。 ──
  const templateFlagKey = `project_canvas_templated_${episodeId}`;
  useEffect(() => {
    if (!episodeId || !overview) return;
    let templated: boolean;
    try {
      templated = window.localStorage.getItem(templateFlagKey) === "1";
    } catch {
      templated = false;
    }
    if (templated) return;
    try {
      window.localStorage.setItem(templateFlagKey, "1");
    } catch {
      // 存储不可用：仅不记忆（下次进入可能重铺一次，无碍）。
    }
    if (overview.segments.length > 0 || overview.node_links.length > 0 || overview.episode.output_asset_id) {
      return; // 已有工作流数据的老集：保持原样。
    }
    void (async () => {
      const created: string[] = [];
      for (let i = 0; i < 2; i++) {
        const segment = await addSegment(episodeId);
        if (segment) created.push(segment.id);
      }
      if (created.length === 0) return;
      // 切集竞争守卫：上面两次 await addSegment 期间用户可能已切到别的
      // 集——迟到的续延若照常写状态，会与切集装载互相踩踏（实测他集的
      // 剧本纸片位置写进本集 infonodes 键的污染来源）。非当前集直接放弃
      // 本次播种并回滚模板标记，下次进入本集时重新铺。
      if (useProjectStore.getState().currentEpisodeId !== episodeId) {
        try {
          window.localStorage.removeItem(templateFlagKey);
        } catch {
          // 存储不可用：仅可能多铺一次，无碍。
        }
        return;
      }
      // 绕开加载时序竞争：切集首帧的 state 可能还是上一集的旧值（按集
      // 加载 effect 与本 effect 同批提交），直接读存储里本集的当前列表，
      // 模板内容拼在其后一次性落盘（同 tick 多次追加会互相覆盖）。
      const readStored = <T,>(name: string): T | null => {
        try {
          const raw = window.localStorage.getItem(`project_canvas_${name}_${episodeId}`);
          return raw == null ? null : (JSON.parse(raw) as T);
        } catch {
          return null;
        }
      };
      const listOf = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as T[]) : []);
      const offsetsRaw = readStored<Record<string, Pos>>("infonodes");
      const newEphs: EntityPh[] = [];
      const newPrompts: PromptPh[] = [];
      const newScripts: ScriptPh[] = [];
      const scriptOffsets: Record<string, Pos> = {};
      const pendings: PendingLink[] = [];
      // 片段默认列位与 segPos effect 同基准（成片节点默认挂 worldW+80）。
      const segX = layout.worldW + 80 - SEG_W - 160;
      created.forEach((segId, i) => {
        // 片段起点 = WORLD_MARGIN + INFO_H：上排占位顶（segY - INFO_H）正好
        // 落在世界边距上，不越过世界顶被自适应视图裁掉。间距公式以同一起
        // 点为基准（此前 110 + i * 520 的 110 被 max 下限吃掉，实际组间距
        // 只剩 390，上一组的下排与下一组的上排叠压）。
        const segY = WORLD_MARGIN + INFO_H + i * 520;
        // 两排阵型（对齐设计稿）：上排三个占位横排（左→右 道具/场景/
        // 角色），底边贴片段顶；下排剧本+提示词在片段左下（提示词在剧
        // 本右侧、略高半格）。全部相对片段锚定，片段纵向间距 520 拉开，
        // 相邻两组的占位互不相交。
        const topY = segY - INFO_H;
        const roleX = segX - 212 - INFO_W;
        const sceneX = roleX - 40 - INFO_W;
        const propX = sceneX - 40 - INFO_W;
        const bottomY = segY + 88;
        const scriptX = propX;
        const promptX = scriptX + SCRIPT_W + 48;
        const charId = `eph${Date.now()}${Math.floor(Math.random() * 1e4)}a${i}`;
        const locId = `eph${Date.now()}${Math.floor(Math.random() * 1e4)}b${i}`;
        const propId = `eph${Date.now()}${Math.floor(Math.random() * 1e4)}c${i}`;
        const promptId = `pph${Date.now()}${Math.floor(Math.random() * 1e4)}${i}`;
        const scriptId = `sph${Date.now()}${Math.floor(Math.random() * 1e4)}${i}`;
        newEphs.push({ id: charId, kind: "character", x: roleX, y: topY });
        newEphs.push({ id: locId, kind: "location", x: sceneX, y: topY });
        newEphs.push({ id: propId, kind: "prop", x: propX, y: topY });
        newPrompts.push({ id: promptId, promptId: "", x: promptX, y: bottomY - 24 });
        newScripts.push({ id: scriptId, path: "" });
        scriptOffsets[`script:${scriptId}`] = { x: scriptX, y: bottomY };
        pendings.push(
          { fromKey: `eph:${charId}`, toSegmentId: segId, toPort: "character" },
          { fromKey: `eph:${locId}`, toSegmentId: segId, toPort: "location" },
          { fromKey: `eph:${propId}`, toSegmentId: segId, toPort: "prop" },
          { fromKey: `prompt:${promptId}`, toSegmentId: segId, toPort: "prompt" },
          { fromKey: `script:${scriptId}`, toSegmentId: segId, toPort: "script" },
        );
      });
      persistEntityPhs([...listOf<EntityPh>(readStored<EntityPh[]>("entityph")), ...newEphs]);
      persistPromptPhs([...listOf<PromptPh>(readStored<PromptPh[]>("promptphs")), ...newPrompts]);
      persistScriptPhs([...listOf<ScriptPh>(readStored<ScriptPh[]>("scriptphs")), ...newScripts]);
      persistInfoOffsets({ ...(offsetsRaw && typeof offsetsRaw === "object" && !Array.isArray(offsetsRaw) ? offsetsRaw : {}), ...scriptOffsets });
      persistPendingLinks([...listOf<PendingLink>(readStored<PendingLink[]>("pendinglinks")), ...pendings]);
    })();
  }, [episodeId, overview, addSegment, layout.worldW, persistEntityPhs, persistPromptPhs, persistScriptPhs, persistInfoOffsets, persistPendingLinks, templateFlagKey]);
}
