// 工程域展示规则：集状态呈现、文件名展示与角色头像兜底的唯一来源。
// 组件不得自行散落这些判定（与 domain/records.ts 同一约束精神）。
import type { ProjectEpisodeStatus } from "../stores/projectStore";

export const EPISODE_STATUSES: readonly ProjectEpisodeStatus[] = [
  "none",
  "script",
  "storyboard",
  "generating",
  "done",
] as const;

export function episodeStatusKey(status: string): string {
  return `project.status.${EPISODE_STATUSES.includes(status as ProjectEpisodeStatus) ? status : "none"}`;
}

/** 集在树里的短标签（完成后不显示状态词，用勾选图标表达）。 */
export function episodeHasDoneMark(status: string): boolean {
  return status === "done";
}

/** 集号展示：01 / 02 …，与剧本文件名前缀约定一致。 */
export function episodeNumberLabel(number: number): string {
  return String(number).padStart(2, "0");
}

/** 素材/剧本的显示名：显式 name 优先，回退路径末段文件名。 */
export function projectFileDisplayName(name: string, filePath: string): string {
  const explicit = name.trim();
  if (explicit) return explicit;
  const segments = filePath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/** 剧本文件名（无剧本时为空）。 */
export function scriptFileLabel(scriptPath: string): string {
  if (!scriptPath.trim()) return "";
  return projectFileDisplayName("", scriptPath);
}

/** 角色头像无图时的兜底字：取名字的首个字符（限 1 字，中英通用）。 */
export function characterAvatarInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? Array.from(trimmed)[0] : "?";
}

/** 角色行副文案：身份标签 + 出场说明，缺失部分自动省略。 */
export function characterSubtitle(roleTag: string, episodeNote: string): string {
  const parts = [roleTag.trim(), episodeNote.trim()].filter(Boolean);
  return parts.join(" · ");
}

/** 角色头像稳定配色：按名字散列到固定索引，避免同屏乱序变色。 */
const AVATAR_PALETTE = 5;

export function characterAvatarPaletteIndex(name: string): number {
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  }
  return hash % AVATAR_PALETTE;
}

/** 工程文件引用（相对库根、正斜杠）→ 绝对路径：供媒体 URL 出口与
 *  打开/定位命令使用。库根由调用方传入（资源库可自定义位置）。 */
export function joinLibraryPath(libraryRoot: string, relativePath: string): string {
  const root = libraryRoot.trim().replace(/[\\/]+$/, "");
  const rel = relativePath.trim().replace(/^[\\/]+/, "");
  if (!root) return rel;
  if (!rel) return root;
  return `${root}/${rel}`;
}

/** 素材类型 → i18n 键（图片/视频/音频/文本/提示词/文件）。 */
export function assetKindLabelKey(kind: string): string {
  const known = ["image", "video", "audio", "text", "prompt", "file"];
  return `project.asset.kind.${known.includes(kind) ? kind : "file"}`;
}

/** 场景内外景惯例值（Fountain 行业标准 INT/EXT 的本地化表达）。 */
export const LIBRARY_INT_EXTS = ["int", "ext", "both"] as const;
export type LibraryIntExt = (typeof LIBRARY_INT_EXTS)[number];

export function intExtLabelKey(value: string): string {
  return `project.library.intExt.${(LIBRARY_INT_EXTS as readonly string[]).includes(value) ? value : "unset"}`;
}

/** 场景默认时间氛围。 */
export const LIBRARY_TIME_HINTS = ["day", "night", "dusk"] as const;
export type LibraryTimeHint = (typeof LIBRARY_TIME_HINTS)[number];

export function timeHintLabelKey(value: string): string {
  return `project.library.timeHint.${(LIBRARY_TIME_HINTS as readonly string[]).includes(value) ? value : "unset"}`;
}

/** 场景卡副文案：内外景 + 时间，缺失部分省略，全缺失显示占位键。 */
export function locationSubtitleParts(intExt: string, timeHint: string): string[] {
  const parts: string[] = [];
  if ((LIBRARY_INT_EXTS as readonly string[]).includes(intExt)) parts.push(intExt);
  if ((LIBRARY_TIME_HINTS as readonly string[]).includes(timeHint)) parts.push(timeHint);
  return parts;
}

/** 三库面板的实体种类键（标题/新建文案复用 project.library.* 前缀）。 */
export const LIBRARY_KINDS = ["characters", "locations", "props"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export function isLibraryKind(value: string): value is LibraryKind {
  return (LIBRARY_KINDS as readonly string[]).includes(value);
}

export type { ProjectEpisodeStatus };
