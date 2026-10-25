import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  useProjectStore,
  type ProjectCharacter,
  type ProjectLocation,
  type ProjectProp,
} from "../../stores/projectStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ResourceImage } from "./ResourceMedia";
import { Icons } from "../../components/Icons";
import {
  parseCharacterReferences,
  serializeCharacterReferences,
  LIBRARY_INT_EXTS,
  LIBRARY_TIME_HINTS,
  characterAvatarInitial,
  characterAvatarPaletteIndex,
  intExtLabelKey,
  joinLibraryPath,
  locationSubtitleParts,
  timeHintLabelKey,
  type LibraryKind,
} from "../../domain/projectView";

interface CharacterDraft {
  id?: string;
  name: string;
  role_tag: string;
  bio: string;
  prompt: string;
  avatar_path: string;
  references: string[];
}

interface LocationDraft {
  id?: string;
  name: string;
  int_ext: string;
  time_hint: string;
  bio: string;
  prompt: string;
  ref_path: string;
}

interface PropDraft {
  id?: string;
  name: string;
  bio: string;
  prompt: string;
  ref_path: string;
}

export interface ProjectLibraryPanelProps {
  kind: LibraryKind;
  mode: "browse" | "pick";
  onClose: () => void;
  /** pick 模式：面板标题（如「关联角色 · 第 02 集」）。 */
  pickTitle?: string;
  /** pick 模式：已关联的实体 id（显示「已关联」不可再选）。 */
  linkedIds?: string[];
  /** pick 模式：选中未关联实体后的回调。 */
  onPick?: (id: string) => void;
  /** 多选挑选模式：点选切换并集而不关闭面板（镜头出镜/道具用）。 */
  multi?: boolean;
  /** 多选模式：当前已选集合（显示「已选」标记，可点选取消）。 */
  selectedIds?: string[];
  /** 多选模式：点选切换回调。 */
  onTogglePick?: (id: string) => void;
}

const EMPTY_CHARACTER: CharacterDraft = { name: "", role_tag: "", bio: "", prompt: "", avatar_path: "", references: [] };
const EMPTY_LOCATION: LocationDraft = { name: "", int_ext: "", time_hint: "", bio: "", prompt: "", ref_path: "" };
const EMPTY_PROP: PropDraft = { name: "", bio: "", prompt: "", ref_path: "" };

/** 全局三库面板（角色/场景/道具）：browse 模式浏览与维护；pick 模式
 *  供集工作台挑选关联（单选即选即关，multi 多选点选切换）。场景与
 *  道具的参考图、角色的形象图在列表内图文同屏。 */
