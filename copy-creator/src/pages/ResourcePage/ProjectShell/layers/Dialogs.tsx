// 工程画布对话框区（自 ProjectCanvas.tsx 渲染区零改动搬运，2026-11-03
// 引擎拆分阶段 11c；fork 对齐点按原注释保持）：场景/镜头快速编辑、删场景
// 确认、挂剧本选择器、提示词挑选、关联场景。（成员装入面板与片段挂产出
// 选择器为旧画布交互，随节点化退役删除——2026-11-14。）
import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import type { ProjectScene } from "../../../../stores/projectStore";
import { promptCategoryKey } from "../../../../domain/projectView";
import { ConfirmDialog } from "../../../../components/ConfirmDialog";
import { Icons } from "../../../../components/Icons";
import ProjectFilePickerDialog from "../../ProjectFilePickerDialog";
import ProjectLibraryPanel from "../../ProjectLibraryPanel";
import type { ProjectPromptT, SceneFormT, ShotFormT } from "./dialogTypes";

/** 场景快速编辑（新建/改名/挂地点）。 */
export function SceneFormDialog({
  sceneForm, setSceneForm, locations, submitSceneForm,
}: {
  sceneForm: SceneFormT | null;
  setSceneForm: Dispatch<SetStateAction<SceneFormT | null>>;
  locations: { id: string; name: string }[];
  submitSceneForm(): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 场景快速编辑 */}
{sceneForm && (
  <PortalMask>
    <div className="pc-dialog">
      <h4>{sceneForm.id ? t("project.canvas.editScene") : t("project.canvas.newScene")}</h4>
      <label>
        <span>{t("project.scene.field.heading")}</span>
        <input
          value={sceneForm.heading}
          placeholder={t("project.scene.field.headingPlaceholder")}
          onChange={(event) => setSceneForm({ ...sceneForm, heading: event.target.value })}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Enter") submitSceneForm();
            if (event.key === "Escape") setSceneForm(null);
          }}
        />
      </label>
      <label>
        <span>{t("project.scene.field.location")}</span>
        <select
          value={sceneForm.locationId}
          onChange={(event) => setSceneForm({ ...sceneForm, locationId: event.target.value })}
        >
          <option value="">{t("project.scene.field.freeLocation")}</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </label>
      <div className="pc-dialog-foot">
        <button type="button" onClick={() => setSceneForm(null)}>{t("common.cancel")}</button>
        <button type="button" className="primary" onClick={submitSceneForm}>{t("common.save")}</button>
      </div>
    </div>
  </PortalMask>
)}
    </>
  );
}

/** 镜头快速编辑（描述/对白）。 */
export function ShotFormDialog({
  shotForm, setShotForm, submitShotForm,
}: {
  shotForm: ShotFormT | null;
  setShotForm: Dispatch<SetStateAction<ShotFormT | null>>;
  submitShotForm(): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 镜头快速编辑 */}
{shotForm && (
  <PortalMask>
    <div className="pc-dialog">
      <h4>{shotForm.id ? t("project.canvas.editShot") : t("project.canvas.addShot")}</h4>
      <label>
        <span>{t("project.shot.field.description")}</span>
        <textarea
          rows={2}
          value={shotForm.description}
          placeholder={t("project.shot.untitled")}
          onChange={(event) => setShotForm({ ...shotForm, description: event.target.value })}
          autoFocus
        />
      </label>
      <label>
        <span>{t("project.shot.field.dialogue")}</span>
        <textarea
          rows={2}
          value={shotForm.dialogue}
          onChange={(event) => setShotForm({ ...shotForm, dialogue: event.target.value })}
        />
      </label>
      <div className="pc-dialog-foot">
        <button type="button" onClick={() => setShotForm(null)}>{t("common.cancel")}</button>
        <button type="button" className="primary" onClick={submitShotForm}>{t("common.save")}</button>
      </div>
    </div>
  </PortalMask>
)}
    </>
  );
}

/** 删场景确认。 */
export function DeleteSceneConfirm({
  deleteSceneTarget, setDeleteSceneTarget, deleteScene,
}: {
  deleteSceneTarget: ProjectScene | null;
  setDeleteSceneTarget: Dispatch<SetStateAction<ProjectScene | null>>;
  deleteScene(sceneId: string): unknown;
}) {
  const { t } = useTranslation();
  return (
    <>
{deleteSceneTarget && (
  <ConfirmDialog
    message={t("project.scene.deleteConfirm", {
      heading: deleteSceneTarget.heading || t("project.scene.untitled"),
    })}
    hint={t("project.scene.deleteConfirmHint")}
    onConfirm={() => {
      const target = deleteSceneTarget;
      setDeleteSceneTarget(null);
      void deleteScene(target.id);
    }}
    onCancel={() => setDeleteSceneTarget(null)}
  />
)}
    </>
  );
}

