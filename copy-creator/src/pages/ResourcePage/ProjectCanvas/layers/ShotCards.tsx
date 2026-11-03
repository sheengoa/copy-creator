// 工程画布镜头卡层（自 ProjectCanvas.tsx 渲染区零改动搬运，2026-11-03
// 引擎拆分阶段 11c；fork 对齐点按原注释保持）。portBar/resizeHandle 由
// 主文件经 props 注入，保持与资料框等节点层的端口条/手柄同一实现。
import { Icons } from "../../../../components/Icons";
import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import { joinLibraryPath } from "../../../../domain/projectView";
import { ResourceFileImage, ResourceVideoPoster } from "../../ResourceMedia";
import { NODE_ACCENTS } from "../colors";
import type { CanvasCard, PosMap } from "../types";

/** 镜头卡：场景分组框内的素材网格卡（挂素材/编辑/删除/四角手柄）。 */
export function ShotCards({
  cards, pos, selKeys, nodeSizes, sizeOfNode, shotNoOf, portBar, resizeHandle,
  libraryRoot, onPickForShot, setShotForm, deleteShot,
}: {
  cards: CanvasCard[];
  pos: PosMap;
  selKeys: string[];
  nodeSizes: Record<string, { w: number; h: number }>;
  sizeOfNode(key: string): { w: number; h: number } | null;
  shotNoOf(sceneId: string, shotId: string): number;
  portBar(key: string): React.ReactNode;
  resizeHandle: React.ReactNode;
  libraryRoot: string;
  onPickForShot(shotId: string): void;
  setShotForm: Dispatch<SetStateAction<{ id: string; sceneId: string; description: string; dialogue: string } | null>>;
  deleteShot(shotId: string): void;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 镜头卡 */}
{cards.map((card) => {
  const p = pos.cards[card.shot.id] ?? { x: 0, y: 0 };
  const selected = selKeys.includes(card.key);
  const shot = card.shot;
  const cardSize = sizeOfNode(card.key);
  const resized = Boolean(nodeSizes[card.key]);
  return (
    <div
      key={card.key}
      data-key={card.key}
      data-frame={card.sceneId}
      className={`pc-node pc-shotcard${resized ? " pc-resized" : ""}${selected ? " pc-selected" : ""}`}
      style={{
        left: p.x, top: p.y,
        width: cardSize?.w ?? card.w,
        height: resized ? cardSize?.h : undefined,
        // 覆盖高度作 minHeight：内容不足时留白，内容超出时撑开。
        minHeight: resized ? undefined : cardSize && cardSize.h !== card.h ? cardSize.h : undefined,
        ["--node-accent" as string]: NODE_ACCENTS.shot,
      } as React.CSSProperties}
    >
      <div className="pc-shot-head">
        <span className="pc-shot-no">{shotNoOf(card.sceneId, card.shot.id)}</span>
        <b className="pc-shot-desc">{shot.description || t("project.shot.untitled")}</b>
        {shot.dialogue && <i className="pc-shot-dialogue">{shot.dialogue}</i>}
      </div>
      {portBar(card.key)}
        {shot.assets.length > 0 ? (
          <div className="pc-shot-grid">
            {card.assets.map(({ asset, w, h }) => {
              const mediaPath = joinLibraryPath(libraryRoot, asset.file_path);
              return (
                <button
                  key={asset.id}
                  type="button"
                  className={`pc-shot-asset-thumb${asset.missing ? " is-missing" : ""}`}
                  data-asset={asset.id}
                  style={resized ? undefined : { width: w, height: h }}
                  title={asset.missing ? `${t("project.asset.fileMissing")} · ${asset.file_path}` : asset.name}
                >
                  {asset.missing ? (
                    <span className="pc-thumb-miss">
                      {Icons.image}
                      {t("project.asset.fileMissing")}
                    </span>
                  ) : asset.kind === "image" ? (
                    <ResourceFileImage
                      path={mediaPath}
                      alt={asset.name}
                      version={asset.updated_at}
                      className="pc-thumb-img"
                    />
                  ) : asset.kind === "video" ? (
                    <>
                      <ResourceVideoPoster
                        path={mediaPath}
                        version={asset.updated_at}
                        fallbackLabel={asset.name || asset.file_path}
                      />
                      <span className="pc-thumb-play">{Icons.play}</span>
                    </>
                  ) : asset.kind === "text" ? (
                    <span className="pc-thumb-text">
                      {Icons.file}
                      {asset.name || asset.file_path}
                    </span>
                  ) : (
                    <span className="pc-thumb-text">
                      {Icons.file}
                      {asset.name || asset.file_path}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="pc-shot-empty">
            {Icons.link}
            {t("project.canvas.shotEmpty")}
          </div>
        )}
      <span className="pc-node-tools">
        <button type="button" data-tooltip={t("project.asset.link")} onClick={() => onPickForShot(shot.id)}>
          {Icons.file}
        </button>
        <button
          type="button"
          data-tooltip={t("common.edit")}
          onClick={() =>
            setShotForm({ id: shot.id, sceneId: shot.scene_id, description: shot.description, dialogue: shot.dialogue })
          }
        >
          {Icons.edit}
        </button>
        <button
          type="button"
          data-tooltip={t("common.delete")}
          className="danger"
          onClick={() => void deleteShot(shot.id)}
        >
          {Icons.delete}
        </button>
      </span>
      {resizeHandle}
    </div>
  );
})}
    </>
  );
}
