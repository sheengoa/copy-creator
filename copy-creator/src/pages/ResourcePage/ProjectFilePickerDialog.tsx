import { Fragment, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
  /** 媒体类型白名单（image/video/audio 等，按扩展名推断）：画布加载
   *  节点「从资源库选择」按节点类型传入，类型不符的文件不再列出——
   *  图像节点选到视频只会得到一块空白。缺省不过滤（挂靠等全类型场景）。 */
  kindFilter?: string[];
}

/** 单页条数：后端按关键词搜索 + 偏移分页，大库不再只有最新 200 条可选。 */
const PAGE_SIZE = 500;

/** list_resource_groups 的树节点：path 为相对库根的分组路径（"" 即库根
 *  「未分组」，首项固定是它），count 为含全部子级的文件数。 */
interface PickerFolder {
  name: string;
  path: string;
  count: number;
  children: PickerFolder[];
}

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

/** 分组树行：递归渲染多级分组。行本体点击选中分组，展开箭头只管折叠
 *  （stopPropagation），计数用后端给的含子级总量，不随搜索词变化。 */
function PickerTreeRow({
  folder,
  depth,
  selectedGroup,
  expandedPaths,
  onSelect,
  onToggle,
}: {
  folder: PickerFolder;
  depth: number;
  selectedGroup: string | null;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const { t } = useTranslation();
  const hasChildren = folder.children.length > 0;
  const isOpen = expandedPaths.has(folder.path);
  return (
    <Fragment key={folder.path}>
      <div
        className={`project-picker-tree-row${selectedGroup === folder.path ? " active" : ""}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => onSelect(folder.path)}
      >
        {hasChildren ? (
          <button
            type="button"
            className={`project-picker-tree-twist${isOpen ? " open" : ""}`}
            aria-label={isOpen ? t("resources.collapseGroup") : t("resources.expandGroup")}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(folder.path);
            }}
          >
            {Icons.chevronDown}
          </button>
        ) : (
          <span className="project-picker-tree-twist is-leaf" aria-hidden="true" />
        )}
        <span className="project-picker-tree-label">
          {Icons.folderFine}
          <span className="project-picker-tree-name">{folder.name}</span>
          <span className="project-picker-tree-count">{folder.count}</span>
        </span>
      </div>
      {hasChildren &&
        isOpen &&
        folder.children.map((child) => (
          <PickerTreeRow
            key={child.path}
            folder={child}
            depth={depth + 1}
            selectedGroup={selectedGroup}
            expandedPaths={expandedPaths}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
    </Fragment>
  );
}

/** 通用「从资源库选文件」浮层：左侧多级分组树（后端分组过滤，含子级
 *  聚合语义）+ 搜索分页 + 缩略图预览 + 库外文件导入（复制进库根「未
 *  分组」）。工程域的挂靠、三库图片路径等都以薄壳复用它，只各自的
 *  onPick 里做回填/挂靠。搜索跟随当前分组（后端 AND 叠加），分组内搜
 *  不到时给「在全部文件中搜索」一键跳出，避免「明明有却搜不到」。 */
export default function ProjectFilePickerDialog({
  title,
  onPick,
  onClose,
  takenPaths,
  takenLabel,
  pickLabel,
  importLabel,
  kindFilter,
}: ProjectFilePickerDialogProps) {
  const { t } = useTranslation();
  const [libraryRoot, setLibraryRoot] = useState("");
  const [groups, setGroups] = useState<PickerFolder[]>([]);
  // 当前分组：null=全部文件（不传参），""=未分组（库根），路径=该分组
  // 及其全部子级——与资源页文件视图同一套过滤语义。
  const [group, setGroup] = useState<string | null>(null);
  // 默认展开全部顶层分组、子级收起；分组树加载失败静默，仅剩「全部
  // 文件/未分组」两行，选择能力不受影响。
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
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
    let cancelled = false;
    invoke<PickerFolder[]>("list_resource_groups")
      .then((tree) => {
        if (cancelled || !Array.isArray(tree)) return;
        setGroups(tree);
        setExpandedPaths(new Set(tree.filter((folder) => folder.path !== "").map((folder) => folder.path)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      invoke<string>("get_resource_library_path"),
      invoke<ClipboardRecord[]>("list_clipboard_records", {
        limit: PAGE_SIZE,
        offset: 0,
        category: "resources",
        search: search || undefined,
        // 分组过滤（含子级）由后端完成；null 即全库，不传参。
        ...(group !== null ? { resourceGroup: group } : {}),
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
  }, [search, group]);

  const loadMore = () => {
    if (loadingMore) return;
    setLoadingMore(true);
    invoke<ClipboardRecord[]>("list_clipboard_records", {
      limit: PAGE_SIZE,
      offset: offset + PAGE_SIZE,
      category: "resources",
      search: search || undefined,
      ...(group !== null ? { resourceGroup: group } : {}),
    })
      .then((rows) => {
        setRecords((prev) => [...prev, ...rows]);
        setOffset((prev) => prev + PAGE_SIZE);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  const toggleFolder = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const topLevelGroups = useMemo(() => groups.filter((folder) => folder.path !== ""), [groups]);
  const ungroupedFolder = groups.find((folder) => folder.path === "");

  // 仅保留有库内文件的记录（工程档案的路径约定必须相对库根），同一
  // 文件多记录跨页去重；关键词与分组过滤均已由后端完成。kindFilter 在
  // 此处按推断类型过滤（后端不产类型，kind 本就是前端按扩展名算的）。
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const list: PickedLibraryFile[] = [];
    for (const record of records) {
      const absolute = record.resource_path || (record.type === "file" ? record.content : "");
      if (!absolute) continue;
      const relative = relativeLibraryPath(libraryRoot, absolute);
      if (!relative || seen.has(relative)) continue;
      seen.add(relative);
      const kind = inferResourceMediaKind({ type: "file", content: relative });
      if (kindFilter && !kindFilter.includes(kind)) continue;
      list.push({
        filePath: relative,
        name: projectFileDisplayName("", relative),
        kind,
      });
    }
    return list;
  }, [records, libraryRoot, kindFilter]);

  const importAndPick = async () => {
    if (importing) return;
    setImportError("");
    setImporting(true);
    try {
      const { path } = await invoke<{ path: string }>("select_resource_trace_file");
      setImportFile(path.split(/[\\/]/).pop() ?? path);
      // 类型白名单在导入前拦截（复制入库之前就拒掉，不给库里塞进选不
      // 了的文件）：选择器给出的 kind 是按扩展名推断的，导入前同样按
      // 扩展名推断，语义一致。
      const wantKind = kindFilter?.[0];
      if (wantKind) {
        const pickedKind = inferResourceMediaKind({ type: "file", content: path });
        if (pickedKind !== wantKind) {
          setImportError(
            t("project.asset.importKindMismatch", { kind: t(assetKindLabelKey(wantKind)) }),
          );
          return;
        }
      }
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

  // portal 到 body：画布/工程面板祖先链上的 transform 容器会把 fixed
  // 层级困进其 stacking context，被 portal 的详情窗（z90）压住（用户实测
  // 「选择框被窗口遮挡」）——顶层挂载后 z200 直接与 body 层比较，永远在上。
  return createPortal(
    <div
      className="project-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="project-dialog project-library-panel project-picker-panel">
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
        <div className="project-picker-cols">
          <div className="project-picker-tree" role="tree" aria-label={t("resources.groups")}>
            <div
              className={`project-picker-tree-row${group === null ? " active" : ""}`}
              onClick={() => setGroup(null)}
            >
              <span className="project-picker-tree-twist is-leaf" aria-hidden="true" />
              <span className="project-picker-tree-label">
                {Icons.resources}
                <span className="project-picker-tree-name">{t("resources.allFiles")}</span>
              </span>
            </div>
            <div
              className={`project-picker-tree-row${group === "" ? " active" : ""}`}
              onClick={() => setGroup("")}
            >
              <span className="project-picker-tree-twist is-leaf" aria-hidden="true" />
              <span className="project-picker-tree-label">
                {Icons.folderFine}
                <span className="project-picker-tree-name">{t("resources.ungrouped")}</span>
                {ungroupedFolder && (
                  <span className="project-picker-tree-count">{ungroupedFolder.count}</span>
                )}
              </span>
            </div>
            {topLevelGroups.map((folder) => (
              <PickerTreeRow
                key={folder.path}
                folder={folder}
                depth={0}
                selectedGroup={group}
                expandedPaths={expandedPaths}
                onSelect={setGroup}
                onToggle={toggleFolder}
              />
            ))}
          </div>
          <div className="project-picker-main">
            <div className="project-dialog-body" style={{ paddingBottom: 8 }}>
              <input
                className="project-dialog-input"
                value={query}
                placeholder={
                  group === null
                    ? t("project.asset.pickerSearch")
                    : t("project.asset.pickerSearchInGroup", {
                        group: group === "" ? t("resources.ungrouped") : group,
                      })
                }
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
                  <p>
                    {kindFilter
                      ? // 类型过滤空态：点名「这个库/分组里没有该类型」，与全类型空态区分。
                        group === null
                          ? t("project.asset.pickerKindEmptyAll", {
                              kind: t(assetKindLabelKey(kindFilter[0])),
                            })
                          : t("project.asset.pickerKindEmptyGroup", {
                              kind: t(assetKindLabelKey(kindFilter[0])),
                            })
                      : group === null
                        ? t("project.asset.pickerEmpty")
                        : t("project.asset.pickerEmptyInGroup")}
                  </p>
                  {group !== null && search !== "" && (
                    <button
                      type="button"
                      className="project-picker-search-all"
                      onClick={() => setGroup(null)}
                    >
                      {t("project.asset.pickerSearchAllGroups", { query: search })}
                    </button>
                  )}
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
          </div>
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
    </div>,
    document.body,
  );
}
