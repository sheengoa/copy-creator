import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { inferResourceMediaKind } from "../../domain/mediaKind";
import { ResourceFileImage, ResourceVideoPoster } from "./ResourceMedia";
import {
  assetKindLabelKey,
  joinLibraryPath,
  projectFileDisplayName,
  relativeLibraryPath,
} from "../../domain/projectView";

export interface PickedLibraryFile {
  /** 相对资源库根的路径（工程域路径约定）。 */
  filePath: string;
  kind: string;
  name: string;
}

export interface ProjectFilePickerDialogProps {
  /** 浮层标题（调用方负责 i18n，如「挂靠资源库文件」「选择图片」）。 */
  title: string;
  /** 点选文件回调；单选场景由调用方在回调里关浮层，多选场景保持
   *  打开供连续挑选——开与关都是调用方的职责。 */
  onPick: (file: PickedLibraryFile) => void;
  onClose: () => void;
  /** 已被占用的路径：卡片禁点并显示占用标签（挂靠场景「已挂靠」）。 */
  takenPaths?: Set<string>;
  takenLabel?: string;
  /** 卡片动作文案与导入按钮文案：挂靠语境「挂靠/从电脑导入并挂靠」，
   *  三库回填语境「选择/从电脑导入」。 */
  pickLabel?: string;
  importLabel?: string;
}

/** 单页条数：后端按关键词搜索 + 偏移分页，大库不再只有最新 200 条可选。 */
const PAGE_SIZE = 500;

/** 选择器卡片缩略图：图片/视频出真预览（真懒加载，滚动到才解码，大库
 *  不卡），音频/文本/文件出类型占位——预览让「选哪个」选得有把握。 */
function PickerCardThumb({
  item,
  libraryRoot,
}: {
  item: { filePath: string; kind: string };
  libraryRoot: string;
}) {
  const { t } = useTranslation();
  const kindKey = t(assetKindLabelKey(item.kind));
  const absolutePath = joinLibraryPath(libraryRoot, item.filePath);
  if (item.kind === "image") {
    return (
      <span className="project-library-thumb">
        <ResourceFileImage path={absolutePath} alt={item.filePath} className="project-library-thumb-img" />
      </span>
    );
  }
  if (item.kind === "video") {
    return (
      <span className="project-library-thumb">
        <ResourceVideoPoster path={absolutePath} fallbackLabel={kindKey} />
        <span className="project-library-thumb-play">{Icons.play}</span>
      </span>
    );
  }
  return (
    <span className="project-library-thumb is-placeholder">
      {item.kind === "audio" ? Icons.audio : Icons.file}
      <span>{kindKey}</span>
    </span>
  );
}

/** 通用「从资源库选文件」浮层：后端搜索分页 + 缩略图预览 + 库外文件
 *  导入（复制进库根「未分组」）。工程域的挂靠、三库图片路径等都以
 *  薄壳复用它，只各自的 onPick 里做回填/挂靠。 */
