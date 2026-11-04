// 工程画布浮条层（工程视图节点化阶段 E1 收编入壳；自旧 CanvasBars 裁剪：
// 只留缺项条/集信息卡/新建栏——切痕层与旧建节点菜单由自由画布基座承担）。
import { Icons } from "../../../../components/Icons";
import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import type { ProjectScene } from "../../../../stores/projectStore";
import type { ScriptPh, WireItem } from "../types";

/** 缺失提醒条（ComfyUI 缺节点警示的对应物）：缺项可点击定位。 */
export function IssueBar({
  issues, scriptPhs, segments, locateOutput, locateScript, armSpawnFromEvent,
  addScriptPh, locateEmptySegment, setDetailFor,
}: {
  issues: { key: string; label: string }[];
  scriptPhs: ScriptPh[];
  segments: { id: string; asset?: unknown }[];
  locateOutput(): void;
  locateScript(key?: string): void;
  armSpawnFromEvent(clientX: number, clientY: number): void;
  addScriptPh(): void;
  locateEmptySegment(): void;
  setDetailFor(target: { kind: string; id: string } | null): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{issues.length > 0 && (
  <div className="pc-checkbar">
    <span className="pc-checkbar-title">{t("project.canvas.checkTitle")}</span>
    {issues.map((issue) => (
      <button
        key={issue.key}
        type="button"
        className="pc-checkbar-chip"
        onClick={(event) => {
          if (issue.key === "output") locateOutput();
          if (issue.key === "script") {
            // 剧本两段式：有空纸片 → 定位到它（双击选文件）；
            // 没有 → 放一个空纸片（出生在点击位置）。
            const emptyPh = scriptPhs.find((item) => !item.path);
            if (emptyPh) {
              locateScript(`script:${emptyPh.id}`);
            } else {
              armSpawnFromEvent(event.clientX, event.clientY);
              addScriptPh();
            }
          }
          if (issue.key === "segAssets") {
            locateEmptySegment();
            // 定位之余直接打开片段详情窗口，形成"提醒→填充"闭环。
            const firstEmpty = segments.find((item) => !item.asset);
            if (firstEmpty) setDetailFor({ kind: "segment", id: firstEmpty.id });
          }
        }}
      >
        {issue.label}
      </button>
    ))}
  </div>
)}
    </>
  );
}

/** 集信息玻璃卡 + 统计。 */
export function EpisodeCard({
  overlay, scenes, looseAssets, wires,
}: {
  overlay: React.ReactNode;
  scenes: ProjectScene[];
  looseAssets: unknown[];
  wires: WireItem[];
}) {
  const { t } = useTranslation();
  return (
    <>
<div className="pc-glass pc-ep-card">
  {overlay}
  <div className="pc-ep-stats">
    <span>{t("project.canvas.statScenes", { count: scenes.length })}</span>
    <span>{t("project.canvas.statShots", { count: scenes.reduce((acc, s) => acc + s.shots.length, 0) })}</span>
    <span>{t("project.canvas.statAssets", { count: scenes.reduce((acc, s) => acc + s.shots.reduce((a, sh) => a + sh.assets.length, 0), 0) + looseAssets.length })}</span>
    <span>{t("project.canvas.statWires", { count: wires.length })}</span>
  </div>
</div>
    </>
  );
}

/** 右下角按钮条：从资源库选择素材 / 新建场景。 */
export function AddBtnBar({
  onPickForShot, setSceneForm,
}: {
  onPickForShot(shotId: string): void;
  setSceneForm: Dispatch<SetStateAction<{ id?: string; heading: string; locationId: string } | null>>;
}) {
  const { t } = useTranslation();
  return (
    <>
<div className="pc-glass pc-addbtn">
  <button type="button" onClick={() => onPickForShot("")}>
    {Icons.folderOpen}
    {t("project.canvas.pickFromLibrary")}
  </button>
  <button
    type="button"
    className="primary"
    onClick={() => setSceneForm({ heading: "", locationId: "" })}
  >
    {Icons.add}
    {t("project.canvas.newScene")}
  </button>
</div>
    </>
  );
}
