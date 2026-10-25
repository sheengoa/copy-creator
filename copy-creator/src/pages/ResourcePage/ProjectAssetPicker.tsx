import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../../stores/projectStore";
import type { ClipboardRecord } from "../../types";
import { Icons } from "../../components/Icons";
import { inferResourceMediaKind } from "../../domain/mediaKind";
import {
  assetKindLabelKey,
  projectFileDisplayName,
  relativeLibraryPath,
} from "../../domain/projectView";

export interface ProjectAssetPickerProps {
  /** 挂靠目标：'' 为集级散件，否则挂到指定镜头。 */
  shotId: string;
  onClose: () => void;
  /** 挂靠成功后的回调（「重新挂靠替换」用：挂新文件后撤销旧档案）。 */
  onLinked?: () => void;
}

/** 单页条数：后端按关键词搜索 + 偏移分页，大库不再只有最新 200 条可选。 */
const PAGE_SIZE = 500;

/** 从资源库挑选文件挂进工程的浮层：后端搜索资源记录、仅保留库内文件
 *  条目，点选即挂靠（project_link_asset，同文件重复挂靠改归属）。 */
export default function ProjectAssetPicker({
  shotId,
  onClose,
  onLinked,
}: ProjectAssetPickerProps) {
  const { t } = useTranslation();
  // linkedPaths 不能放进 useShallow 的 selector：selector 每次渲染都会
  // 跑，new Set 的引用永远不等 → 无限重渲染 → React 卸载整树（白屏）。
  // 改为订阅 overview 引用 + useMemo 派生。
  const overview = useProjectStore((state) => state.overview);
  const { episodeId, linkAsset } = useProjectStore(
    useShallow((state) => ({
      episodeId: state.overview?.episode.id ?? "",
      linkAsset: state.linkAsset,
    })),
  );
  const linkedPaths = useMemo(
    () =>
      new Set([
        ...(overview?.loose_assets ?? []).map((asset) => asset.file_path),
        ...(overview?.scenes ?? []).flatMap((scene) =>
          scene.shots.flatMap((shot) => shot.assets.map((asset) => asset.file_path)),
        ),
      ]),
    [overview],
  );

  const [libraryRoot, setLibraryRoot] = useState("");
  const [records, setRecords] = useState<ClipboardRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  // 搜索词防抖后驱动后端查询；offset 只随「显示更多」推进。
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

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
    const list: Array<{ filePath: string; name: string; kind: string }> = [];
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
            {t("project.asset.pickerTitle")}
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
              const linked = linkedPaths.has(item.filePath);
              return (
                <div
                  key={item.filePath}
                  className={`project-library-card${linked ? "" : " pick"}`}
                  onClick={
                    linked
                      ? undefined
                      : () => {
                          void linkAsset({
                            filePath: item.filePath,
                            kind: item.kind,
                            name: item.name,
                            episodeId,
                            shotId,
                          }).then(() => onLinked?.());
                          onClose();
                        }
                  }
                >
                  <span className="project-asset-kind">{t(assetKindLabelKey(item.kind))}</span>
                  <div className="project-library-main">
                    <b>{item.name}</b>
                    <i>{item.filePath}</i>
                  </div>
                  <span className={`project-library-tag${linked ? " linked" : ""}`}>
                    {linked
                      ? t("project.asset.alreadyLinked")
                      : t("project.asset.linkAction")}
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
  );
}
