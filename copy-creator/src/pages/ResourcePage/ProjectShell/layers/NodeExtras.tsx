import type { Dispatch, SetStateAction } from "react";
import type { EntityPhKind } from "../types";

// 工程画布详情/杂项共享类型（自旧 NodeExtras 层裁剪——组件体已被
// 工程节点 defs 的 bodies 取代，2026-11-05 阶段 E2 退役）。
type DetailScope = "current" | "all";
/** 详情窗口目标（Shell 新详情窗用 DetailTarget；此类型供旧弹窗装配参考）。 */
export type DetailForState =
  | { kind: "entityPh"; id: string }
  | { kind: "promptPh"; id: string }
  | { kind: "segment"; id: string; scopes: { chars: DetailScope; locs: DetailScope; props: DetailScope } }
  | { kind: "info"; group: EntityPhKind; sourceKey: string; scope: DetailScope }
  | { kind: "script"; phId?: string };
export type SetDetailFor = Dispatch<SetStateAction<DetailForState | null>>;
export type DetailForArg = DetailForState;
