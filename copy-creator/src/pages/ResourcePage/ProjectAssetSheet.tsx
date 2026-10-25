import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore, type ProjectAsset } from "../../stores/projectStore";
import { ResourceImage } from "./ResourceMedia";
import { Icons } from "../../components/Icons";
import { openResourceFile, revealResourceFile } from "../../domain/mediaAssets";
import {
  AUDIO_ROLES,
  assetKindLabelKey,
  audioRoleKey,
  joinLibraryPath,
  projectFileDisplayName,
} from "../../domain/projectView";

export interface ProjectAssetSheetProps {
  asset: ProjectAsset;
  onClose: () => void;
}

/** 素材详情浮层：预览 + 溯源链编辑（由哪条提示词/哪个源素材生成）+
 *  打开/在文件管理器显示/跳转文件视图分组。 */
export default function ProjectAssetSheet({ asset, onClose }: ProjectAssetSheetProps) {
  const { t } = useTranslation();
  const {
    prompts,
    loadPrompts,
    overview,
    updateAsset,
    unlinkAsset,
    locateInFileView,
  } = useProjectStore(
    useShallow((state) => ({
      prompts: state.prompts,
      loadPrompts: state.loadPrompts,
      overview: state.overview,
      updateAsset: state.updateAsset,
      unlinkAsset: state.unlinkAsset,
      locateInFileView: state.locateInFileView,
    })),
  );

  const [root, setRoot] = useState("");
  const [genFromPrompt, setGenFromPrompt] = useState(asset.gen_from_prompt);
  const [genFromAsset, setGenFromAsset] = useState(asset.gen_from_asset);
  const [genParams, setGenParams] = useState(asset.gen_params);
  const [audioRole, setAudioRole] = useState(asset.audio_role);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_resource_library_path")
      .then((path) => {
        if (!cancelled) setRoot(path);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (prompts.length === 0) void loadPrompts();
  }, [prompts.length, loadPrompts]);

  // 溯源源素材候选：本集全部素材（排除自身），供「由哪张图生成」选择。
  const siblingAssets = (overview?.loose_assets ?? []).concat(
    (overview?.scenes ?? []).flatMap((scene) => scene.shots.flatMap((shot) => shot.assets)),
  );

  const displayName = projectFileDisplayName(asset.name, asset.file_path);
  const absolutePath = joinLibraryPath(root, asset.file_path);
  const groupLabel = asset.file_path.split("/")[0] || "";

  // 溯源标记是软引用：指向的提示词/素材被删除后值仍保留，下拉列表里
  // 已无对应选项，此时显示「已失效」占位而不是静默丢值。
  const staleFromPrompt =
    genFromPrompt !== "" && !prompts.some((prompt) => prompt.id === genFromPrompt);
  const staleFromAsset =
    genFromAsset !== "" && !siblingAssets.some((candidate) => candidate.id === genFromAsset);

  const dirty =
    genFromPrompt !== asset.gen_from_prompt ||
    genFromAsset !== asset.gen_from_asset ||
    genParams !== asset.gen_params ||
    audioRole !== asset.audio_role;

  return (
    <div
      className="project-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="project-dialog project-library-panel">
        <div className="project-dialog-head">
          <h4 title={displayName}>{displayName}</h4>
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
          {asset.kind === "image" && (
            <div className="project-sheet-preview">
              <ResourceImage path={absolutePath} alt={displayName} className="project-sheet-img" />
            </div>
          )}

          <div className="project-sheet-meta">
            <div className="project-sheet-kv">
              <b>{t("project.sheet.kind")}</b>
              <span>{t(assetKindLabelKey(asset.kind))}</span>
            </div>
            <div className="project-sheet-kv">
              <b>{t("project.sheet.path")}</b>
              <span title={asset.file_path}>{asset.file_path}</span>
            </div>
            {groupLabel && (
              <div className="project-sheet-kv">
                <b>{t("project.sheet.group")}</b>
                <span>{groupLabel}</span>
              </div>
            )}
          </div>

          <div className="project-library-form">
            <div className="project-library-form-title">{t("project.sheet.traceTitle")}</div>
            <div className="project-form-row">
              <label>
                <span>{t("project.sheet.fromPrompt")}</span>
                <select
                  value={genFromPrompt}
                  onChange={(event) => setGenFromPrompt(event.target.value)}
                >
                  <option value="">{t("project.sheet.none")}</option>
                  {staleFromPrompt && (
                    <option value={genFromPrompt} disabled>
                      {t("project.sheet.staleRef")}
                    </option>
                  )}
                  {prompts.map((prompt) => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="project-form-row">
              <label>
                <span>{t("project.sheet.genParams")}</span>
                <input
                  value={genParams}
                  placeholder={t("project.sheet.genParamsPlaceholder")}
                  onChange={(event) => setGenParams(event.target.value)}
                />
              </label>
            </div>
            {asset.kind === "audio" && (
              <div className="project-form-row">
                <label>
                  <span>{t("project.sheet.audioRole")}</span>
                  <select value={audioRole} onChange={(event) => setAudioRole(event.target.value)}>
                    <option value="">{t("project.sheet.audioRoleNone")}</option>
                    {AUDIO_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(audioRoleKey(role))}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <div className="project-form-row">
              <label>
                <span>{t("project.sheet.fromAsset")}</span>
                <select
                  value={genFromAsset}
                  onChange={(event) => setGenFromAsset(event.target.value)}
                >
                  <option value="">{t("project.sheet.none")}</option>
                  {staleFromAsset && (
                    <option value={genFromAsset} disabled>
                      {t("project.sheet.staleRef")}
                    </option>
                  )}
                  {siblingAssets
                    .filter((candidate) => candidate.id !== asset.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {projectFileDisplayName(candidate.name, candidate.file_path)}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </div>
        </div>

        <div className="project-dialog-foot">
          <button
            type="button"
            className="project-dialog-btn"
            onClick={() => void openResourceFile(absolutePath)}
          >
            {t("project.sheet.open")}
          </button>
          <button
            type="button"
            className="project-dialog-btn"
            onClick={() => void revealResourceFile(absolutePath)}
          >
            {t("project.sheet.reveal")}
          </button>
          <button
            type="button"
            className="project-dialog-btn"
            onClick={() => {
              locateInFileView(asset.file_path);
              onClose();
            }}
          >
            {t("project.sheet.locate")}
          </button>
          <span className="project-title-spacer" />
          <button
            type="button"
            className="project-dialog-btn danger"
            onClick={() => {
              void unlinkAsset(asset.id);
              onClose();
            }}
          >
            {t("project.asset.unlink")}
          </button>
          <button
            type="button"
            className="project-dialog-btn primary"
            disabled={!dirty}
            onClick={() => {
              void updateAsset({
                id: asset.id,
                kind: asset.kind,
                name: asset.name,
                episodeId: asset.episode_id,
                shotId: asset.shot_id,
                genFromAsset,
                genFromPrompt,
                genParams,
                audioRole,
              });
              onClose();
            }}
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
