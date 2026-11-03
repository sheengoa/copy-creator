// 工程画布场景分组框：场景框 + 集级标签栏（自 ProjectCanvas.tsx 渲染区
// 零改动搬运，2026-11-03 引擎拆分阶段 11c；fork 对齐点按原注释保持）。
import { Icons } from "../../../../components/Icons";
import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import type { ProjectScene } from "../../../../stores/projectStore";
import {
  intExtLabelKey,
  locationSubtitleParts,
  timeHintLabelKey,
} from "../../../../domain/projectView";
import {
  FRAME_MIN_H,
  FRAME_MIN_W,
  FRAME_PAD_BOTTOM,
  FRAME_PAD_X,
  WORLD_MARGIN,
  shotCardSize,
} from "../layout";
import type { CanvasLayout, Pos, PosMap } from "../types";

/** 场景分组框：按场景渲染分组框与标签栏（编辑场景/加镜头/删场景）。 */
export function SceneFrames({
  scenes, scenePos, layout, pos, setSceneForm, setShotForm, setDeleteSceneTarget,
}: {
  scenes: ProjectScene[];
  scenePos: Record<string, Pos>;
  layout: Omit<CanvasLayout, "infoFramePos">;
  pos: PosMap;
  setSceneForm: Dispatch<SetStateAction<{ id?: string; heading: string; locationId: string } | null>>;
  setShotForm: Dispatch<SetStateAction<{ id: string; sceneId: string; description: string; dialogue: string } | null>>;
  setDeleteSceneTarget: Dispatch<SetStateAction<ProjectScene | null>>;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 场景分组框 + 集级框 + 资料框 */}
{scenes.map((scene, sceneIndex) => {
  const spos = scenePos[scene.id] ?? layout.framePos[scene.id] ?? { x: WORLD_MARGIN, y: 110 };
  const sceneCards = layout.cards.filter((c) => c.sceneId === scene.id);
  const frameW = Math.max(
    FRAME_MIN_W,
    ...sceneCards.map((c) => {
      const p = pos.cards[c.shot.id] ?? { x: spos.x + FRAME_PAD_X, y: spos.y };
      const size = shotCardSize(c.shot);
      return p.x - spos.x + size.w + FRAME_PAD_X;
    }),
  );
  const frameH = Math.max(
    FRAME_MIN_H,
    ...sceneCards.map((c) => {
      const p = pos.cards[c.shot.id] ?? { x: spos.x, y: spos.y };
      const size = shotCardSize(c.shot);
      return p.y - spos.y + size.h + FRAME_PAD_BOTTOM;
    }),
  );
  const assetsCount = scene.shots.reduce((acc, s) => acc + s.assets.length, 0);
  return (
    <div
      key={scene.id}
      data-frame={scene.id}
      className="pc-frame"
      style={{ left: spos.x, top: spos.y, width: frameW, height: frameH }}
    >
      <div className="pc-frame-label">
        <small className="pc-frame-no">
          {t("project.canvas.sceneNo", { no: sceneIndex + 1 })}
        </small>
        <span className="pc-frame-name">
          {scene.heading || t("project.scene.untitled")}
        </span>
        {scene.location && (
          <span className="pc-int" title={scene.location.name}>
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
        <small>
          {t("project.canvas.frameStats", { shots: scene.shots.length, assets: assetsCount })}
        </small>
        <span className="pc-frame-ops">
          <button
            type="button"
            data-tooltip={t("common.edit")}
            onClick={() =>
              setSceneForm({ id: scene.id, heading: scene.heading, locationId: scene.location_id })
            }
          >
            {Icons.edit}
          </button>
          <button
            type="button"
            data-tooltip={t("project.canvas.addShot")}
            onClick={() => setShotForm({ id: "", sceneId: scene.id, description: "", dialogue: "" })}
          >
            {Icons.add}
          </button>
          <button type="button" data-tooltip={t("common.delete")} onClick={() => setDeleteSceneTarget(scene)}>
            {Icons.delete}
          </button>
        </span>
      </div>
    </div>
  );
})}
    </>
  );
}
