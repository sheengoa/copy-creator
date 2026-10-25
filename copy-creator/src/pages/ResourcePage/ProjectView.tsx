import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore, type ProjectEpisode } from "../../stores/projectStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import IosSelect from "../../components/IosSelect";
import { ResourceImage } from "./ResourceMedia";
import ProjectLibraryPanel from "./ProjectLibraryPanel";
import ProjectSceneBoard from "./ProjectSceneBoard";
import ProjectAssetPicker from "./ProjectAssetPicker";
import ProjectPromptPanel from "./ProjectPromptPanel";
import ProjectAssetSheet from "./ProjectAssetSheet";
import type { ProjectAsset } from "../../stores/projectStore";
import { Icons } from "../../components/Icons";
import { openResourceFile, readResourceTextPreview } from "../../domain/mediaAssets";
import {
  EPISODE_STATUSES,
  LIBRARY_KINDS,
  assetKindLabelKey,
  characterAvatarInitial,
  characterAvatarPaletteIndex,
  characterSubtitle,
  episodeHasDoneMark,
  episodeNumberLabel,
  episodeStatusKey,
  joinLibraryPath,
  scriptFileLabel,
} from "../../domain/projectView";

/** 工程视图：资源页内与文件视图并列的剧集工作台。数据全部来自
 *  projectStore；后端 project-changed 事件统一驱动重取。 */
