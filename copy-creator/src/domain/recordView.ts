// 领域层：记录视图模型——记录进 UI 前的唯一组装点。
// 组装-only 契约（DOMAIN_ARCHITECTURE_PLAN.md §3.7）：
// 1. buildRecordView 只调用 domain 各模块导出的判定函数并做字段映射，
//    不得新增业务判定（守卫：architectureGuard 规则 6）；
// 2. RecordView 字段分两组——事实字段（透传，叶子可做渲染分支）与
//    判定字段（叶子只读不猜）；新增字段必须在 PR 说明消费方。
import type { ApiKeyLabel, ClipboardRecord } from "../types";
import {
  fileMediaKindFromPath,
  inferResourceMediaKind,
  type ResourceMediaKind,
} from "./mediaKind";
import {
  getResourcePath,
  getResourceTitle,
  isFileBackedTextResource,
  isResourceRecord,
  recordDisplayName,
  recordExpandPreview,
  recordPasteStrategy,
  type ExpandPreviewKind,
  type PasteStrategy,
} from "./records";

export type { ExpandPreviewKind, PasteStrategy };

export interface RecordView {
  // —— 事实字段（透传：展示与操作传参；禁止派生领域判定）——
  id: string;
  recordType: ClipboardRecord["type"]; // 原始类型（含 link——kind 将 link 折叠进 text，样式区分靠它）
  createdAt: string;
  content: string; // 原始载荷（文本正文/路径/图片相对路径）
  contentTruncated: boolean; // 后端截断标记
  hasImages: boolean; // 暂存图文记录的图片附件标记
  sourceApp: string; // 来源应用（资源卡来源行）
  useCount: number; // 使用次数（次数徽标）
  groupName: string; // 分组名（API Key 标签等场景）
  // —— 判定字段（domain 规则结果，叶子只读不猜）——
  kind: ResourceMediaKind; // 统一内容类型（text/image/video/audio/file；link 折叠为 text）
  fileMediaKind: "video" | "audio" | "image" | null; // file 记录的媒体细分
  isResource: boolean;
  isFileBackedText: boolean;
  expandable: boolean; // 能否展开/预览
  expandPreview: ExpandPreviewKind; // 展开后渲染什么
  pasteStrategy: PasteStrategy; // 粘贴路由描述（执行仍在 clipboardStore.pasteRecord）
  dragPath: string | null; // 拖出路径
  resourcePath: string | null; // 预览/播放用的本地路径
  displayName: string; // 条目显示文本（三窗口统一规则）
  displayTruncated: boolean; // displayName 是否被渲染参数截断（区别于 contentTruncated）
  title: string; // 标题（资源标题或文件名）
  // —— API Key 场景（isApiKey 为 true 时有值）——
  apiKey?: {
    preview: string;
    guessedService: string | null;
    label: ApiKeyLabel | null;
    userMarked: boolean; // 用户已标记（右键"取消标记"菜单的依据）
  };
}

export interface BuildRecordViewOptions {
  /** 显示文本的渲染截断长度（如径向菜单 300）；不传则不截断。 */
  displayNameTruncateAt?: number;
}

export function buildRecordView(
  record: ClipboardRecord,
  options: BuildRecordViewOptions = {},
): RecordView {
  const kind = inferResourceMediaKind(record);
  const fileMediaKind = record.type === "file" ? fileMediaKindFromPath(record.content) : null;
  const expandPreview = recordExpandPreview(record);
  let displayName = recordDisplayName(record, "图片");
  let displayTruncated = false;
  if (options.displayNameTruncateAt !== undefined && displayName.length > options.displayNameTruncateAt) {
    displayName = `${displayName.slice(0, options.displayNameTruncateAt)}…`;
    displayTruncated = true;
  }

  return {
    id: record.id,
    recordType: record.type,
    createdAt: record.created_at,
    content: record.content,
    contentTruncated: Boolean(record.content_truncated),
    hasImages: Boolean(record.has_images),
    sourceApp: record.source_app ?? "",
    useCount: record.use_count ?? 0,
    groupName: record.group_name ?? "",

    kind,
    fileMediaKind,
    isResource: isResourceRecord(record),
    isFileBackedText: isFileBackedTextResource(record),
    expandable: expandPreview !== null,
    expandPreview,
    pasteStrategy: recordPasteStrategy(record),
    dragPath: record.drag_path ?? null,
    resourcePath: getResourcePath(record),
    displayName,
    displayTruncated,
    title: getResourceTitle(record),

    apiKey: record.is_api_key
      ? {
          preview: record.key_preview ?? "",
          guessedService: record.guessed_service ?? null,
          label: record.label ?? null,
          userMarked: Boolean(record.user_api_key),
        }
      : undefined,
  };
}
