import { useTranslation } from "react-i18next";
import { Icons } from "../../../../components/Icons";
import type { CanvasNode } from "../../../../stores/canvasStore";
import { joinLibraryPath, characterAvatarInitial } from "../../../../domain/projectView";
import { ResourceFileImage, ResourceImage, ResourceVideoPoster } from "../../../ResourcePage/ResourceMedia";
import type { EntityPhKind } from "../../../ResourcePage/ProjectCanvas/types";
import { TextPaperBody } from "../../../ResourcePage/ProjectCanvas/TextPaperBody";
import { useProjectCanvas } from "./projectContext";
import { NodeHint } from "../NodeHint";
import type { NodeProps } from "../types";

// 工程节点内容层（工程视图节点化 2026-11-05 阶段 B）：八类节点的渲染体
// 与工具钮——自旧 ShotCards/InfoNodesLayer/EntityPhNodes/PromptPhNodes/
// SegmentNodes/OutputNode 移植，props 全部换 ctx（useProjectCanvas）。
// 纯组件模块（def 与渲染体分文件，对齐自由画布 genImage/GenImageBody
// 惯例，满足 react-refresh 组件文件纯组件导出约定）。

type EntityLike = { id: string; name: string; avatar_path?: string; ref_path?: string };

/** 实体解析（集关联为主、全局库兜底——与组自愈规则同源）。 */
function entityOf(ctx: ReturnType<typeof useProjectCanvas>, kind: EntityPhKind, id: string): EntityLike | undefined {
  const episodeList =
    kind === "character" ? ctx.castCharacters : kind === "location" ? ctx.episodeLocations : ctx.episodeProps;
  const globalList = kind === "character" ? ctx.characters : kind === "location" ? ctx.locations : ctx.props;
  return (episodeList.find((e) => e.id === id) ?? globalList.find((e) => e.id === id)) as EntityLike | undefined;
}

/** 实体参考图卡：首图大卡 + 类型色淡底首字占位（同一卡片形态）。 */
function PhotoMain({ name, refPath }: { name: string; refPath: string }) {
  const { t } = useTranslation();
  const libraryRoot = useProjectCanvas().libraryRoot;
  return refPath ? (
    <ResourceImage path={joinLibraryPath(libraryRoot, refPath)} alt={name} className="pc-photo-img" />
  ) : (
    <>
      <span className="pc-photo-init">{characterAvatarInitial(name)}</span>
      <span className="pc-photo-sub">{t("project.canvas.noRefImage")}</span>
    </>
  );
}

// ── 资料节点（角色/场景/道具）：占位 / 单实体 / 组照片堆放三形态 ──

export function EntityBody({ node }: NodeProps) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  const key = node.id;
  const kind = node.type as EntityPhKind;

  // 空白占位：菜单创建后未加载实体的画布占位，双击从详情窗加载（阶段 D）。
  if (key.startsWith("eph:")) {
    return (
      <div className="pc-info-body pc-eph-body">
        {kind === "character" ? Icons.clipboard : kind === "location" ? Icons.resources : Icons.star}
        <span>{t("project.canvas.ephHint")}</span>
      </div>
    );
  }

  // 组节点：照片堆放——首位成员大图在上，其余成员图边向右堆（上限 2）。
  if (key.startsWith("grp:")) {
    const members = (ctx.infoGroups.find((g) => `grp:${g.id}` === key)?.members ?? [])
      .map((id) => {
        const entity = entityOf(ctx, kind, id);
        if (!entity) return null;
        const ref = kind === "character" ? entity.avatar_path : entity.ref_path;
        return { id, name: entity.name, ref };
      })
      .filter((m): m is { id: string; name: string; ref: string } => m !== null);
    const main = members[0];
    const stack = members.slice(1, 3);
    if (!main) return null;
    return (
      <div className="pc-info-body">
        <div className={`pc-photo${stack.length > 0 ? " has-stack" : ""}`}>
          {stack.map((member, index) => (
            <span key={member.id} className={`pc-photo-layer l${index + 1}`}>
              {member.ref ? (
                <ResourceImage path={joinLibraryPath(ctx.libraryRoot, member.ref)} alt="" className="pc-photo-img" />
              ) : null}
            </span>
          ))}
          <div className={`pc-photo-main${main.ref ? "" : " pc-photo-empty"}`}>
            <PhotoMain name={main.name} refPath={main.ref} />
          </div>
        </div>
      </div>
    );
  }

  // 单实体：集关联默认节点（参考图 = 角色头像 / 场景道具参考图）。
  const id = key.slice(key.indexOf(":") + 1);
  const entity = entityOf(ctx, kind, id);
  const refPath = entity ? (kind === "character" ? entity.avatar_path : entity.ref_path) : "";
  return (
    <div className="pc-info-body">
      <div className="pc-photo">
        <div className={`pc-photo-main${refPath ? "" : " pc-photo-empty"}`}>
          <PhotoMain name={entity?.name ?? node.title} refPath={refPath ?? ""} />
        </div>
      </div>
    </div>
  );
}

