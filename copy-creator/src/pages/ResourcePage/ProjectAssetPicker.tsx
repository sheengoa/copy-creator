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
}

/** 从资源库挑选文件挂进工程的浮层：列资源记录中有库内文件的条目，
 *  搜索过滤，点选即挂靠（project_link_asset，同文件重复挂靠改归属）。 */
export default function ProjectAssetPicker({ shotId, onClose }: ProjectAssetPickerProps) {
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
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<string>("get_resource_library_path"),
      invoke<ClipboardRecord[]>("get_clipboard_records", {
        limit: 200,
        offset: 0,
        category: "resources",
      }),
    ])
      .then(([root, rows]) => {
        if (cancelled) return;
        setLibraryRoot(root);
        setRecords(rows);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 仅展示有库内文件的记录（工程档案的路径约定必须相对库根），并按
  // 名称搜索过滤；同一文件多记录去重。
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
    const keyword = query.trim().toLowerCase();
    return keyword ? list.filter((item) => item.name.toLowerCase().includes(keyword)) : list;
  }, [records, libraryRoot, query]);

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
                          });
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
        </div>
      </div>
    </div>
  );
}
