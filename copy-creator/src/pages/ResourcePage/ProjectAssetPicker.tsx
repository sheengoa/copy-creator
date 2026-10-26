import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../../stores/projectStore";
import ProjectFilePickerDialog from "./ProjectFilePickerDialog";

export interface ProjectAssetPickerProps {
  /** 挂靠目标：'' 为集级散件，否则挂到指定镜头。 */
  shotId: string;
  onClose: () => void;
  /** 仅取消（未挑选文件，遮罩/X/Esc）时回调：画布借此丢弃「拖线到
   *  空白待落位/待接线」的挂起状态；成功挂靠不触发，避免与异步落位
   *  抢时序。 */
  onCancel?: () => void;
  /** 挂靠成功后的回调（「重新挂靠替换」用：挂新文件后撤销旧档案）。 */
  onLinked?: () => void;
}

/** 挂靠薄壳：通用选择浮层（搜索/分页/缩略图/导入）+ 挂靠语义（点选
 *  即 project_link_asset 到当前集/镜头；已挂靠文件标占禁点）。 */
export default function ProjectAssetPicker({ shotId, onClose, onCancel, onLinked }: ProjectAssetPickerProps) {
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

  return (
    <ProjectFilePickerDialog
      title={t("project.asset.pickerTitle")}
      takenPaths={linkedPaths}
      takenLabel={t("project.asset.alreadyLinked")}
      onClose={() => {
        onCancel?.();
        onClose();
      }}
      onPick={(file) => {
        void linkAsset({
          filePath: file.filePath,
          kind: file.kind,
          name: file.name,
          episodeId,
          shotId,
        }).then(() => onLinked?.());
        onClose();
      }}
    />
  );
}