/** 挂剧本：主剧本转正 / 剧本纸片挂接共用一个文件选择器。 */
export function ScriptPickDialog({
  scriptPickOpen, setScriptPickTarget, setScriptPickOpen, handleScriptPick,
}: {
  scriptPickOpen: boolean;
  setScriptPickTarget(t: string | null): void;
  setScriptPickOpen(open: boolean): void;
  handleScriptPick(filePath: string): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 挂剧本：目标 = 主剧本时选文件设为本集剧本，挂接即自动连全部片段
    剧本口；目标 = 剧本纸片时挂到纸片自己（本集无剧本则转正为主剧本） */}
{scriptPickOpen && (
  <ProjectFilePickerDialog
    title={t("project.canvas.linkScript")}
    takenPaths={new Set()}
    takenLabel=""
    onClose={() => {
      setScriptPickOpen(false);
      setScriptPickTarget(null);
    }}
    onPick={(file) => {
      // 选完即关（用户实测「选完不消失」）；handleScriptPick 闭包已捕获
      // target，转正/挂接落库在其后异步完成，不受关闭影响。
      handleScriptPick(file.filePath);
      setScriptPickOpen(false);
      setScriptPickTarget(null);
    }}
  />
)}
    </>
  );
}

/** 画布小对话框统一遮罩：portal 到 body 的 fixed 全屏层——画布/面板祖先
 *  链的 transform 容器会困住非 portal 层级（被 portal 的详情窗压住，用户
 *  实测），统一顶层挂载根治；层级 95（详情窗 90 之上、库选 200 之下）。 */
function PortalMask({ children, onDismiss }: { children: React.ReactNode; onDismiss?(): void }) {
  return createPortal(
    <div
      className="pc-dialog-mask"
      onMouseDown={(e) => { if (onDismiss && e.target === e.currentTarget) onDismiss(); }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 提示词选择：空提示词纸片双击从提示词库选一条写入纸片。作为详情窗的
 *  二级浮层打开（portal body z100 压过详情窗 z90），标题栏带 ×，
 *  Esc/遮罩/× 都走关闭。 */
export function PromptPickDialog({
  promptPickOpen, closePromptPick, promptPickQuery, setPromptPickQuery, prompts, handlePromptPick,
}: {
  promptPickOpen: boolean;
  closePromptPick(): void;
  promptPickQuery: string;
  setPromptPickQuery(q: string): void;
  prompts: ProjectPromptT[];
  handlePromptPick(promptId: string): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 提示词选择：空提示词纸片双击后从提示词库选一条写入纸片 */}
{promptPickOpen && (
  <PortalMask onDismiss={closePromptPick}>
    <div className="pc-dialog pc-prompt-pick">
      <div className="pc-prompt-pick-topbar">
        <h4>{t("project.canvas.promptPickTitle")}</h4>
        <button
          type="button"
          className="pc-prompt-pick-x"
          aria-label={t("common.close")}
          onClick={closePromptPick}
        >
          {Icons.close}
        </button>
      </div>
      <input
        value={promptPickQuery}
        placeholder={t("project.canvas.addNodeSearch")}
        onChange={(event) => setPromptPickQuery(event.target.value)}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Escape") closePromptPick();
        }}
      />
      <div className="pc-prompt-pick-list">
        {prompts
          .filter((prompt) => {
            const q = promptPickQuery.trim().toLowerCase();
            if (!q) return true;
            return (
              prompt.title.toLowerCase().includes(q) ||
              prompt.content.toLowerCase().includes(q) ||
              (prompt.category && t(promptCategoryKey(prompt.category)).toLowerCase().includes(q))
            );
          })
          .map((prompt) => (
            <button
              key={prompt.id}
              type="button"
              className="pc-prompt-pick-item"
              onClick={() => handlePromptPick(prompt.id)}
            >
              <span className="pc-prompt-pick-head">
                <span className="pc-prompt-pick-title">{prompt.title}</span>
                {prompt.category ? (
                  <span className="pc-prompt-pick-cat">{t(promptCategoryKey(prompt.category))}</span>
                ) : null}
              </span>
              <span className="pc-prompt-pick-content">{prompt.content}</span>
            </button>
          ))}
        {prompts.length === 0 && (
          <div className="pc-prompt-pick-empty">{t("project.canvas.promptPickEmpty")}</div>
        )}
      </div>
    </div>
  </PortalMask>
)}
    </>
  );
}

/** 资料框「关联场景」：多选切换，与出场角色同一交互模式。 */
export function LocationPickPanel({
  locationPickOpen, setLocationPickOpen, episodeId, locationIds, setEpisodeLocations,
}: {
  locationPickOpen: boolean;
  setLocationPickOpen(open: boolean): void;
  episodeId: string;
  locationIds: string[];
  setEpisodeLocations(episodeId: string, ids: string[]): unknown;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 资料框「关联场景」：多选切换，与出场角色同一交互模式 */}
{locationPickOpen && (
  <ProjectLibraryPanel
    kind="locations"
    mode="pick"
    multi
    selectedIds={locationIds}
    onClose={() => setLocationPickOpen(false)}
    pickTitle={t("project.canvas.linkScene")}
    onTogglePick={(id) => {
      if (!episodeId) return;
      const existing = locationIds;
      const next = existing.includes(id)
        ? existing.filter((item) => item !== id)
        : [...existing, id];
      void setEpisodeLocations(episodeId, next);
    }}
  />
)}
    </>
  );
}