export default function ProjectFilePickerDialog({
  title,
  onPick,
  onClose,
  takenPaths,
  takenLabel,
  pickLabel,
  importLabel,
}: ProjectFilePickerDialogProps) {
  const { t } = useTranslation();
  const [libraryRoot, setLibraryRoot] = useState("");
  const [records, setRecords] = useState<ClipboardRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  // 搜索词防抖后驱动后端查询；offset 只随「显示更多」推进。
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  // 库外导入：选完文件后的复制进行中态与失败提示（取消静默）。
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState("");
  const [importError, setImportError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      invoke<string>("get_resource_library_path"),
      invoke<ClipboardRecord[]>("get_clipboard_records", {
        limit: PAGE_SIZE,
        offset: 0,
        category: "resources",
        search: search || undefined,
      }),
    ])
      .then(([root, rows]) => {
        if (cancelled) return;
        setLibraryRoot(root);
        setRecords(rows);
        setOffset(0);
        setHasMore(rows.length === PAGE_SIZE);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search]);

  const loadMore = () => {
    if (loadingMore) return;
    setLoadingMore(true);
    invoke<ClipboardRecord[]>("get_clipboard_records", {
      limit: PAGE_SIZE,
      offset: offset + PAGE_SIZE,
      category: "resources",
      search: search || undefined,
    })
      .then((rows) => {
        setRecords((prev) => [...prev, ...rows]);
        setOffset((prev) => prev + PAGE_SIZE);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  // 仅保留有库内文件的记录（工程档案的路径约定必须相对库根），同一
  // 文件多记录跨页去重；关键词过滤已由后端完成。
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const list: PickedLibraryFile[] = [];
    for (const record of records) {
      const absolute = record.resource_path || (record.type === "file" ? record.content : "");
      if (!absolute) continue;
      const relative = relativeLibraryPath(libraryRoot, absolute);
      if (!relative || seen.has(relative)) continue;
      seen.add(relative);
      list.push({
        filePath: relative,
        name: projectFileDisplayName("", relative),
        kind: inferResourceMediaKind({ type: "file", content: relative }),
      });
    }
    return list;
  }, [records, libraryRoot]);

  const importAndPick = async () => {
    if (importing) return;
    setImportError("");
    setImporting(true);
    try {
      const { path } = await invoke<{ path: string }>("select_resource_trace_file");
      setImportFile(path.split(/[\\/]/).pop() ?? path);
      // 只入库不挂靠（import_resource_file 不落工程档案）；怎么用交给
      // 调用方——挂靠壳在 onPick 里挂，三库壳回填路径。关闭也归调用方
      // （单选在 onPick 后关，多选保持打开供连续挑选）。
      const file = await invoke<{ file_path: string; kind: string; name: string }>(
        "import_resource_file",
        { sourcePath: path },
      );
      onPick({ filePath: file.file_path, kind: file.kind, name: file.name });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes("cancelled")) return;
      setImportError(text);
    } finally {
      setImporting(false);
      setImportFile("");
    }
  };

  return (
    <div
      className="project-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="project-dialog project-library-panel">
        <div className="project-dialog-head">
          <h4>
            {title}
            <span className="project-library-count">{candidates.length}</span>
          </h4>
          <button
            type="button"
            className="project-dialog-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            {Icons.close}
          </button>
        </div>
        <div className="project-dialog-body" style={{ paddingBottom: 8 }}>
          <input
            className="project-dialog-input"
            value={query}
            placeholder={t("project.asset.pickerSearch")}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </div>
        <div className="project-library-body">
          {loading ? (
            <div className="project-library-empty">{t("project.loading")}</div>
          ) : candidates.length === 0 ? (
            <div className="project-library-empty">
              {Icons.empty}
              <p>{t("project.asset.pickerEmpty")}</p>
            </div>
          ) : (
            candidates.map((item) => {
              const taken = takenPaths?.has(item.filePath) ?? false;
              return (
                <div
                  key={item.filePath}
                  className={`project-library-card${taken ? "" : " pick"}`}
                  onClick={taken ? undefined : () => onPick(item)}
                >
                  <PickerCardThumb item={item} libraryRoot={libraryRoot} />
                  <div className="project-library-main">
                    <b>{item.name}</b>
                    <i>{item.filePath}</i>
                  </div>
                  <span className={`project-library-tag${taken ? " linked" : ""}`}>
                    {taken
                      ? (takenLabel ?? t("project.asset.alreadyLinked"))
                      : (pickLabel ?? t("project.asset.linkAction"))}
                  </span>
                </div>
              );
            })
          )}
          {hasMore && !loading && candidates.length > 0 && (
            <button
              type="button"
              className="project-library-more"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? t("project.loading") : t("resources.loadMore")}
            </button>
          )}
        </div>
        <div className="project-import-bar">
          <button
            type="button"
            className="project-library-import"
            onClick={() => void importAndPick()}
            disabled={importing}
          >
            {Icons.add}
            <span>
              {importing
                ? t("project.asset.importing", { file: importFile })
                : (importLabel ?? t("project.asset.importAction"))}
            </span>
          </button>
          {importError && (
            <div className="project-import-error" role="alert">
              {t("project.asset.importFailed")}：{importError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
