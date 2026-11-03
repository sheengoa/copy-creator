// 工程画布对话框区共享类型（与 ProjectCanvas.tsx 组件体内联定义同构，
// 2026-11-03 引擎拆分阶段 11c）。
import type { EntityPhKind } from "../types";

export type SceneFormT = { id?: string; heading: string; locationId: string };
export type ShotFormT = { id: string; sceneId: string; description: string; dialogue: string };
export type ProjectPromptT = { id: string; title: string; content: string; category?: string };
export type MemberPickT =
  | { mode: "eph"; ephId: string; kind: EntityPhKind; pending: string[] }
  | { mode: "grp"; groupId: string; kind: EntityPhKind; pending: string[] }
  | { mode: "convert"; sourceKey: string; kind: EntityPhKind; pending: string[] };