/** 资料节点查看工具：占位开实体加载详情，单实体/组开节点详情。 */
export function EntityViewTool({ node }: { node: CanvasNode }) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  return (
    <NodeHint text={t("project.canvas.view")}>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          if (node.id.startsWith("eph:")) ctx.setDetailFor({ kind: "entityPh", id: node.id.slice(4), group: node.type as EntityPhKind });
          else ctx.setDetailFor({ kind: "info", group: node.type as EntityPhKind, sourceKey: node.id });
        }}
      >
        {Icons.expand}
      </button>
    </NodeHint>
  );
}

// ── 镜头卡（自绘头栏：序号 + 描述 + 对白 + 素材网格） ──

export function ShotBody({ node }: NodeProps) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  const card = ctx.layout.cards.find((c) => c.key === node.id);
  if (!card) return null;
  const shot = card.shot;
  const resized = node.height != null;
  return (
    <>
      <div className="pc-shot-head">
        <span className="pc-shot-no">{ctx.shotNoOf(card.sceneId, shot.id)}</span>
        <b className="pc-shot-desc">{shot.description || t("project.shot.untitled")}</b>
        {shot.dialogue && <i className="pc-shot-dialogue">{shot.dialogue}</i>}
      </div>
      {shot.assets.length > 0 ? (
        <div className="pc-shot-grid">
          {card.assets.map(({ asset, w, h }) => {
            const mediaPath = joinLibraryPath(ctx.libraryRoot, asset.file_path);
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
                  <ResourceFileImage path={mediaPath} alt={asset.name} version={asset.updated_at} className="pc-thumb-img" />
                ) : asset.kind === "video" ? (
                  <>
                    <ResourceVideoPoster path={mediaPath} version={asset.updated_at} fallbackLabel={asset.name || asset.file_path} />
                    <span className="pc-thumb-play">{Icons.play}</span>
                  </>
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
    </>
  );
}

/** 镜头卡挂素材 / 编辑（删除走壳默认钮 → deleteShot）。 */
export function ShotTools({ node }: { node: CanvasNode }) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  const shotId = node.id.slice(5);
  const shot = ctx.scenes.flatMap((s) => s.shots).find((item) => item.id === shotId);
  return (
    <>
      <NodeHint text={t("project.asset.link")}>
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => ctx.onPickForShot(shotId)}>
          {Icons.file}
        </button>
      </NodeHint>
      <NodeHint text={t("common.edit")}>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => shot && ctx.setShotForm({ id: shot.id, sceneId: shot.scene_id, description: shot.description, dialogue: shot.dialogue })}
        >
          {Icons.edit}
        </button>
      </NodeHint>
    </>
  );
}

// ── 片段（六输入口 + 产出视频） ──

export function SegmentBody({ node }: NodeProps) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  const segmentId = node.id.slice(8);
  const index = ctx.segments.findIndex((s) => s.id === segmentId);
  const segment = ctx.segments[index];
  if (!segment) return null;
  return segment.asset ? (
    <button
      type="button"
      className={`pc-seg-thumb${segment.asset.missing ? " is-missing" : ""}`}
      title={segment.asset.missing ? t("project.asset.fileMissing") : segment.asset.name}
      data-asset={segment.asset.id}
    >
      <ResourceVideoPoster
        path={joinLibraryPath(ctx.libraryRoot, segment.asset.file_path)}
        version={segment.asset.updated_at}
        fallbackLabel={segment.asset.name || segment.asset.file_path}
      />
      <span className="pc-thumb-play">{Icons.play}</span>
    </button>
  ) : (
    <div className="pc-seg-empty">
      {Icons.link}
      {t("project.canvas.segEmpty")}
    </div>
  );
}