export default function ProjectView() {
  const { t } = useTranslation();
  const {
    shows,
    currentShowId,
    episodes,
    currentEpisodeId,
    overview,
    overviewLoading,
    createEpisode,
    deleteEpisode,
    selectEpisode,
    updateEpisode,
    refresh,
    setEpisodeCharacters,
    moveEpisode,
    updateEpisodeNumber,
    unlinkAsset,
    prompts,
    loadPrompts,
    libraryPanel,
    openLibraryPanel,
    closeLibraryPanel,
  } = useProjectStore(
    useShallow((state) => ({
      shows: state.shows,
      currentShowId: state.currentShowId,
      episodes: state.episodes,
      currentEpisodeId: state.currentEpisodeId,
      overview: state.overview,
      overviewLoading: state.overviewLoading,
      createEpisode: state.createEpisode,
      deleteEpisode: state.deleteEpisode,
      selectEpisode: state.selectEpisode,
      updateEpisode: state.updateEpisode,
      refresh: state.refresh,
      setEpisodeCharacters: state.setEpisodeCharacters,
      moveEpisode: state.moveEpisode,
      updateEpisodeNumber: state.updateEpisodeNumber,
      unlinkAsset: state.unlinkAsset,
      prompts: state.prompts,
      loadPrompts: state.loadPrompts,
      libraryPanel: state.libraryPanel,
      openLibraryPanel: state.openLibraryPanel,
      closeLibraryPanel: state.closeLibraryPanel,
    })),
  );

  const [libraryRoot, setLibraryRoot] = useState("");
  const [scriptPreview, setScriptPreview] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectEpisode | null>(null);
  const [renamingEpisode, setRenamingEpisode] = useState(false);
  const [castPickOpen, setCastPickOpen] = useState(false);
  const [numberEditingId, setNumberEditingId] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState("");
  const [assetPickerShotId, setAssetPickerShotId] = useState<string | null>(null);
  const [sheetAsset, setSheetAsset] = useState<ProjectAsset | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const currentShow = shows.find((show) => show.id === currentShowId) ?? null;
  const currentEpisode = episodes.find((episode) => episode.id === currentEpisodeId) ?? null;

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_resource_library_path")
      .then((path) => {
        if (!cancelled) setLibraryRoot(path);
      })
      .catch(() => {
        // 库根拿不到时头像/剧本操作降级为占位，不阻塞工程结构展示。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (prompts.length === 0) void loadPrompts();
  }, [prompts.length, loadPrompts]);

  useEffect(() => {
    const unlisten = listen("project-changed", () => {
      void refresh();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // 剧本预览：挂接的剧本文件变化时重取（截断预览口径，正文编辑走
  // 资源详情页，工程面板只读）。
  const scriptPath = overview?.episode.script_path ?? "";
  useEffect(() => {
    setScriptPreview(null);
    if (!scriptPath) return;
    let cancelled = false;
    readResourceTextPreview(scriptPath)
      .then((preview) => {
        if (!cancelled) setScriptPreview(preview.content);
      })
      .catch(() => {
        // 文件缺失或不可读：面板显示文件名与打开入口即可。
      });
    return () => {
      cancelled = true;
    };
  }, [scriptPath]);

  useEffect(() => {
    if (renamingEpisode) renameInputRef.current?.select();
  }, [renamingEpisode]);

  const statusOptions = EPISODE_STATUSES.map((status) => ({
    value: status,
    label: t(episodeStatusKey(status)),
  }));

  const castCharacters = overview?.characters ?? [];
  const looseAssets = overview?.loose_assets ?? [];
  const scriptName = scriptFileLabel(scriptPath);

  const handleRenameSubmit = () => {
    if (!currentEpisode) return;
    const nextTitle = (renameInputRef.current?.value ?? "").trim();
    setRenamingEpisode(false);
    if (!nextTitle || nextTitle === currentEpisode.title) return;
    void updateEpisode(currentEpisode.id, {
      title: nextTitle,
      status: currentEpisode.status,
      script_path: currentEpisode.script_path,
    });
  };

  const submitNumber = (episodeId: string) => {
    setNumberEditingId(null);
    const episode = episodes.find((item) => item.id === episodeId);
    if (!episode) return;
    const next = Number.parseInt(numberDraft, 10);
    if (!Number.isInteger(next) || next === episode.number) return;
    void updateEpisodeNumber(episodeId, next);
  };

  return (
    <div className="project-workspace">
      <aside className="project-tree">
        {currentShow ? (
          <div className="project-show-head">
            <span className="project-show-icon">{Icons.clapperboard}</span>
            <div className="project-show-name">
              {currentShow.name}
              <span>{t("project.show.episodeCount", { count: currentShow.episode_count })}</span>
            </div>
          </div>
        ) : (
          <div className="project-show-head">
            <span className="project-show-icon">{Icons.clapperboard}</span>
            <div className="project-show-name">
              {t("project.show.empty")}
              <span>{t("project.show.emptyHint")}</span>
            </div>
          </div>
        )}
        <div className="project-ep-list">
          {episodes.map((episode, index) => {
            const active = episode.id === currentEpisodeId;
            const numberEditing = numberEditingId === episode.id;
            return (
              <div key={episode.id} className={`project-ep${active ? " active" : ""}`}>
                <button
                  type="button"
                  className="project-ep-main"
                  onClick={() => void selectEpisode(episode.id)}
                  onDoubleClick={() => {
                    setNumberEditingId(episode.id);
                    setNumberDraft(String(episode.number));
                  }}
                  title={
                    (episode.title || t("project.episode.untitled")) +
                    t("project.episode.numberHint")
                  }
                >
                  {numberEditing ? (
                    <input
                      className="project-ep-no-input"
                      value={numberDraft}
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setNumberDraft(event.target.value.replace(/\D/g, ""))}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitNumber(episode.id);
                        if (event.key === "Escape") setNumberEditingId(null);
                      }}
                      onBlur={() => submitNumber(episode.id)}
                    />
                  ) : (
                    <span className="project-ep-no">{episodeNumberLabel(episode.number)}</span>
                  )}
                  <span className="project-ep-name">
                    {episode.title || t("project.episode.untitled")}
                  </span>
                  {episodeHasDoneMark(episode.status) ? (
                    <span className="project-ep-done" aria-label={t("project.status.done")}>
                      {Icons.check}
                    </span>
                  ) : (
                    <span
                      className={`project-ep-chip${episode.status === "storyboard" ? " on" : ""}`}
                    >
                      {t(episodeStatusKey(episode.status))}
                    </span>
                  )}
                </button>
                <span className="project-ep-movers">
                  <span
                    role="button"
                    className={`project-ep-mover${index === 0 ? " disabled" : ""}`}
                    title={t("project.episode.moveUp")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (index > 0) void moveEpisode(episode.id, -1);
                    }}
                  >
                    {Icons.chevronUp}
                  </span>
                  <span
                    role="button"
                    className={`project-ep-mover${index === episodes.length - 1 ? " disabled" : ""}`}
                    title={t("project.episode.moveDown")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (index < episodes.length - 1) void moveEpisode(episode.id, 1);
                    }}
                  >
                    {Icons.chevronDown}
                  </span>
                </span>
              </div>
            );
          })}
          {currentShowId && (
            <button
              type="button"
              className="project-ep project-new-ep"
              onClick={() => void createEpisode(currentShowId, "")}
            >
              {Icons.add}
              {t("project.episode.new")}
            </button>
          )}
        </div>
        <div className="project-tree-split" />
        {LIBRARY_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="project-lib-row"
            onClick={() => openLibraryPanel(kind)}
          >
            <span className="project-lib-icon">
              {kind === "characters" ? Icons.clipboard : kind === "locations" ? Icons.resources : Icons.star}
            </span>
            <span className="project-lib-name">{t(`project.library.${kind}`)}</span>
            <span className="project-lib-scope">{t("project.library.scope")}</span>
          </button>
        ))}
        <button
          type="button"
          className="project-lib-row"
          onClick={() => openLibraryPanel("prompts")}
        >
          <span className="project-lib-icon">{Icons.copy}</span>
          <span className="project-lib-name">{t("project.prompt.title")}</span>
          <span className="project-lib-scope">{t("project.library.scope")}</span>
        </button>
      </aside>

      <section className="project-stage">
        {!currentShowId ? (
          <div className="project-stage-empty">
            {Icons.clapperboard}
            <p>{t("project.show.emptyStage")}</p>
          </div>
        ) : !currentEpisode ? (
          <div className="project-stage-empty">
            {Icons.clapperboard}
            <p>{t("project.episode.emptyStage")}</p>
          </div>
        ) : (
          <>
            <div className="project-crumb">
              {currentShow?.name} / {t("project.episode.crumb", {
                number: episodeNumberLabel(currentEpisode.number),
              })}
            </div>
            <div className="project-stage-title-row">
              {renamingEpisode ? (
                <input
                  ref={renameInputRef}
                  className="project-title-input"
                  defaultValue={currentEpisode.title}
                  placeholder={t("project.episode.untitled")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleRenameSubmit();
                    if (event.key === "Escape") setRenamingEpisode(false);
                  }}
                  onBlur={handleRenameSubmit}
                  autoFocus
                />
              ) : (
                <h2
                  className="project-stage-title"
                  title={t("project.episode.renameHint")}
                  onDoubleClick={() => setRenamingEpisode(true)}
                >
                  {currentEpisode.title || t("project.episode.untitled")}
                </h2>
              )}
              <IosSelect
                value={currentEpisode.status}
                options={statusOptions}
                onChange={(next) =>
                  void updateEpisode(currentEpisode.id, {
                    title: currentEpisode.title,
                    status: next as ProjectEpisode["status"],
                    script_path: currentEpisode.script_path,
                  })
                }
              />
              <span className="project-title-spacer" />
              <button
                type="button"
                className="project-mini-btn"
                title={t("project.episode.delete")}
                onClick={() => setDeleteTarget(currentEpisode)}
              >
                {Icons.delete}
              </button>
            </div>

            <div className="project-cast">
              <span className="project-cast-label">{t("project.cast.title")}</span>
              {castCharacters.length === 0 ? (
                <span className="project-cast-empty">{t("project.cast.empty")}</span>
              ) : (
                castCharacters.map((character) => {
                  const avatarPath = character.avatar_path
                    ? joinLibraryPath(libraryRoot, character.avatar_path)
                    : "";
                  return (
                    <div key={character.id} className="project-cast-card" title={character.bio}>
                      <span
                        className={`project-avatar project-avatar-p${characterAvatarPaletteIndex(character.name)}`}
                      >
                        {avatarPath ? (
                          <ResourceImage
                            path={avatarPath}
                            alt={character.name}
                            className="project-avatar-img"
                          />
                        ) : (
                          characterAvatarInitial(character.name)
                        )}
                      </span>
                      <span className="project-cast-info">
                        <b>{character.name}</b>
                        <i>{characterSubtitle(character.role_tag, t("project.cast.global"))}</i>
                      </span>
                    </div>
                  );
                })
              )}
              {currentEpisode && (
                <button
                  type="button"
                  className="project-cast-add"
                  onClick={() => setCastPickOpen(true)}
                >
                  {Icons.add}
                  {t("project.cast.link")}
                </button>
              )}
            </div>

            <div className="project-stage-main">
              <div className="project-script">
                {scriptName ? (
                  <>
                    <div className="project-script-head">
                      <span className="project-script-icon">{Icons.file}</span>
                      <span className="project-script-file" title={scriptName}>
                        {scriptName}
                      </span>
                      <button
                        type="button"
                        className="project-mini-btn"
                        title={t("project.script.open")}
                        onClick={() => void openResourceFile(joinLibraryPath(libraryRoot, scriptPath))}
                      >
                        {Icons.externalLink}
                      </button>
                    </div>
                    <div className="project-script-body">
                      {scriptPreview === null ? (
                        <span className="project-script-loading">
                          {t("project.script.loading")}
                        </span>
                      ) : (
                        scriptPreview
                          .split("\n")
                          .slice(0, 12)
                          .map((line, index) => (
                            <p key={index} className="project-script-line">
                              {line || "\u00a0"}
                            </p>
                          ))
                      )}
                    </div>
                    <div className="project-script-foot">
                      {t("project.script.footer", {
                        count: (scriptPreview ?? "").split(/场\s*\d/).length - 1,
                      })}
                    </div>
                  </>
                ) : (
                  <div className="project-script-empty">
                    {Icons.file}
                    <p>{t("project.script.empty")}</p>
                    <p className="project-script-empty-hint">
                      {t("project.script.emptyHint")}
                    </p>
                  </div>
                )}
              </div>

              <div className="project-stage-right">
                <ProjectSceneBoard />

                <div className="project-assets">
                  <div className="project-assets-head">
                    <h4>{t("project.asset.title")}</h4>
                    <span>{looseAssets.length}</span>
                    <span className="project-title-spacer" />
                    <button
                      type="button"
                      className="project-mini-btn"
                      title={t("project.asset.link")}
                      onClick={() => setAssetPickerShotId("")}
                    >
                      {Icons.add}
                    </button>
                  </div>
                  {overviewLoading ? (
                    <div className="project-assets-empty">{t("project.loading")}</div>
                  ) : looseAssets.length === 0 ? (
                    <div className="project-assets-empty">
                      {Icons.empty}
                      <p>{t("project.asset.empty")}</p>
                    </div>
                  ) : (
                    <div className="project-asset-list">
                      {looseAssets.map((asset) => (
                        <div
                          key={asset.id}
                          className="project-asset-row is-clickable"
                          title={asset.file_path}
                          onClick={() => setSheetAsset(asset)}
                        >
                          <span className="project-asset-kind">
                            {t(assetKindLabelKey(asset.kind))}
                          </span>
                          <span className="project-asset-name">
                            {asset.name || asset.file_path}
                            {asset.gen_from_prompt && prompts.length > 0 && (
                              <i className="project-asset-trace">
                                {t("project.sheet.traceBadge", {
                                  title:
                                    prompts.find((prompt) => prompt.id === asset.gen_from_prompt)?.title ?? "",
                                })}
                              </i>
                            )}
                          </span>
                          <button
                            type="button"
                            className="project-asset-unlink"
                            title={t("project.asset.unlink")}
                            onClick={(event) => {
                              event.stopPropagation();
                              void unlinkAsset(asset.id);
                            }}
                          >
                            {Icons.close}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {assetPickerShotId !== null && (
        <ProjectAssetPicker shotId={assetPickerShotId} onClose={() => setAssetPickerShotId(null)} />
      )}

      {sheetAsset && <ProjectAssetSheet asset={sheetAsset} onClose={() => setSheetAsset(null)} />}

      {/* 全局面板（树底入口/搜索跳转）：三库浏览或提示词库 */}
      {libraryPanel?.kind === "prompts" && (
        <ProjectPromptPanel onClose={() => closeLibraryPanel()} />
      )}
      {libraryPanel && libraryPanel.kind !== "prompts" && (
        <ProjectLibraryPanel
          kind={libraryPanel.kind}
          mode="browse"
          onClose={() => closeLibraryPanel()}
        />
      )}

      {/* 集工作台的多选关联角色（pick）：点选切换（可加可减），与镜头
          出镜行为一致；改动即存（整组替换）。 */}
      {castPickOpen && currentEpisode && (
        <ProjectLibraryPanel
          kind="characters"
          mode="pick"
          multi
          selectedIds={overview?.episode.character_ids ?? []}
          onClose={() => setCastPickOpen(false)}
          pickTitle={t("project.cast.pickTitle", {
            number: episodeNumberLabel(currentEpisode.number),
            title: currentEpisode.title || t("project.episode.untitled"),
          })}
          onTogglePick={(id) => {
            if (!currentEpisodeId) return;
            const existing = overview?.episode.character_ids ?? [];
            const next = existing.includes(id)
              ? existing.filter((item) => item !== id)
              : [...existing, id];
            void setEpisodeCharacters(currentEpisodeId, next);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          message={t("project.episode.deleteConfirm", {
            title: deleteTarget.title || t("project.episode.untitled"),
          })}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void deleteEpisode(target.id);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