export default function ProjectLibraryPanel({
  kind,
  mode,
  onClose,
  pickTitle,
  linkedIds,
  onPick,
  multi,
  selectedIds,
  onTogglePick,
}: ProjectLibraryPanelProps) {
  const { t } = useTranslation();
  const store = useProjectStore(
    useShallow((state) => ({
      characters: state.characters,
      locations: state.locations,
      props: state.props,
      loadCharacters: state.loadCharacters,
      saveCharacter: state.saveCharacter,
      deleteCharacter: state.deleteCharacter,
      loadLocations: state.loadLocations,
      saveLocation: state.saveLocation,
      deleteLocation: state.deleteLocation,
      loadProps: state.loadProps,
      saveProp: state.saveProp,
      deleteProp: state.deleteProp,
    })),
  );

  const [libraryRoot, setLibraryRoot] = useState("");
  const [characterDraft, setCharacterDraft] = useState<CharacterDraft | null>(null);
  const [locationDraft, setLocationDraft] = useState<LocationDraft | null>(null);
  const [propDraft, setPropDraft] = useState<PropDraft | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const [characterRefInput, setCharacterRefInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_resource_library_path")
      .then((path) => {
        if (!cancelled) setLibraryRoot(path);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const { loadCharacters, loadLocations, loadProps } = store;

  // 面板打开即拉取当前库列表（browse 与 pick 两种模式都需要）。
  useEffect(() => {
    if (kind === "characters") void loadCharacters();
    else if (kind === "locations") void loadLocations();
    else void loadProps();
  }, [kind, loadCharacters, loadLocations, loadProps]);

  const draft = kind === "characters" ? characterDraft : kind === "locations" ? locationDraft : propDraft;
  const closeDraft = () => {
    setCharacterDraft(null);
    setLocationDraft(null);
    setPropDraft(null);
  };

  const marked = useMemo(
    () => new Set((multi ? selectedIds : linkedIds) ?? []),
    [multi, selectedIds, linkedIds],
  );

  const handleSave = async () => {
    if (kind === "characters" && characterDraft) {
      if (!characterDraft.name.trim()) return;
      const ok = await store.saveCharacter({
        ...characterDraft,
        reference_paths: serializeCharacterReferences(characterDraft.references),
      });
      if (ok) setCharacterDraft(null);
    } else if (kind === "locations" && locationDraft) {
      if (!locationDraft.name.trim()) return;
      const ok = await store.saveLocation(locationDraft);
      if (ok) setLocationDraft(null);
    } else if (kind === "props" && propDraft) {
      if (!propDraft.name.trim()) return;
      const ok = await store.saveProp(propDraft);
      if (ok) setPropDraft(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (kind === "characters") await store.deleteCharacter(id);
    else if (kind === "locations") await store.deleteLocation(id);
    else await store.deleteProp(id);
  };

  const titleKey = `project.library.${kind}`;
  const items =
    kind === "characters"
      ? store.characters.map((c) => ({ id: c.id, name: c.name, entity: c as unknown }))
      : kind === "locations"
        ? store.locations.map((l) => ({ id: l.id, name: l.name, entity: l as unknown }))
        : store.props.map((p) => ({ id: p.id, name: p.name, entity: p as unknown }));

  const mediaPath =
    kind === "characters"
      ? (characterDraft?.avatar_path ?? "")
      : kind === "locations"
        ? (locationDraft?.ref_path ?? "")
        : (propDraft?.ref_path ?? "");

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
            {mode === "pick" ? (pickTitle ?? t(titleKey)) : t(titleKey)}
            <span className="project-library-count">{items.length}</span>
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

        <div className="project-library-body">
          {items.length === 0 && !draft && (
            <div className="project-library-empty">
              {Icons.empty}
              <p>{t("project.library.empty", { kind: t(titleKey) })}</p>
            </div>
          )}
          {items.map(({ id, name, entity }) => {
            const isMarked = mode === "pick" && marked.has(id);
            const handleClick =
              mode === "pick"
                ? multi
                  ? () => onTogglePick?.(id)
                  : isMarked
                    ? undefined
                    : () => onPick?.(id)
                : undefined;
            return (
              <div
                key={id}
                className={`project-library-card${handleClick ? " pick" : ""}`}
                onClick={handleClick}
              >
                {kind === "characters" ? (
                  <CharacterVisual
                    character={entity as ProjectCharacter}
                    libraryRoot={libraryRoot}
                    t={t}
                  />
                ) : (
                  <RefVisual
                    refPath={
                      kind === "locations"
                        ? (entity as ProjectLocation).ref_path
                        : (entity as ProjectProp).ref_path
                    }
                    version={
                      kind === "locations"
                        ? (entity as ProjectLocation).updated_at
                        : (entity as ProjectProp).updated_at
                    }
                    libraryRoot={libraryRoot}
                    icon={kind === "locations" ? Icons.resources : Icons.star}
                  />
                )}
                <div className="project-library-main">
                  <b>
                    {name}
                    {kind === "characters" && (entity as ProjectCharacter).role_tag
                      ? ` · ${(entity as ProjectCharacter).role_tag}`
                      : ""}
                    {kind === "characters" &&
                      parseCharacterReferences((entity as ProjectCharacter).reference_paths).length > 0 && (
                        <span className="project-prompt-cat">
                          {t("project.library.refCount", {
                            count: parseCharacterReferences((entity as ProjectCharacter).reference_paths).length,
                          })}
                        </span>
                      )}
                  </b>
                  <i>
                    {kind === "characters"
                      ? characterLibraryNote(entity as ProjectCharacter, t)
                      : kind === "locations"
                        ? locationLibraryNote(entity as ProjectLocation, t)
                        : propLibraryNote(entity as ProjectProp)}
                  </i>
                </div>
                {mode === "pick" ? (
                  <span className={`project-library-tag${isMarked ? " linked" : ""}`}>
                    {isMarked
                      ? t(multi ? "project.library.selected" : "project.library.linked")
                      : t("project.library.pick")}
                  </span>
                ) : (
                  <span className="project-library-actions">
                    <button
                      type="button"
                      className="project-mini-btn"
                      title={t("common.edit")}
                      onClick={() => {
                        if (kind === "characters") {
                          const c = entity as ProjectCharacter;
                          setCharacterDraft({
                            id: c.id,
                            name: c.name,
                            role_tag: c.role_tag,
                            bio: c.bio,
                            prompt: c.prompt,
                            avatar_path: c.avatar_path,
                            references: parseCharacterReferences(c.reference_paths),
                          });
                        } else if (kind === "locations") {
                          const l = entity as ProjectLocation;
                          setLocationDraft({
                            id: l.id,
                            name: l.name,
                            int_ext: l.int_ext,
                            time_hint: l.time_hint,
                            bio: l.bio,
                            prompt: l.prompt,
                            ref_path: l.ref_path,
                          });
                        } else {
                          const p = entity as ProjectProp;
                          setPropDraft({
                            id: p.id,
                            name: p.name,
                            bio: p.bio,
                            prompt: p.prompt,
                            ref_path: p.ref_path,
                          });
                        }
                      }}
                    >
                      {Icons.edit}
                    </button>
                    <button
                      type="button"
                      className="project-mini-btn"
                      title={t("common.delete")}
                      onClick={() => setDeleteConfirm({ id, name })}
                    >
                      {Icons.delete}
                    </button>
                  </span>
                )}
              </div>
            );
          })}

          {mode === "browse" &&
            (draft ? (
              <div className="project-library-form">
                <div className="project-library-form-title">
                  {t(kind === "characters" ? "project.library.editCharacter" : kind === "locations" ? "project.library.editLocation" : "project.library.editProp")}
                </div>
                <div className="project-form-row two">
                  <label>
                    <span>{t("project.library.field.name")}</span>
                    <input
                      value={draft.name}
                      onChange={(event) =>
                        updateDraft(kind, setCharacterDraft, setLocationDraft, setPropDraft, {
                          name: event.target.value,
                        })
                      }
                      autoFocus
                    />
                  </label>
                  {kind === "characters" && (
                    <label>
                      <span>{t("project.library.field.roleTag")}</span>
                      <input
                        value={characterDraft?.role_tag ?? ""}
                        onChange={(event) =>
                          setCharacterDraft((prev) =>
                            prev ? { ...prev, role_tag: event.target.value } : prev,
                          )
                        }
                      />
                    </label>
                  )}
                  {kind === "locations" && (
                    <>
                      <label>
                        <span>{t("project.library.field.intExt")}</span>
                        <select
                          value={locationDraft?.int_ext ?? ""}
                          onChange={(event) =>
                            setLocationDraft((prev) =>
                              prev ? { ...prev, int_ext: event.target.value } : prev,
                            )
                          }
                        >
                          <option value="">{t("project.library.intExt.unset")}</option>
                          {LIBRARY_INT_EXTS.map((value) => (
                            <option key={value} value={value}>
                              {t(intExtLabelKey(value))}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>{t("project.library.field.timeHint")}</span>
                        <select
                          value={locationDraft?.time_hint ?? ""}
                          onChange={(event) =>
                            setLocationDraft((prev) =>
                              prev ? { ...prev, time_hint: event.target.value } : prev,
                            )
                          }
                        >
                          <option value="">{t("project.library.timeHint.unset")}</option>
                          {LIBRARY_TIME_HINTS.map((value) => (
                            <option key={value} value={value}>
                              {t(timeHintLabelKey(value))}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                <div className="project-form-row">
                  <label>
                    <span>{t(kind === "characters" ? "project.library.field.bio" : "project.library.field.bioScene")}</span>
                    <textarea
                      rows={2}
                      value={kind === "characters" ? characterDraft?.bio ?? "" : kind === "locations" ? locationDraft?.bio ?? "" : propDraft?.bio ?? ""}
                      onChange={(event) =>
                        updateDraft(kind, setCharacterDraft, setLocationDraft, setPropDraft, {
                          bio: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <div className="project-form-row">
                  <label>
                    <span>{t("project.library.field.prompt")}</span>
                    <textarea
                      rows={2}
                      value={kind === "characters" ? characterDraft?.prompt ?? "" : kind === "locations" ? locationDraft?.prompt ?? "" : propDraft?.prompt ?? ""}
                      onChange={(event) =>
                        updateDraft(kind, setCharacterDraft, setLocationDraft, setPropDraft, {
                          prompt: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <div className="project-form-row media">
                  <label>
                    <span>
                      {t(
                        kind === "characters"
                          ? "project.library.field.avatarPath"
                          : "project.library.field.refPath",
                      )}
                    </span>
                    <input
                      placeholder={t("project.library.field.pathPlaceholder")}
                      value={mediaPath}
                      onChange={(event) =>
                        updateDraft(kind, setCharacterDraft, setLocationDraft, setPropDraft, kind === "characters"
                          ? { avatar_path: event.target.value }
                          : { ref_path: event.target.value })
                      }
                    />
                  </label>
                  {mediaPath.trim() && (
                    <div className="project-library-preview">
                      <ResourceImage
                        path={joinLibraryPath(libraryRoot, mediaPath.trim())}
                        alt=""
                        className="project-library-preview-img"
                      />
                    </div>
                  )}
                </div>
                {kind === "characters" && characterDraft && (
                  <div className="project-form-row">
                    <label>
                      <span>{t("project.library.field.references")}</span>
                      <input
                        placeholder={t("project.library.field.refAddPlaceholder")}
                        value={characterRefInput}
                        onChange={(event) => setCharacterRefInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            const path = characterRefInput.trim();
                            if (!path) return;
                            setCharacterDraft({
                              ...characterDraft,
                              references: [...characterDraft.references, path],
                            });
                            setCharacterRefInput("");
                          }
                        }}
                      />
                    </label>
                    {characterDraft.references.length > 0 && (
                      <div className="project-ref-list">
                        {characterDraft.references.map((refPath, index) => (
                          <div key={`${refPath}-${index}`} className="project-ref-item">
                            <span className="project-ref-thumb">
                              <ResourceImage
                                path={joinLibraryPath(libraryRoot, refPath)}
                                alt=""
                                className="project-ref-thumb-img"
                              />
                            </span>
                            <span className="project-ref-path" title={refPath}>
                              {refPath}
                            </span>
                            <button
                              type="button"
                              className="project-mini-btn"
                              title={t("common.delete")}
                              onClick={() =>
                                setCharacterDraft({
                                  ...characterDraft,
                                  references: characterDraft.references.filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                })
                              }
                            >
                              {Icons.close}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="project-library-form-foot">
                  <span className="project-library-form-hint">
                    {t("project.library.pathHint")}
                  </span>
                  <span className="project-title-spacer" />
                  <button type="button" className="project-dialog-btn" onClick={closeDraft}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="project-dialog-btn primary"
                    disabled={!draft.name.trim()}
                    onClick={() => void handleSave()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="project-library-new"
                onClick={() => {
                  if (kind === "characters") setCharacterDraft({ ...EMPTY_CHARACTER });
                  else if (kind === "locations") setLocationDraft({ ...EMPTY_LOCATION });
                  else setPropDraft({ ...EMPTY_PROP });
                }}
              >
                {Icons.add}
                {t(kind === "characters" ? "project.library.newCharacter" : kind === "locations" ? "project.library.newLocation" : "project.library.newProp")}
              </button>
            ))}
        </div>
      </div>

      {deleteConfirm && (
        <ConfirmDialog
          message={t("project.library.deleteConfirm", { name: deleteConfirm.name })}
          onConfirm={() => {
            const target = deleteConfirm;
            setDeleteConfirm(null);
            void handleDelete(target.id);
          }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}

function updateDraft(
  kind: LibraryKind,
  setCharacterDraft: React.Dispatch<React.SetStateAction<CharacterDraft | null>>,
  setLocationDraft: React.Dispatch<React.SetStateAction<LocationDraft | null>>,
  setPropDraft: React.Dispatch<React.SetStateAction<PropDraft | null>>,
  patch: Partial<CharacterDraft & LocationDraft & PropDraft>,
) {
  if (kind === "characters") {
    setCharacterDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  } else if (kind === "locations") {
    setLocationDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  } else {
    setPropDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }
}

function characterLibraryNote(character: ProjectCharacter, t: (key: string, options?: Record<string, unknown>) => string): string {
  const count = character.episode_ref_count ?? 0;
  const refs = count > 0 ? t("project.library.episodeRefs", { count }) : t("project.library.unlinked");
  return character.bio ? `${character.bio} · ${refs}` : refs;
}

function locationLibraryNote(location: ProjectLocation, t: (key: string, options?: Record<string, unknown>) => string): string {
  const parts = locationSubtitleParts(location.int_ext, location.time_hint);
  const label = parts
    .map((part) =>
      t((LIBRARY_INT_EXTS as readonly string[]).includes(part) ? intExtLabelKey(part) : timeHintLabelKey(part)),
    )
    .join(" · ");
  const bio = location.bio ? (label ? `${label} · ${location.bio}` : location.bio) : label;
  return bio || t("project.library.noDescription");
}

function propLibraryNote(prop: ProjectProp): string {
  return prop.bio || "";
}

function CharacterVisual({
  character,
  libraryRoot,
  t,
}: {
  character: ProjectCharacter;
  libraryRoot: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const avatarPath = character.avatar_path ? joinLibraryPath(libraryRoot, character.avatar_path) : "";
  return (
    <span
      className={`project-avatar project-avatar-p${characterAvatarPaletteIndex(character.name)}`}
      aria-label={t("project.cast.title")}
    >
      {avatarPath ? (
        <ResourceImage
          path={avatarPath}
          alt={character.name}
          className="project-avatar-img"
          version={character.updated_at}
        />
      ) : (
        characterAvatarInitial(character.name)
      )}
    </span>
  );
}

function RefVisual({
  refPath,
  libraryRoot,
  icon,
  version,
}: {
  refPath: string;
  libraryRoot: string;
  icon: React.ReactNode;
  version: string;
}) {
  const absolute = refPath ? joinLibraryPath(libraryRoot, refPath) : "";
  return (
    <span className="project-library-thumb">
      {absolute ? (
        <ResourceImage
          path={absolute}
          alt=""
          className="project-library-thumb-img"
          version={version}
        />
      ) : (
        icon
      )}
    </span>
  );
}