/** 片段上移/下移/挂靠（删除走壳默认钮 → removeSegment）。 */
export function SegmentTools({ node }: { node: CanvasNode }) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  const segmentId = node.id.slice(8);
  return (
    <>
      <NodeHint text={t("project.canvas.segMoveUp")}>
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => ctx.moveSegment(segmentId, -1)}>
          {Icons.chevronUp}
        </button>
      </NodeHint>
      <NodeHint text={t("project.canvas.segMoveDown")}>
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => ctx.moveSegment(segmentId, 1)}>
          {Icons.chevronDown}
        </button>
      </NodeHint>
      <NodeHint text={t("project.canvas.segAttach")}>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => ctx.setDetailFor({ kind: "segment", id: segmentId })}
        >
          {Icons.file}
        </button>
      </NodeHint>
    </>
  );
}

// ── 剧本纸片（主剧本 + 画布纸片共用） ──

export function ScriptPaperBody({ node }: NodeProps) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  const key = node.id;
  // 主剧本：路径来自集；纸片：路径来自 scriptPhs。
  const textPath = key === "script" ? (ctx.overview?.episode.script_path ?? "") : (ctx.scriptPhs.find((ph) => `script:${ph.id}` === key)?.path ?? "");
  const resized = node.height != null;
  if (textPath) {
    return (
      <div className="pc-info-script">
        <TextPaperBody path={joinLibraryPath(ctx.libraryRoot, textPath)} name={node.title} lines={5} adaptive={resized} />
      </div>
    );
  }
  return (
    <div className="pc-info-body pc-eph-body">
      {Icons.file}
      <span>{t("project.canvas.scriptEmpty")}</span>
    </div>
  );
}

// ── 提示词纸片 ──

export function PromptPaperBody({ node }: NodeProps) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  const ph = ctx.promptPhs.find((item) => `prompt:${item.id}` === node.id);
  if (!ph) return null;
  const prompt = ctx.prompts.find((item) => item.id === ph.promptId);
  if (prompt) {
    return <div className="pc-prompt-text">{prompt.content}</div>;
  }
  return (
    <div className="pc-info-body pc-eph-body">
      {Icons.file}
      <span>{t("project.canvas.promptEmpty")}</span>
    </div>
  );
}

/** 提示词纸片查看：已填充开详情 / 空纸片开库选。 */
export function PromptPaperTools({ node }: { node: CanvasNode }) {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  const phId = node.id.slice(7);
  const ph = ctx.promptPhs.find((item) => item.id === phId);
  return (
    <NodeHint text={t("project.canvas.view")}>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          if (!ph) return;
          if (!ph.promptId) {
            ctx.setPromptPickTarget(node.id);
            ctx.setPromptPickOpen(true);
          } else {
            ctx.setDetailFor({ kind: "promptPh", id: phId } as never);
          }
        }}
      >
        {Icons.expand}
      </button>
    </NodeHint>
  );
}

// ── 成片输出 ──

export function OutputBody() {
  const ctx = useProjectCanvas();
  const { t } = useTranslation();
  return (
    <div className="pc-outnode-body">
      <span className="pc-outnode-icon">{Icons.clapperboard}</span>
      <small>
        {ctx.segments.length > 0
          ? t("project.canvas.outputSummary", { count: ctx.segments.length })
          : (ctx.outputSourceLabel ?? t("project.canvas.outputEmpty"))}
      </small>
    </div>
  );
}
