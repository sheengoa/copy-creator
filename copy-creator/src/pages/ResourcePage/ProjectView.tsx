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
import ProjectCanvas from "./ProjectCanvas";
import ProjectAssetPicker from "./ProjectAssetPicker";
import ProjectPromptPanel from "./ProjectPromptPanel";
import ProjectAssetSheet from "./ProjectAssetSheet";
import type { ProjectAsset } from "../../stores/projectStore";
import { Icons } from "../../components/Icons";
import { openResourceFile } from "../../domain/mediaAssets";
import {
  EPISODE_STATUSES,
  LIBRARY_KINDS,
  characterAvatarInitial,
  characterAvatarPaletteIndex,
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
    createEpisode,
    deleteEpisode,
    selectEpisode,
    updateEpisode,
    refresh,
    setEpisodeCharacters,
    moveEpisode,
    updateEpisodeNumber,
    unlinkAsset,
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
      createEpisode: state.createEpisode,
      deleteEpisode: state.deleteEpisode,
      selectEpisode: state.selectEpisode,
      updateEpisode: state.updateEpisode,
      refresh: state.refresh,
      setEpisodeCharacters: state.setEpisodeCharacters,
      moveEpisode: state.moveEpisode,
      updateEpisodeNumber: state.updateEpisodeNumber,
      unlinkAsset: state.unlinkAsset,
      libraryPanel: state.libraryPanel,
      openLibraryPanel: state.openLibraryPanel,
      closeLibraryPanel: state.closeLibraryPanel,
    })),
  );

  const [libraryRoot, setLibraryRoot] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectEpisode | null>(null);
  const [renamingEpisode, setRenamingEpisode] = useState(false);
  const [castPickOpen, setCastPickOpen] = useState(false);
  const [numberEditingId, setNumberEditingId] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState("");
  const [assetPickerShotId, setAssetPickerShotId] = useState<string | null>(null);
  const [sheetAsset, setSheetAsset] = useState<ProjectAsset | null>(null);
  // 「重新挂靠」替换流：详情浮层对缺失档案发起时记录旧档案，选择器
  // 挂上新文件成功后把旧档案取消挂靠（两步都走既有命令）。
  const [replaceAsset, setReplaceAsset] = useState<ProjectAsset | null>(null);
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
    const unlisten = listen("project-changed", () => {
      void refresh();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  useEffect(() => {
    if (renamingEpisode) renameInputRef.current?.select();
  }, [renamingEpisode]);

  const statusOptions = EPISODE_STATUSES.map((status) => ({
    value: status,
    label: t(episodeStatusKey(status)),
  }));

  const castCharacters = overview?.characters ?? [];
  const scriptPath = overview?.episode.script_path ?? "";
  const scriptName = scriptFileLabel(scriptPath);

  // 画布左上角玻璃卡内容：集身份/状态/出场角色/剧本入口。

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

  const epOverlay = currentEpisode ? (
    <>
      <div className="pc-ep-crumb">
        {currentShow?.name} /{" "}
        {t("project.episode.crumb", { number: episodeNumberLabel(currentEpisode.number) })}
      </div>
      <div className="pc-ep-row">
        {renamingEpisode ? (
          <input
            ref={renameInputRef}
            className="pc-ep-title-input"
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
            className="pc-ep-title"
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
        <button
          type="button"
          className="pc-ep-del"
          title={t("project.episode.delete")}
          onClick={() => setDeleteTarget(currentEpisode)}
        >
          {Icons.delete}
        </button>
      </div>
      <div className="pc-cast">
        {castCharacters.map((character) => {
          const avatarPath = character.avatar_path
            ? joinLibraryPath(libraryRoot, character.avatar_path)
            : "";
          return (
            <span key={character.id} className="pc-cast-chip" title={character.bio}>
              <span className={`pc-cast-ava pc-ava-p${characterAvatarPaletteIndex(character.name)}`}>
                {avatarPath ? (
                  <ResourceImage
                    path={avatarPath}
                    alt={character.name}
                    className="pc-cast-ava-img"
                    version={character.updated_at}
                  />
                ) : (
                  characterAvatarInitial(character.name)
                )}
              </span>
              {character.name}
            </span>
          );
        })}
        <button type="button" className="pc-cast-add" title={t("project.cast.link")} onClick={() => setCastPickOpen(true)}>
          {Icons.add}
        </button>
      </div>
      {scriptName && (
        <button
          type="button"
          className="pc-script-row"
          title={t("project.script.open")}
          onClick={() => void openResourceFile(joinLibraryPath(libraryRoot, scriptPath))}
        >
          {Icons.file}
          <span>{scriptName}</span>
          {Icons.externalLink}
        </button>
      )}
    </>
  ) : null;

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
                    {episode.shot_count > 0 && (
                      <span className="project-ep-progress">
                        {episode.done_shot_count}/{episode.shot_count}
                      </span>
                    )}
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
          <div className="project-stage-shell">
            <ProjectCanvas
              libraryRoot={libraryRoot}
              overlay={epOverlay}
              onOpenAsset={setSheetAsset}
              onPickForShot={setAssetPickerShotId}
              onAddLooseAsset={() => setAssetPickerShotId("")}
              onRelinkAsset={(asset) => {
                setReplaceAsset(asset);
                setSheetAsset(null);
                setAssetPickerShotId(asset.shot_id);
              }}
            />
          </div>
        )}
      </section>

      {assetPickerShotId !== null && (
        <ProjectAssetPicker
          shotId={assetPickerShotId}
          onClose={() => {
            setAssetPickerShotId(null);
            setReplaceAsset(null);
          }}
          onLinked={
            replaceAsset
              ? () => {
                  void unlinkAsset(replaceAsset.id);
                  setReplaceAsset(null);
                }
              : undefined
          }
        />
      )}

      {sheetAsset && (
        <ProjectAssetSheet
          asset={sheetAsset}
          onClose={() => setSheetAsset(null)}
          onRelink={
            sheetAsset.missing
              ? () => {
                  setReplaceAsset(sheetAsset);
                  setSheetAsset(null);
                  setAssetPickerShotId(sheetAsset.shot_id);
                }
              : undefined
          }
        />
      )}

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
