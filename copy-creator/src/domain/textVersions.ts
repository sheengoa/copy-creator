// 领域层：资源文本改动记录——类型、查询/预览/还原/清空出口与来源展示映射。
// 数据模型见后端 resource_text_versions 表（保存后快照：版本链顶端恒等于
// 文件当前内容，还原走正文写入通道并自动记「还原」版，永远可逆）。
import { invoke } from "@tauri-apps/api/core";

export type TextVersionSource = "init" | "edit" | "external" | "restore";

export interface ResourceTextVersion {
  id: string;
  recordId: string;
  /** 版本字节大小（正文按需经 fetchTextVersionContent 单独拉取）。 */
  byteSize: number;
  source: TextVersionSource;
  createdAt: string;
}

interface RawTextVersion {
  id: string;
  record_id: string;
  byte_size: number;
  source: string;
  created_at: string;
}

function fromRaw(raw: RawTextVersion): ResourceTextVersion {
  return {
    id: raw.id,
    recordId: raw.record_id,
    byteSize: raw.byte_size,
    source: raw.source as TextVersionSource,
    createdAt: raw.created_at,
  };
}

/** 列出改动记录（最新在前）。path 传记录当前文件路径：后端读取时懒对齐——
 * 版本链为空补记「首次入库」，文件内容与顶端版本漂移（外部修改）补记一版。 */
export function fetchResourceTextVersions(
  recordId: string,
  path: string,
): Promise<ResourceTextVersion[]> {
  return invoke<RawTextVersion[]>("list_resource_text_versions", { recordId, path }).then(
    (list) => list.map(fromRaw),
  );
}

/** 读取单个版本的正文快照（只读预览用）。 */
export function fetchTextVersionContent(versionId: string): Promise<string> {
  return invoke<string>("get_resource_text_version_content", { versionId });
}

/** 还原：版本快照原样写回记录当前指向的文件；还原动作本身自动记一版。 */
export function restoreResourceTextVersion(
  versionId: string,
): Promise<{ content: string; recordType?: string }> {
  return invoke("restore_resource_text_version", { versionId });
}

/** 清空该资源的全部改动记录（不影响文件当前内容）。 */
export function clearResourceTextVersions(recordId: string): Promise<number> {
  return invoke<number>("clear_resource_text_versions", { recordId });
}

/** 版本来源 → i18n 文案 key（纯映射，展示标签由调用方 t() 解析）。 */
export function textVersionSourceKey(source: TextVersionSource): string {
  switch (source) {
    case "init":
      return "resources.verSourceInit";
    case "external":
      return "resources.verSourceExternal";
    case "restore":
      return "resources.verSourceRestore";
    default:
      return "resources.verSourceEdit";
  }
}
