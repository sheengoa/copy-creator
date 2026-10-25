import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  useProjectStore,
  type ProjectScene,
  type ProjectShot,
} from "../../stores/projectStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import ProjectLibraryPanel from "./ProjectLibraryPanel";
import ProjectAssetPicker from "./ProjectAssetPicker";
import ProjectAssetSheet from "./ProjectAssetSheet";
import type { ProjectAsset } from "../../stores/projectStore";
import { Icons } from "../../components/Icons";
import {
  SHOT_STATUSES,
  characterAvatarInitial,
  characterAvatarPaletteIndex,
  locationSubtitleParts,
  intExtLabelKey,
  shotStatusKey,
  timeHintLabelKey,
} from "../../domain/projectView";

interface SceneDraft {
  id?: string;
  heading: string;
  locationId: string;
}

interface ShotDraft {
  id: string;
  isNew: boolean;
  sceneId: string;
  description: string;
  dialogue: string;
  status: string;
  camera: string;
  duration: string;
}

type PickState = { shotId: string; kind: "characters" | "props" } | null;

/** 集工作台的场景与镜头板：场景卡（标题 + 引用全局场景库）内含镜头
 *  列表（描述/对白/出镜角色/道具），全部内联编辑，改动即存。 */
export default function ProjectSceneBoard() {
  const { t } = useTranslation();
  const {
    overview,
    locations,
    characters,
    props,
    loadLocations,
    loadCharacters,
    loadProps,
    saveScene,
    deleteScene,
    saveShot,
    deleteShot,
    setShotCharacters,
    setShotProps,
    moveScene,
    moveShot,
    unlinkAsset,
  } = useProjectStore(
    useShallow((state) => ({
      overview: state.overview,
      locations: state.locations,
      characters: state.characters,
      props: state.props,
      loadLocations: state.loadLocations,
      loadCharacters: state.loadCharacters,
      loadProps: state.loadProps,
      saveScene: state.saveScene,
      deleteScene: state.deleteScene,
      saveShot: state.saveShot,
      deleteShot: state.deleteShot,
      setShotCharacters: state.setShotCharacters,
      setShotProps: state.setShotProps,
      moveScene: state.moveScene,
      moveShot: state.moveShot,
      unlinkAsset: state.unlinkAsset,
    })),
  );

  const episodeId = overview?.episode.id ?? "";
  const scenes = overview?.scenes ?? [];

  const [sceneDraft, setSceneDraft] = useState<SceneDraft | null>(null);
  const [shotDraft, setShotDraft] = useState<ShotDraft | null>(null);
  const [pick, setPick] = useState<PickState>(null);
  const [assetPickerShotId, setAssetPickerShotId] = useState<string | null>(null);
  const [sheetAsset, setSheetAsset] = useState<ProjectAsset | null>(null);
  // 「重新挂靠」替换流：缺失档案从详情浮层发起，选择器挂上新文件后撤销旧档案。
  const [replaceAsset, setReplaceAsset] = useState<ProjectAsset | null>(null);
  const [deleteSceneTarget, setDeleteSceneTarget] = useState<ProjectScene | null>(null);
  const [deleteShotTarget, setDeleteShotTarget] = useState<ProjectShot | null>(null);

  // 场景编辑需要场景库选项、镜头出镜需要角色名，首次渲染懒加载。
  useEffect(() => {
    if (locations.length === 0) void loadLocations();
    if (characters.length === 0) void loadCharacters();
    if (props.length === 0) void loadProps();
  }, [locations.length, characters.length, props.length, loadLocations, loadCharacters, loadProps]);

  const pickShot = pick ? (scenes.flatMap((s) => s.shots).find((sh) => sh.id === pick.shotId) ?? null) : null;

  // 新建与编辑镜头共用四组字段（描述/台词/状态/景别/时长）；出镜与
  // 道具 chips 依赖已存在的镜头 id，仅编辑表单渲染。
  const shotFieldRows = (draft: ShotDraft) => (
    <>
      <label>
        <span>{t("project.shot.field.description")}</span>
        <textarea
          rows={2}
          value={draft.description}
          onChange={(event) =>
            setShotDraft((prev) =>
              prev ? { ...prev, description: event.target.value } : prev,
            )
          }
        />
      </label>
      <label>
        <span>{t("project.shot.field.dialogue")}</span>
        <textarea
          rows={2}
          value={draft.dialogue}
          onChange={(event) =>
            setShotDraft((prev) =>
              prev ? { ...prev, dialogue: event.target.value } : prev,
            )
          }
        />
      </label>
      <div className="project-shot-form-row">
        <span>{t("project.shot.field.status")}</span>
        <select
          className="project-shot-form-select"
          value={draft.status}
          onChange={(event) =>
            setShotDraft((prev) =>
              prev ? { ...prev, status: event.target.value } : prev,
            )
          }
        >
          {SHOT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(shotStatusKey(status))}
            </option>
          ))}
        </select>
        <span>{t("project.shot.field.camera")}</span>
        <input
          className="project-shot-form-input"
          value={draft.camera}
          placeholder={t("project.shot.field.cameraPlaceholder")}
          onChange={(event) =>
            setShotDraft((prev) =>
              prev ? { ...prev, camera: event.target.value } : prev,
            )
          }
        />
        <span>{t("project.shot.field.duration")}</span>
        <input
          className="project-shot-form-input project-shot-form-duration"
          value={draft.duration}
          placeholder="8s"
          onChange={(event) =>
            setShotDraft((prev) =>
              prev ? { ...prev, duration: event.target.value } : prev,
            )
          }
        />
      </div>
    </>
  );

  const shotFormFoot = (draft: ShotDraft) => (
    <div className="project-scene-form-foot">
      <span className="project-title-spacer" />
      <button type="button" className="project-dialog-btn" onClick={() => setShotDraft(null)}>
        {t("common.cancel")}
      </button>
      <button
        type="button"
        className="project-dialog-btn primary"
        onClick={() => {
          setShotDraft(null);
          void saveShot({
            id: draft.isNew ? undefined : draft.id,
            sceneId: draft.sceneId,
            description: draft.description,
            dialogue: draft.dialogue,
            status: draft.status,
            camera: draft.camera,
            duration: draft.duration,
          });
        }}
      >
        {t("common.save")}
      </button>
    </div>
  );

  const handleTogglePick = (id: string) => {
    if (!pickShot || !pick) return;
    if (pick.kind === "characters") {
      const next = pickShot.character_ids.includes(id)
        ? pickShot.character_ids.filter((x) => x !== id)
        : [...pickShot.character_ids, id];
      void setShotCharacters(pickShot.id, next);
    } else {
      const next = pickShot.prop_ids.includes(id)
        ? pickShot.prop_ids.filter((x) => x !== id)
        : [...pickShot.prop_ids, id];
      void setShotProps(pickShot.id, next);
    }
  };

  return (
    <div className="project-scene-board">
      {scenes.length === 0 && !sceneDraft && (
        <div className="project-scenes-empty">
          {Icons.empty}
          <p>{t("project.scene.empty")}</p>
        </div>
      )}
      {scenes.map((scene, sceneIndex) => (
        <section key={scene.id} className="project-scene-card">
          {sceneDraft?.id === scene.id ? (
            <div className="project-scene-form">
              <label>
                <span>{t("project.scene.field.heading")}</span>
                <input
                  value={sceneDraft.heading}
                  placeholder={t("project.scene.field.headingPlaceholder")}
                  onChange={(event) =>
                    setSceneDraft((prev) => (prev ? { ...prev, heading: event.target.value } : prev))
                  }
                  autoFocus
                />
              </label>
              <label>
                <span>{t("project.scene.field.location")}</span>
                <select
                  value={sceneDraft.locationId}
                  onChange={(event) =>
                    setSceneDraft((prev) =>
                      prev ? { ...prev, locationId: event.target.value } : prev,
                    )
                  }
                >
                  <option value="">{t("project.scene.field.freeLocation")}</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="project-scene-form-foot">
                <span className="project-title-spacer" />
                <button type="button" className="project-dialog-btn" onClick={() => setSceneDraft(null)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="project-dialog-btn primary"
                  onClick={() => {
                    const draft = sceneDraft;
                    setSceneDraft(null);
                    if (draft) {
                      void saveScene({
                        id: draft.id,
                        episodeId,
                        heading: draft.heading.trim(),
                        locationId: draft.locationId,
                        note: "",
                      });
                    }
                  }}
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
          ) : (
            <header className="project-scene-head">
              <span className="project-scene-no">{sceneIndex + 1}</span>
              <span className="project-scene-heading" title={scene.heading}>
                {scene.heading || t("project.scene.untitled")}
              </span>
              {scene.location && (
                <span className="project-scene-location" title={scene.location.name}>
                  {Icons.resources}
                  {scene.location.name}
                  {locationSubtitleParts(scene.location.int_ext, scene.location.time_hint).length > 0 && (
                    <em>
                      {locationSubtitleParts(scene.location.int_ext, scene.location.time_hint)
                        .map((part) =>
                          t(
                            part === scene.location?.int_ext
                              ? intExtLabelKey(part)
                              : timeHintLabelKey(part),
                          ),
                        )
                        .join("/")}
                    </em>
                  )}
                </span>
              )}
              <span className="project-title-spacer" />
              <button
                type="button"
                className="project-mini-btn"
                title={t("project.scene.moveUp")}
                disabled={sceneIndex === 0}
                onClick={() => void moveScene(scene.id, -1)}
              >
                {Icons.chevronUp}
              </button>
              <button
                type="button"
                className="project-mini-btn"
                title={t("project.scene.moveDown")}
                disabled={sceneIndex === scenes.length - 1}
                onClick={() => void moveScene(scene.id, 1)}
              >
                {Icons.chevronDown}
              </button>
              <button
                type="button"
                className="project-mini-btn"
                title={t("common.edit")}
                onClick={() =>
                  setSceneDraft({ id: scene.id, heading: scene.heading, locationId: scene.location_id })
                }
              >
                {Icons.edit}
              </button>
              <button
                type="button"
                className="project-mini-btn"
                title={t("common.delete")}
                onClick={() => setDeleteSceneTarget(scene)}
              >
                {Icons.delete}
              </button>
            </header>
          )}

          <div className="project-shot-list">
            {scene.shots.map((shot, shotIndex) =>
              shotDraft?.id === shot.id ? (
                <div key={shot.id} className="project-shot-form">
                  {shotFieldRows(shotDraft)}
                  <div className="project-shot-form-row">
                    <span>{t("project.shot.field.cast")}</span>
                    <span className="project-shot-form-chips">
                      {shot.character_ids.map((cid) => {
                        const character = characters.find((c) => c.id === cid);
                        if (!character) return null;
                        return (
                          <span key={cid} className="project-shot-chip">
                            {character.name}
                          </span>
                        );
                      })}
                      <button
                        type="button"
                        className="project-shot-chip-add"
                        onClick={() => setPick({ shotId: shot.id, kind: "characters" })}
                      >
                        {Icons.add}
                      </button>
                    </span>
                  </div>
                  <div className="project-shot-form-row">
                    <span>{t("project.shot.field.props")}</span>
                    <span className="project-shot-form-chips">
                      {shot.prop_ids.map((pid) => {
                        const prop = props.find((p) => p.id === pid);
                        if (!prop) return null;
                        return (
                          <span key={pid} className="project-shot-chip">
                            {prop.name}
                          </span>
                        );
                      })}
                      <button
                        type="button"
                        className="project-shot-chip-add"
                        onClick={() => setPick({ shotId: shot.id, kind: "props" })}
                      >
                        {Icons.add}
                      </button>
                    </span>
                  </div>
                  {shotFormFoot(shotDraft)}
                </div>
              ) : (
                <div key={shot.id} className="project-shot-row">
                  <span className="project-shot-no">{shotIndex + 1}</span>
                  <div className="project-shot-main">
                    <b>
                      {shot.description || t("project.shot.untitled")}
                      {shot.status !== "none" && (
                        <span className={`project-shot-status s-${shotStatusKey(shot.status).split(".").pop()}`}>
                          {t(shotStatusKey(shot.status))}
                        </span>
                      )}
                    </b>
                    <i>
                      {[shot.camera, shot.duration].filter(Boolean).join(" · ")}
                      {shot.dialogue && (shot.camera || shot.duration ? " — " : "") + shot.dialogue}
                    </i>
                    {shot.assets.length > 0 && (
                    <span className="project-shot-cast">
                      {shot.assets.map((asset) => (
                        <span
                          key={asset.id}
                          className={`project-shot-asset${asset.missing ? " is-missing" : ""}`}
                          title={
                            asset.missing
                              ? `${t("project.asset.fileMissing")} · ${asset.file_path}`
                              : asset.file_path
                          }
                          onClick={() => setSheetAsset(asset)}
                        >
                          {asset.name || asset.file_path}
                          {asset.missing && (
                            <i className="project-shot-asset-flag">
                              {t("project.asset.fileMissing")}
                            </i>
                          )}
                          <button
                            type="button"
                            className="project-shot-asset-x"
                            title={t("project.asset.unlink")}
                            onClick={(event) => {
                              event.stopPropagation();
                              void unlinkAsset(asset.id);
                            }}
                          >
                            {Icons.close}
                          </button>
                        </span>
                      ))}
                    </span>
                  )}
                  {(shot.character_ids.length > 0 || shot.prop_ids.length > 0) && (
                      <span className="project-shot-cast">
                        {shot.character_ids.map((cid) => {
                          const character = characters.find((c) => c.id === cid);
                          return character ? (
                            <span
                              key={cid}
                              className={`project-avatar project-avatar-p${characterAvatarPaletteIndex(character.name)} project-avatar-mini`}
                              title={character.name}
                            >
                              {character.avatar_path ? character.name : characterAvatarInitial(character.name)}
                            </span>
                          ) : null;
                        })}
                        {shot.prop_ids.map((pid) => {
                          const prop = props.find((p) => p.id === pid);
                          return prop ? (
                            <span key={pid} className="project-shot-prop" title={prop.name}>
                              {Icons.star}
                              {prop.name}
                            </span>
                          ) : null;
                        })}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="project-mini-btn"
                    title={t("project.shot.moveUp")}
                    disabled={shotIndex === 0}
                    onClick={() => void moveShot(shot.id, -1)}
                  >
                    {Icons.chevronUp}
                  </button>
                  <button
                    type="button"
                    className="project-mini-btn"
                    title={t("project.shot.moveDown")}
                    disabled={shotIndex === scene.shots.length - 1}
                    onClick={() => void moveShot(shot.id, 1)}
                  >
                    {Icons.chevronDown}
                  </button>
                  <button
                    type="button"
                    className="project-mini-btn"
                    title={t("project.asset.link")}
                    onClick={() => setAssetPickerShotId(shot.id)}
                  >
                    {Icons.file}
                  </button>
                  <button
                    type="button"
                    className="project-mini-btn"
                    title={t("common.edit")}
                    onClick={() =>
                      setShotDraft({
                        id: shot.id,
                        isNew: false,
                        sceneId: shot.scene_id,
                        description: shot.description,
                        dialogue: shot.dialogue,
                        status: shot.status,
                        camera: shot.camera,
                        duration: shot.duration,
                      })
                    }
                  >
                    {Icons.edit}
                  </button>
                  <button
                    type="button"
                    className="project-mini-btn"
                    title={t("common.delete")}
                    onClick={() => setDeleteShotTarget(shot)}
                  >
                    {Icons.delete}
                  </button>
                </div>
              ),
            )}
            {shotDraft?.isNew && shotDraft.sceneId === scene.id && (
              <div className="project-shot-form">
                {shotFieldRows(shotDraft)}
                {shotFormFoot(shotDraft)}
              </div>
            )}
            <button
              type="button"
              className="project-shot-new"
              onClick={() =>
                setShotDraft({ id: `new-${scene.id}`, isNew: true, sceneId: scene.id, description: "", dialogue: "", status: "none", camera: "", duration: "" })
              }
            >
              {Icons.add}
              {t("project.shot.new")}
            </button>
          </div>
        </section>
      ))}

      {sceneDraft && !sceneDraft.id ? (
        <section className="project-scene-card">
          <div className="project-scene-form">
            <label>
              <span>{t("project.scene.field.heading")}</span>
              <input
                value={sceneDraft.heading}
                placeholder={t("project.scene.field.headingPlaceholder")}
                onChange={(event) =>
                  setSceneDraft((prev) => (prev ? { ...prev, heading: event.target.value } : prev))
                }
                autoFocus
              />
            </label>
            <label>
              <span>{t("project.scene.field.location")}</span>
              <select
                value={sceneDraft.locationId}
                onChange={(event) =>
                  setSceneDraft((prev) => (prev ? { ...prev, locationId: event.target.value } : prev))
                }
              >
                <option value="">{t("project.scene.field.freeLocation")}</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="project-scene-form-foot">
              <span className="project-title-spacer" />
              <button type="button" className="project-dialog-btn" onClick={() => setSceneDraft(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="project-dialog-btn primary"
                onClick={() => {
                  const draft = sceneDraft;
                  setSceneDraft(null);
                  if (draft) {
                    void saveScene({
                      episodeId,
                      heading: draft.heading.trim(),
                      locationId: draft.locationId,
                      note: "",
                    });
                  }
                }}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <button
          type="button"
          className="project-scene-new"
          onClick={() => setSceneDraft({ heading: "", locationId: "" })}
        >
          {Icons.add}
          {t("project.scene.new")}
        </button>
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

      {pick && pickShot && (
        <ProjectLibraryPanel
          kind={pick.kind}
          mode="pick"
          multi
          selectedIds={pick.kind === "characters" ? pickShot.character_ids : pickShot.prop_ids}
          onTogglePick={handleTogglePick}
          onClose={() => setPick(null)}
          pickTitle={
            pick.kind === "characters"
              ? t("project.shot.pickCastTitle")
              : t("project.shot.pickPropsTitle")
          }
        />
      )}

      {deleteSceneTarget && (
        <ConfirmDialog
          message={t("project.scene.deleteConfirm", {
            heading: deleteSceneTarget.heading || t("project.scene.untitled"),
          })}
          onConfirm={() => {
            const target = deleteSceneTarget;
            setDeleteSceneTarget(null);
            void deleteScene(target.id);
          }}
          onCancel={() => setDeleteSceneTarget(null)}
        />
      )}
      {deleteShotTarget && (
        <ConfirmDialog
          message={t("project.shot.deleteConfirm")}
          onConfirm={() => {
            const target = deleteShotTarget;
            setDeleteShotTarget(null);
            void deleteShot(target.id);
          }}
          onCancel={() => setDeleteShotTarget(null)}
        />
      )}
    </div>
  );
}
