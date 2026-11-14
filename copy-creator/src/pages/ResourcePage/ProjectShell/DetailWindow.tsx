import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { useEscapeKey } from "../../../hooks/useEscapeKey";
import type {
  EpisodeOverview,
  ImageBinding,
  ProjectCharacter,
  ProjectLocation,
  ProjectNodeLink,
  ProjectPrompt,
  ProjectProp,
  ProjectSegment,
} from "../../../stores/projectStore";
import { joinLibraryPath } from "../../../domain/projectView";
import { readResourceTextPreview } from "../../../domain/mediaAssets";
// 音频选取白名单与画布媒体节点同源（此前手写 wav/mp3/flac/ogg 四项，
// 已与共享清单漂移——m4a/aac/opus 在画布可载、此处对话框却筛掉）。
import { AUDIO_EXTS } from "../../CanvasPage/nodes/exts";
import { ResourceFileImage, ResourceImage, ResourceVideoPoster } from "../ResourceMedia";
import type { EntityPhKind, PendingLink, PromptPh, ScriptPh } from "./types";
import { MediaPlayback } from "../../../components/MediaPlayback";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import ProjectLibraryPanel from "../ProjectLibraryPanel";

// 工程节点详情窗（工程视图节点化 2026-11-05 阶段 D，方案 §D2-D5）：
// 三段式——头部（标题+关闭）/主体（内部滚动，顶到哪滚到哪）/动作区钉底
// （任何滚动位置可用），亮暗两套走主题变量。角色/场景/道具共用实体骨架
// （参考图网格 30/批懒加载 + 设头像 + 音色行[仅角色] + 人设 + 统计）；
// 片段=产出常显 + 输入按口分组折叠 + 批量挂靠 + 逐项移除；空白占位=实体
// 装入（选择即关联+暂存线转正+占位移除）。

/** 详情窗目标（Shell 的 detailFor 状态同构，B 阶段已接工具按钮）。
 *  info 的 nodeKey=来源画布节点 key（eph:<phid> / char:<id> 等）：有它
 *  「当前」视角才是节点选用形象集（可多选增删）；缺省（输入卡跳转/组）
 *  退化为只读的头像单卡。 */
export type DetailTarget =
  | { kind: "info"; group: EntityPhKind; sourceKey: string; nodeKey?: string }
  | { kind: "entityPh"; id: string; group: EntityPhKind }
  | { kind: "segment"; id: string }
  | { kind: "promptPh"; id: string }
  | { kind: "scriptPh"; key: string }
  | { kind: "output" };

export interface DetailWindowOps {
  libraryRoot: string;
  overview: EpisodeOverview | null;
  segments: ProjectSegment[];
  nodeLinks: ProjectNodeLink[];
  pendingLinks: PendingLink[];
  characters: ProjectCharacter[];
  locations: ProjectLocation[];
  props: ProjectProp[];
  prompts: ProjectPrompt[];
  promptPhs: PromptPh[];
  scriptPhs: ScriptPh[];
  /** 音色行：选择/清除（set_character_voice）。 */
  setVoice(id: string, voicePath: string): void;
  /** 设头像（参考图大图的「设为头像」）。 */
  setAvatar(character: ProjectCharacter, refPath: string): void;
  /** 三库参考图集整体覆写（详情窗添加/移除；kind: character|location|prop）。 */
  setReferences(kind: EntityPhKind, id: string, paths: string[]): void;
  /** 每图绑定（形象卡方案 A）：整体覆写三库 image_bindings（独立开关/音色/人设/提示词提交）。 */
  setImageBindings(kind: EntityPhKind, id: string, bindings: ImageBinding[]): void;
  /** 实体级默认人设/提示词（形象卡默认区编辑；保留各自其它字段落库）。 */
  saveProfile(kind: EntityPhKind, id: string, bio: string, prompt: string): void;
  /** 窗内跳转其它详情（输入卡点击展开：实体/组/片段窗互跳）。 */
  openDetail(target: DetailTarget): void;
  /** 节点选用形象集（nodeKey → 形象 path 列表，按集 localStorage）：
   *  「当前」视角的数据源——节点可多选形象，与库数据互不影响。 */
  nodeFaces: Record<string, string[]>;
  /** 节点选用形象：追加（当前视角添加形象点选即加）。 */
  addNodeFace(nodeKey: string, path: string): void;
  /** 节点选用形象：移出（不动库数据；头像不在此列，恒兜底显示）。 */
  removeNodeFace(nodeKey: string, path: string): void;
  /** 装入占位实体（关联到集 + 暂存线转正 + 占位移除）。 */
  loadEntity(ephId: string, kind: EntityPhKind, entityId: string): void;
  /** 移除片段输入（正式行/暂存线分派）。 */
  removeLink(row: { pending: boolean; fromKey: string; toSegment: string; toPort: string; ownerKey: string; rowId?: string }): void;
  /** 批量挂靠（多选实体逐条落 node_link）。 */
  attachEntities(segmentId: string, port: string, entities: Array<{ kind: EntityPhKind; id: string }>): void;
  /** 片段产出挂接：开素材选择浮层（限视频），选完由 Shell 收库并落
   *  setSegmentAsset——产出此前没有任何挂接入口（实测 P1-1，空态提示
   *  指向的「批量挂靠」只能挂实体输入）。 */
  openOutputPick(segmentId: string): void;
  /** 提示词纸片「选择/更换提示词」：开提示词库选浮层（详情窗保持打开，
   *  浮层叠加在其上，选完纸片内容经状态刷新）。 */
  openPromptPick(phKey: string): void;
  /** 剧本详情窗「挂接/更换剧本」：开文件选择浮层（详情窗保持打开）。 */
  openScriptPick(key: string): void;
  /** 返回目标：经输入卡跳入当前窗时为上一窗（头部显示返回键），否则
   *  null。跳转由 ops.openDetail 压栈、goBack 弹出。 */
  backTarget: DetailTarget | null;
  goBack(): void;
  onClose(): void;
}

/** 参考图懒加载分页大小（滚到底自动续 30/批，方案 §D3）。 */
const REF_PAGE = 30;

/** 音频文件名（相对路径取尾段）。 */
const voiceLabel = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** 三段式骨架：头部标题/主体内部滚动/动作区钉底；portal 到 body 脱离
 *  画布裁剪与 transform 坐标系（与旧 DetailDialog 同挂载策略）。 */
export function DetailWindow({ title, accent, children, foot, onClose, back }: {
  title: React.ReactNode;
  accent: string;
  children: React.ReactNode;
  foot?: React.ReactNode;
  onClose(): void;
  /** 返回上一窗（输入卡跳入时显示 ‹ 返回键，用户定案「跳过去也要跳回
   *  来」）；缺省无返回键。 */
  back?: { onBack(): void };
}) {
  const { t } = useTranslation();
  // Esc 关最上层（无二级面板，直接关）。收口在 useEscapeKey：原手写挂在
  // window 层，换 document 层后先于 window 快捷键触发；window 层无其他
  // Escape 消费方（Delete 专用），分层结果不变。
  useEscapeKey(onClose);
  return createPortal(
    <div className="pdetail-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pdetail" style={{ "--pdetail-accent": accent } as React.CSSProperties}>
        <div className="pdetail-head">
          {back && (
            <button
              type="button"
              className="pdetail-back"
              title={t("project.detail.back")}
              aria-label={t("project.detail.back")}
              onClick={back.onBack}
            >
              {Icons.arrowLeft}
            </button>
          )}
          <span className="pdetail-kind">{title}</span>
          <button type="button" className="pdetail-close" aria-label={t("common.close")} onClick={onClose}>
            {Icons.close}
          </button>
        </div>
        <div className="pdetail-body">{children}</div>
        {foot && <div className="pdetail-foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** 通用段落头：段名 + 计数 + 右侧附加（折叠箭头/懒加载提示）。折叠箭头
 *  用 SVG chevron（U+25B8/25BE 字符三角在部分 Windows WebView 字体栈里
 *  渲染成 tofu 方框——用户实测截图）。 */
export function DetailSection({ label, count, extra, children, foldable, defaultFold }: {
  label: string;
  count?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
  foldable?: boolean;
  defaultFold?: boolean;
}) {
  const { t } = useTranslation();
  const [folded, setFolded] = useState(!!defaultFold);
  return (
    <section className="pdetail-sec">
      <div className="pdetail-sec-h">
        <span className="pdetail-sec-t">{label}</span>
        {count != null && <span className="pdetail-sec-c">{count}</span>}
        {foldable ? (
          <button type="button" className="pdetail-sec-fold" aria-label={t(folded ? "project.detail.expand" : "project.detail.collapse")} onClick={() => setFolded((v) => !v)}>
            {folded ? Icons.chevronRight : Icons.chevronDown}
          </button>
        ) : null}
        {extra}
      </div>
      {!folded && children}
    </section>
  );
}

/** 形象卡（方案 A，用户定案「一张图片对应一份数据」）：一图一卡，图与
 *  该形象的数据同框——角色=音色/人设/提示词；场景=时段/描述/提示词；
 *  道具=描述/提示词。跟随默认时字段镜像默认值且不可编辑；「跟随/独立」
 *  白卡胶囊切换（用户指定样式）打开即预填默认、逐字段编辑（落库整体覆
 *  写 image_bindings，空字段=跟随默认）；音色行操作指向当前生效目标：
 *  跟随→实体级 setVoice，独立→绑定条目。图区=定框 16:10 + 保比例
 *  contain + 上下虚影（用户定案「窗口里规矩框，比例不裁」）。编辑本地
 *  镜像 + 失焦提交（防光标跳、防逐键落库）。 */
function FaceCard({ path, group, isAvatar, isMain, binding, defProfile, entityName, removable, libraryRoot, onSetAvatar, onRemove, onCommit, onPickVoiceFace, onClearVoiceFace, nodeRemove, refNodes, alsoIn }: {
  path: string;
  group: EntityPhKind;
  isAvatar: boolean;
  /** 兜底主图卡（场景/道具 ref_path 恒兜底显示）：标「已是主图」，与头
   *  像卡同规不提供移出（实测 P3-1 移出可点但无效误导）。 */
  isMain?: boolean;
  /** null = 跟随默认（无绑定条目）。 */
  binding: ImageBinding | null;
  defProfile: { voice_path: string; bio: string; prompt: string; time_hint: string };
  /** 实体名（跟随默认时形象名称镜像它）。 */
  entityName: string;
  removable: boolean;
  libraryRoot: string;
  onSetAvatar(): void;
  onRemove(): void;
  /** 节点级移出（当前视角专用）：从本节点选用集合去掉这张，不动库。
   *  头像卡不传（恒兜底显示，不提供移出）。 */
  nodeRemove?: () => void;
  /** 提交该形象的绑定：null = 移除条目回到跟随默认。 */
  onCommit(next: ImageBinding | null): void;
  /** 音色更换（跟随→写实体级；独立→写绑定条目）。 */
  onPickVoiceFace(): void;
  /** 音色清除（跟随→清实体级；独立→清绑定条目）。 */
  onClearVoiceFace(): void;
  /** 引用节点标注（全部视角）：本集挂载此图的节点数与可读名清单。 */
  refNodes?: { count: number; list: string };
  /** 跨实体归属标注（全部视角）：除归并组外还有哪些实体的列表含此图。 */
  alsoIn?: { names: string };
}) {
  const { t } = useTranslation();
  const ind = !!binding;
  const dn = entityName;
  const dv = defProfile.voice_path;
  const db = defProfile.bio;
  const dp = defProfile.prompt;
  const dt = defProfile.time_hint;
  const bn = binding?.name ?? "";
  const bv = binding?.voice_path ?? "";
  const bb = binding?.bio ?? "";
  const bp = binding?.prompt ?? "";
  const bt = binding?.time_hint ?? "";
  // 本地镜像：输入中不回写（防光标跳），失焦才提交。
  const [nameText, setNameText] = useState(ind ? bn : dn);
  const [voiceText, setVoiceText] = useState(ind ? bv : dv);
  const [bioText, setBioText] = useState(ind ? bb : db);
  const [promptText, setPromptText] = useState(ind ? bp : dp);
  const [timeText, setTimeText] = useState(ind ? bt : dt);
  useEffect(() => {
    setNameText(ind ? bn : dn);
    setVoiceText(ind ? bv : dv);
    setBioText(ind ? bb : db);
    setPromptText(ind ? bp : dp);
    setTimeText(ind ? bt : dt);
  }, [path, ind, bn, bv, bb, bp, bt, dn, dv, db, dp, dt]);
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const commitFields = () => {
    if (binding) onCommit({ path, name: nameText, voice_path: voiceText, bio: bioText, prompt: promptText, time_hint: timeText });
  };
  const bioLabel = group === "character" ? t("project.detail.bioLabel") : t("project.detail.describeLabel");
  return (
    <div className={`pdetail-face${isAvatar ? " is-avatar" : ""}`}>
      <div className="pdetail-face-img">
        <ResourceImage path={joinLibraryPath(libraryRoot, path)} alt="" className="pdetail-face-ghost" />
        <ResourceImage path={joinLibraryPath(libraryRoot, path)} alt={fileName} className="pdetail-face-picture" />
      </div>
      <div className="pdetail-face-main">
        <div className="pdetail-face-top">
          <b className="pdetail-face-name" title={fileName}>{fileName}</b>
          {isAvatar && <span className="pdetail-badge">{t("project.detail.avatarBadge")}</span>}
          {isMain && <span className="pdetail-badge">{t("project.detail.mainBadge")}</span>}
          {/* 引用节点徽标（全部视角，用户定案「标注好有哪些节点挂载它」）：
              计数入卡、明细悬浮，引用再多也不撑长列表。 */}
          {refNodes && (
            <span
              className="pdetail-badge pdetail-badge-refs"
              title={t("project.detail.mountBadgeTitle", { n: refNodes.count, list: refNodes.list })}
            >
              {t("project.detail.mountBadge", { n: refNodes.count })}
            </span>
          )}
          {alsoIn && (
            <span className="pdetail-badge" title={t("project.detail.alsoInTitle", { names: alsoIn.names })}>
              {t("project.detail.alsoIn", { names: alsoIn.names })}
            </span>
          )}
          {/* 跟随/独立：白卡胶囊两段切换（用户指定样式） */}
          <div className="pdetail-seg" role="group" aria-label={t("project.detail.independentToggle")}>
            <button
              type="button"
              className={`pdetail-seg-btn${ind ? "" : " is-active"}`}
              onClick={() => ind && onCommit(null)}
            >
              {t("project.detail.segFollow")}
            </button>
            <button
              type="button"
              className={`pdetail-seg-btn${ind ? " is-active" : ""}`}
              onClick={() => !ind && onCommit({ path, name: dn, voice_path: dv, bio: db, prompt: dp, time_hint: dt })}
            >
              {t("project.detail.segIndependent")}
            </button>
          </div>
        </div>
        <div className="pdetail-f">
          <span className="pdetail-f-label">{t("project.detail.nameLabel")}</span>
          <input
            className="pdetail-f-input"
            value={nameText}
            disabled={!ind}
            placeholder={ind ? t("project.detail.namePlaceholder") : t("project.detail.followHint")}
            onChange={(e) => setNameText(e.target.value)}
            onBlur={commitFields}
          />
        </div>
        {group === "character" && (
          <VoiceRow voicePath={ind ? voiceText : dv} onPick={onPickVoiceFace} onClear={onClearVoiceFace} />
        )}
        {group === "location" && (
          <div className="pdetail-f">
            <span className="pdetail-f-label">{t("project.detail.timeLabel")}</span>
            <input
              className="pdetail-f-input"
              value={timeText}
              disabled={!ind}
              placeholder={ind ? t("project.detail.timePlaceholder") : t("project.detail.followHint")}
              onChange={(e) => setTimeText(e.target.value)}
              onBlur={commitFields}
            />
          </div>
        )}
        <div className="pdetail-f">
          <span className="pdetail-f-label">{bioLabel}</span>
          <textarea
            rows={2}
            value={bioText}
            disabled={!ind}
            placeholder={ind ? t("project.detail.bioPlaceholder") : t("project.detail.followHint")}
            onChange={(e) => setBioText(e.target.value)}
            onBlur={commitFields}
          />
        </div>
        <div className="pdetail-f">
          <span className="pdetail-f-label">{t("project.detail.promptLabel")}</span>
          <textarea
            rows={2}
            value={promptText}
            disabled={!ind}
            placeholder={ind ? t("project.detail.promptPlaceholder") : t("project.detail.followHint")}
            onChange={(e) => setPromptText(e.target.value)}
            onBlur={commitFields}
          />
        </div>
        <div className="pdetail-face-foot">
          {group === "character" && (isAvatar ? (
            <button type="button" className="pdetail-voice-act" disabled>{t("project.detail.wasAvatar")}</button>
          ) : (
            <button type="button" className="pdetail-voice-act" onClick={onSetAvatar}>{t("project.detail.setAvatar")}</button>
          ))}
          {nodeRemove && (
            <button type="button" className="pdetail-voice-act is-danger" onClick={nodeRemove}>{t("project.detail.removeFromNode")}</button>
          )}
          {removable && (
            <button type="button" className="pdetail-voice-act is-danger" onClick={onRemove}>{t("project.detail.refRemove")}</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 音色行（仅角色）：共享媒体播放件 + 文件名 + 更换/清除。
 *  更换走 canvas_pick_media_file（与画布加载节点同一取媒通道）。 */
function VoiceRow({ voicePath, onPick, onClear }: {
  voicePath: string;
  onPick(): void;
  onClear(): void;
}) {
  const { t } = useTranslation();
  if (!voicePath) {
    return (
      <div className="pdetail-voice pdetail-voice-empty">
        <span className="pdetail-voice-name">{t("project.detail.voiceEmpty")}</span>
        <button type="button" className="pdetail-voice-act" onClick={onPick}>{t("project.detail.voicePick")}</button>
      </div>
    );
  }
  return (
    <div className="pdetail-voice">
      <MediaPlayback kind="audio" path={voicePath} />
      <span className="pdetail-voice-name">{voiceLabel(voicePath)}</span>
      <button type="button" className="pdetail-voice-act" onClick={onPick}>{t("project.detail.voicePick")}</button>
      <button type="button" className="pdetail-voice-act is-danger" onClick={onClear}>{t("common.delete")}</button>
    </div>
  );
}

/** 默认区人设/提示词（实体级列编辑，方案 A 的兜底值）：本地镜像 + 失焦
 *  提交（saveProfile 保留各自其它字段落库）。bioLabel 由调用方按实体类
 *  传入（角色=人设、场景/道具=描述——实测 P3-2 场景窗误用角色文案）。 */
function DefaultProfileFields({ initialBio, initialPrompt, bioLabel, onCommit }: {
  initialBio: string;
  initialPrompt: string;
  bioLabel: string;
  onCommit(bio: string, prompt: string): void;
}) {
  const { t } = useTranslation();
  const [bio, setBio] = useState(initialBio);
  const [prompt, setPrompt] = useState(initialPrompt);
  useEffect(() => {
    setBio(initialBio);
    setPrompt(initialPrompt);
  }, [initialBio, initialPrompt]);
  return (
    <div className="pdetail-default">
      <div className="pdetail-f">
        <span className="pdetail-f-label">{bioLabel}</span>
        <textarea
          rows={2}
          value={bio}
          placeholder={t("project.detail.bioPlaceholder")}
          onChange={(e) => setBio(e.target.value)}
          onBlur={() => {
            if (bio !== initialBio) onCommit(bio, prompt);
          }}
        />
      </div>
      <div className="pdetail-f">
        <span className="pdetail-f-label">{t("project.detail.promptLabel")}</span>
        <textarea
          rows={2}
          value={prompt}
          placeholder={t("project.detail.promptPlaceholder")}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => {
            if (prompt !== initialPrompt) onCommit(bio, prompt);
          }}
        />
      </div>
    </div>
  );
}

/** 形象卡列表工厂：当前视角与全部视角的每实体分组共用同一套 FaceCard
 *  装配（卡编辑路由到所属实体，写入该实体的库数据）。 */
function faceCardsOf(args: {
  paths: string[];
  group: EntityPhKind;
  avatarPath: string;
  bindingsMap: Record<string, ImageBinding>;
  defProfile: { voice_path: string; bio: string; prompt: string; time_hint: string };
  entityName: string;
  refPaths: string[];
  libraryRoot: string;
  entity: ProjectCharacter | ProjectLocation | ProjectProp;
  commit(path: string, next: ImageBinding | null): void;
  pickVoice(path: string, binding: ImageBinding | null): void;
  clearVoice(path: string, binding: ImageBinding | null): void;
  remove(path: string): void;
  setAvatar(path: string): void;
  /** 节点级移出（当前视角，头像除外——头像恒兜底显示不可移出）。 */
  nodeRemove?: (path: string) => void;
  /** 兜底首卡路径（角色头像 / 场景道具旧主图）：该卡恒兜底显示，「移出
   *  本节点」禁用（实测 P3-1：场景主图卡移出可点但无效果，nodefaces 落
   *  空条目）。 */
  fallbackPath?: string;
  /** 隐藏库级「移除」（当前视角）：节点语境下放库级删图按钮极易误触，
   *  库级删除统一在「全部」视角的实体分组里做。 */
  hideRemove?: boolean;
  /** 图级标注（全部视角）：引用节点数与跨实体归属，null = 不标。 */
  faceMeta?: { owners: Map<string, string[]>; refs: Map<string, string[]> } | null;
  /** 引用节点 key → 可读名（全部视角悬浮明细用）。 */
  refLabel?: (key: string) => string;
}) {
  return args.paths.map((path) => {
    const isFallback = !!args.fallbackPath && path === args.fallbackPath;
    const meta = args.faceMeta ?? null;
    const refKeys = meta?.refs.get(path) ?? [];
    const otherOwners = (meta?.owners.get(path) ?? []).slice(1);
    return (
      <FaceCard
        key={path}
        path={path}
        group={args.group}
        isAvatar={args.group === "character" && path === args.avatarPath && args.avatarPath !== ""}
        isMain={isFallback && args.group !== "character"}
        binding={args.bindingsMap[path] ?? null}
        defProfile={args.defProfile}
        entityName={args.entityName}
        removable={!args.hideRemove && args.refPaths.includes(path)}
        libraryRoot={args.libraryRoot}
        onSetAvatar={() => args.setAvatar(path)}
        onRemove={() => args.remove(path)}
        onCommit={(next) => args.commit(path, next)}
        onPickVoiceFace={() => args.pickVoice(path, args.bindingsMap[path] ?? null)}
        onClearVoiceFace={() => args.clearVoice(path, args.bindingsMap[path] ?? null)}
        nodeRemove={args.nodeRemove && !isFallback ? () => args.nodeRemove!(path) : undefined}
        refNodes={refKeys.length > 0
          ? { count: refKeys.length, list: refKeys.map((k) => (args.refLabel ? args.refLabel(k) : k)).join("、") }
          : undefined}
        alsoIn={otherOwners.length > 0 ? { names: otherOwners.join("、") } : undefined}
      />
    );
  });
}

/** 引用节点 key → 可读名：实体承载节点（kind:id）显示实体名，其余
 *  （eph: 占位口等）原样截短展示。悬浮明细用，仅查询不写入。 */
function nodeRefLabel(
  key: string,
  libs: { characters: ProjectCharacter[]; locations: ProjectLocation[]; props: ProjectProp[] },
): string {
  const sep = key.indexOf(":");
  if (sep > 0) {
    // 画布节点 key 的前缀是短式（char:/loc:/prop: = 实体承载节点，
    // eph: = 片段占位口），按前缀查三库解析实体名——挂载集与实体解耦，
    // 同一张图可被任何实体的节点挂载，跨实体也要能解析。
    const prefix = key.slice(0, sep);
    const id = key.slice(sep + 1);
    const name = prefix === "char"
      ? libs.characters.find((c) => c.id === id)?.name
      : prefix === "loc"
        ? libs.locations.find((l) => l.id === id)?.name
        : prefix === "prop"
          ? libs.props.find((p) => p.id === id)?.name
          : undefined;
    if (name) return name;
  }
  return key.length > 18 ? `${key.slice(0, 18)}…` : key;
}

/** 库条目加入形象（实体级）：该条目头像/主图成为新形象，名称/人设/提示
 *  词/音色（角色）自动带入为该形象的独立绑定。返回 added 时带新图路径
 *  （当前视角挂载据此同步 addNodeFace——挑一次，当前与全部两处都能看
 *  到，用户定案「不能挑完就丢」）。 */
function addPickedFace(
  group: EntityPhKind,
  entity: ProjectCharacter | ProjectLocation | ProjectProp,
  id: string,
  ops: DetailWindowOps,
): { result: "added" | "exists" | "empty"; path?: string } {
  const lib = group === "character" ? ops.characters : group === "location" ? ops.locations : ops.props;
  const picked = lib.find((x) => x.id === id);
  if (!picked) return { result: "empty" };
  const imgPath = group === "character"
    ? (picked as ProjectCharacter).avatar_path
    : (picked as ProjectLocation | ProjectProp).ref_path;
  if (!imgPath) return { result: "empty" };
  const refPaths = entityRefPaths(group, entity);
  if (!refPaths.includes(imgPath)) {
    const gridPaths = entityFacePaths(group, entity);
    const bindingsMap = entityBindings(entity);
    ops.setReferences(group, entity.id, [...refPaths, imgPath]);
    ops.setImageBindings(group, entity.id, [
      ...gridPaths.map((p) => bindingsMap[p]).filter(Boolean),
      {
        path: imgPath,
        name: picked.name,
        voice_path: group === "character" ? ((picked as ProjectCharacter).voice_path ?? "") : "",
        bio: picked.bio,
        prompt: picked.prompt,
        time_hint: group === "location" ? ((picked as ProjectLocation).time_hint ?? "") : "",
      },
    ]);
    return { result: "added", path: imgPath };
  }
  return { result: "exists", path: imgPath };
}
/** 实体形象组（全部视角的每实体分块，用户定案「本集分组·可直接编辑」）：
 *  组头 = 实体名 + 张数 + 该组自己的添加形象钮；组内形象卡与单实体窗完全
 *  同构（编辑写入本组实体的库数据，跨集生效）。visiblePaths 是父级按
 *  「全窗唯一」归并后的本组陈列列表（组内重复与跨组重复均已归并），库
 *  数据仍按全量图集读写。30/批分页按组独立（防单实体巨集；key=实体 id，
 *  换实体自动重置）。 */
function EntityFaceGroup({ group, entity, visiblePaths, faceMeta, ops }: {
  group: EntityPhKind;
  entity: ProjectCharacter | ProjectLocation | ProjectProp;
  /** 父级归并后本组实际陈列的图（已去重、已扣除前面组陈列过的）。 */
  visiblePaths: string[];
  /** 图级标注（引用节点 + 跨实体归属）；null = 当前视角不传。 */
  faceMeta: { owners: Map<string, string[]>; refs: Map<string, string[]> } | null;
  ops: DetailWindowOps;
}) {
  const { t } = useTranslation();
  const refPaths = useMemo(() => entityRefPaths(group, entity), [entity, group]);
  const avatarPath = group === "character" ? ((entity as ProjectCharacter).avatar_path ?? "") : "";
  // 全量图集（绑定重建的基准，含被归并不陈列的图——归并只动展示层）。
  const gridPaths = useMemo(() => entityFacePaths(group, entity), [entity, group]);
  const bindingsMap = useMemo(() => entityBindings(entity), [entity]);
  const commitBinding = (facePath: string, next: ImageBinding | null) => {
    const list = gridPaths.flatMap((p) => {
      if (p === facePath) return next ? [next] : [];
      const b = bindingsMap[p];
      return b ? [b] : [];
    });
    ops.setImageBindings(group, entity.id, list);
  };
  const pickVoiceFor = (facePath: string, binding: ImageBinding | null) => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const picked = await invoke<{ path: string }>("canvas_pick_media_file", { extensions: [...AUDIO_EXTS] });
        if (binding) commitBinding(facePath, { ...binding, voice_path: picked.path });
        else ops.setVoice(entity.id, picked.path);
      } catch {
        // 用户取消或 mock 环境无后端：静默。
      }
    })();
  };
  const clearVoiceFor = (facePath: string, binding: ImageBinding | null) => {
    if (binding) commitBinding(facePath, { ...binding, voice_path: "" });
    else ops.setVoice(entity.id, "");
  };
  const defProfile = {
    voice_path: group === "character" ? ((entity as ProjectCharacter).voice_path ?? "") : "",
    bio: entity.bio ?? "",
    prompt: (entity as { prompt?: string } | undefined)?.prompt ?? "",
    time_hint: group === "location" ? ((entity as ProjectLocation).time_hint ?? "") : "",
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  // 30/批分页（每组独立；形象卡含编辑字段比纯图重，点「显示剩余」续载）。
  const [faceLimit, setFaceLimit] = useState(REF_PAGE);
  const removeRef = (refPath: string) => {
    ops.setReferences(group, entity.id, refPaths.filter((p) => p !== refPath));
  };
  return (
    <>
      <div className="pdetail-facegroup-h">
        <b className="pdetail-facegroup-name">{entity.name}</b>
        <span className="pdetail-facegroup-c">{t("project.detail.refCount", { n: visiblePaths.length })}</span>
        <button type="button" className="pdetail-ref-add" onClick={() => setPickerOpen(true)}>
          {Icons.add}{t("project.detail.refAdd")}
        </button>
      </div>
      <div className="pdetail-facelist">
        {visiblePaths.length === 0 && <div className="pdetail-empty">{t("project.detail.empty")}</div>}
        {faceCardsOf({
          paths: visiblePaths.slice(0, faceLimit), group, avatarPath, bindingsMap, defProfile,
          entityName: entity.name, refPaths, libraryRoot: ops.libraryRoot, entity,
          commit: commitBinding, pickVoice: pickVoiceFor, clearVoice: clearVoiceFor, remove: removeRef,
          setAvatar: (p) => ops.setAvatar(entity as ProjectCharacter, p),
          faceMeta,
          refLabel: (k) => nodeRefLabel(k, ops),
        })}
        {visiblePaths.length > faceLimit && (
          <button type="button" className="pdetail-more" onClick={() => setFaceLimit((n) => n + REF_PAGE)}>
            {t("project.detail.loadMore", { rest: visiblePaths.length - faceLimit })}
          </button>
        )}
      </div>
      {pickerOpen && (
        <ProjectLibraryPanel
          kind={group === "character" ? "characters" : group === "location" ? "locations" : "props"}
          mode="pick"
          pickTitle={t("project.detail.facePickTitle", { kind: t(group === "character" ? "project.canvas.typeCharacter" : group === "location" ? "project.canvas.typeLocation" : "project.canvas.typeProp") })}
          disabledIds={facelessIds(group, ops)}
          disabledLabel={t("project.library.noFaceImage")}
          onClose={() => setPickerOpen(false)}
          onPick={(id) => {
            addPickedFace(group, entity, id, ops);
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}

/** 实体详情体（角色/场景/道具）：形象分组卡（一图 = 音色[角色]/人设/
 *  提示词同框，方案 A）+ 默认区（未绑定形象的兜底值）+ 统计。
 *  nodeKey=来源画布节点：有则「当前」=节点选用形象集（可多选增删，
 *  与库互不影响），无则退化为头像单卡只读。 */
function EntityDetail({ group, sourceKey, nodeKey, ops }: { group: EntityPhKind; sourceKey: string; nodeKey?: string; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const { overview, characters, locations, props } = ops;
  const entityId = useMemo(() => sourceKey.startsWith("grp:")
    ? (overview?.node_links ?? []).find((l) => l.owner_key === sourceKey)?.from_id ?? ""
    : sourceKey.slice(sourceKey.indexOf(":") + 1), [sourceKey, overview]);
  const entity: ProjectCharacter | ProjectLocation | ProjectProp | undefined =
    group === "character" ? characters.find((c) => c.id === entityId)
      : group === "location" ? locations.find((l) => l.id === entityId)
        : props.find((p) => p.id === entityId);
  // 目标失联守卫（实测 P2-3）：库侧删除实体后，已打开的详情窗不再渲染
  // 成「角色 ·」无名空壳（共 0 张 + 挂空态，钉底钮还在）——实体查不到
  // 即自动关窗。组来源（grp:）例外：它按本集挂接解析成员，窗有效性不
  // 系于单个实体。
  const isGroupSource = sourceKey.startsWith("grp:");
  useEffect(() => {
    if (!isGroupSource && !entity) ops.onClose();
  }, [isGroupSource, entity, ops.onClose]);
  const name = entity?.name ?? "";
  // 参考图集（三库统一）：reference_paths JSON 数组为主，场景/道具的旧
  // 单张 ref_path 并入展示（素材天然多张无上限，用户反馈）。头像排首位
  // 仅作形象展示（不可移除），计数与实际展示一致。
  const refPaths = useMemo(() => (entity ? entityRefPaths(group, entity) : []), [entity, group]);
  const voice = group === "character" ? ((entity as ProjectCharacter | undefined)?.voice_path ?? "") : "";
  // 展示列表 = 参考图 + 形象头像（头像排首位）——详情窗是预览窗，已有
  // 形象必须直接可见，计数与实际展示一致（用户反馈「共 0 张」下却有图）。
  const avatarPath = group === "character" ? ((entity as ProjectCharacter | undefined)?.avatar_path ?? "") : "";
  // 每图绑定（形象卡方案 A，用户定案「一张图片对应一份数据」）：path →
  // 独立值；未绑定 path 或字段为空 = 跟随实体级默认。
  const bindingsMap = useMemo(() => (entity ? entityBindings(entity) : {}), [entity]);
  // 绑定提交：以全量图集顺序重建列表（该形象 null = 移除条目回跟随），
  // 整体覆写 image_bindings（失焦时才走，图集解析开销可忽略）。
  const commitBinding = (facePath: string, next: ImageBinding | null) => {
    if (!entity) return;
    const list = entityFacePaths(group, entity).flatMap((p) => {
      if (p === facePath) return next ? [next] : [];
      const b = bindingsMap[p];
      return b ? [b] : [];
    });
    ops.setImageBindings(group, entityId, list);
  };
  // 形象卡音色操作目标：跟随默认→实体级 setVoice；独立→该绑定条目。
  const pickVoiceFor = (facePath: string, binding: ImageBinding | null) => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const picked = await invoke<{ path: string }>("canvas_pick_media_file", { extensions: [...AUDIO_EXTS] });
        if (binding) commitBinding(facePath, { ...binding, voice_path: picked.path });
        else ops.setVoice(entityId, picked.path);
      } catch {
        // 用户取消或 mock 环境无后端：静默。
      }
    })();
  };
  const clearVoiceFor = (facePath: string, binding: ImageBinding | null) => {
    if (binding) commitBinding(facePath, { ...binding, voice_path: "" });
    else ops.setVoice(entityId, "");
  };
  const defProfile = {
    voice_path: voice,
    bio: entity?.bio ?? "",
    prompt: (entity as { prompt?: string } | undefined)?.prompt ?? "",
    time_hint: group === "location" ? ((entity as ProjectLocation | undefined)?.time_hint ?? "") : "",
  };
  // 视角切换（恢复旧详情窗的 当前/全部 双钮，用户定案）：当前=本节点
  // 选用的形象集（头像/主图恒兜底首张 + 节点多选追加，添加就显示在
  // 当前里，不切视角）；全部=本集挂接的该类全部实体分组陈列（可跨实
  // 体直接改形象数据）。默认当前——双击节点即看节点所用；换实体重置。
  const [scope, setScope] = useState<"current" | "all">("current");
  useEffect(() => setScope("current"), [entityId, group]);
  const nodePath = group === "character" ? avatarPath : ((entity as ProjectLocation | ProjectProp | undefined)?.ref_path ?? "");
  // 节点挂载的形象集（用户定案「库是全局的，节点只是挂载」）：来源是
  // 标准库面板挑的条目形象图，与该角色自己的形象列表解耦——不做实体
  // 形象集过滤（挂的图可以来自库里任何条目）；无来源节点（输入卡跳转
  // /组）为空。
  const nodeFaceList = useMemo(() => (nodeKey ? ops.nodeFaces[nodeKey] ?? [] : []), [nodeKey, ops.nodeFaces]);
  const nodeViewPaths = scope === "current"
    ? (nodePath ? [nodePath, ...nodeFaceList.filter((p) => p !== nodePath)] : nodeFaceList)
    : [];
  // 库面板里已挂到本节点的条目（含兜底显示的头像/主图自身条目）——面板
  // 标「已关联」禁点，防重复挂。
  const linkedEntryIds = useMemo(() => {
    const mounted = new Set(nodeFaceList);
    if (nodePath) mounted.add(nodePath);
    const lib = group === "character" ? ops.characters : group === "location" ? ops.locations : ops.props;
    return lib
      .filter((e) => {
        const img = group === "character" ? (e as ProjectCharacter).avatar_path : (e as ProjectLocation | ProjectProp).ref_path;
        return !!img && mounted.has(img);
      })
      .map((e) => e.id);
  }, [nodeFaceList, nodePath, group, ops.characters, ops.locations, ops.props]);
  // 本集该类实体（全部视角数据源）：本集 node_links 收集去重；当前实体
  // 恒排首位（不在本集挂接里也兜底并入，自己的形象集始终可见）。
  const episodeEntities = useMemo(() => {
    const ids: string[] = [entityId];
    for (const l of ops.nodeLinks ?? []) {
      if (l.from_kind === group && l.from_id !== entityId && !ids.includes(l.from_id)) ids.push(l.from_id);
    }
    const lib = group === "character" ? ops.characters : group === "location" ? ops.locations : ops.props;
    return ids
      .map((id) => lib.find((e) => e.id === id))
      .filter((e): e is ProjectCharacter | ProjectLocation | ProjectProp => !!e);
  }, [ops.nodeLinks, ops.characters, ops.locations, ops.props, group, entityId]);
  const { nodeFaces } = ops;
  // 全窗唯一归并（用户定案「全部里不能存在重复，标注引用节点就行」）：
  // 同一张图整个「全部」只在首个含它的实体组陈列一次（组内重复的脏数据
  // 一并消除），后续组跳过；卡上标注引用节点数与跨实体归属。只动展示，
  // 库数据（reference_paths）不重写。
  const allScopeGroups = useMemo(() => {
    if (scope !== "all") return [];
    const claimed = new Set<string>();
    return episodeEntities.map((entity) => {
      const all = entityFacePaths(group, entity);
      const visible = [...new Set(all)].filter((p) => !claimed.has(p));
      for (const p of all) claimed.add(p);
      return visible;
    });
  }, [scope, group, episodeEntities]);
  // 图级标注数据：path → 含它的实体名（按组序，首个 = 归并组）；path →
  // 本集挂载它的节点 key（nodeFaces 全集扫描，挂载与实体解耦——引用判定
  // 只看图有没有挂在节点上）。
  const faceMeta = useMemo(() => {
    if (scope !== "all") return null;
    const owners = new Map<string, string[]>();
    for (const e of episodeEntities) {
      // 同一实体的列表可能含重复条目（脏数据），归属名单一个实体只记一次。
      const seen = new Set<string>();
      for (const p of entityFacePaths(group, e)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const list = owners.get(p);
        if (list) list.push(e.name);
        else owners.set(p, [e.name]);
      }
    }
    const refs = new Map<string, string[]>();
    for (const [key, paths] of Object.entries(nodeFaces ?? {})) {
      for (const p of paths) {
        const list = refs.get(p);
        if (list) list.push(key);
        else refs.set(p, [key]);
      }
    }
    return { owners, refs };
  }, [scope, group, episodeEntities, nodeFaces]);
  // 段头计数随视角：当前=本节点那张（1/0）；全部=归并去重后的陈列总数
  // （与实际卡片数一致，不是各实体图集的原始累加）。
  const shownCount = scope === "current"
    ? nodeViewPaths.length
    : allScopeGroups.reduce((sum, paths) => sum + paths.length, 0);
  // 参考图管理：添加（弹对应库面板选条目，用户定案——库条目自带名称/人
  // 设/提示词/音色，选入即成该形象的独立绑定，不弹原始文件框）与逐张移
  // 除；参考图集整体覆写 reference_paths，选条目的绑定落 image_bindings。
  const [pickerOpen, setPickerOpen] = useState(false);
  const removeRef = (refPath: string) => {
    ops.setReferences(group, entityId, refPaths.filter((p) => p !== refPath));
  };
  const linkedSegments = (ops.nodeLinks ?? []).filter(
    (l) => l.from_kind === group && l.from_id === entityId,
  );
  const kindLabel = t(
    group === "character" ? "project.canvas.typeCharacter"
      : group === "location" ? "project.canvas.typeLocation"
        : "project.canvas.typeProp",
  );
  const accent = group === "character" ? "#f472b6" : group === "location" ? "#34d399" : "#fbbf24";
  return (
    <DetailWindow
      title={<><span className="pdetail-kind-label">{kindLabel}</span> · {name}</>}
      accent={accent}
      onClose={ops.onClose}
      back={ops.backTarget ? { onBack: ops.goBack } : undefined}
    >
      <DetailSection
        label={scope === "all" ? t("project.detail.episodeFaces", { kind: kindLabel }) : t("project.detail.faces")}
        count={t("project.detail.refCount", { n: shownCount })}
        extra={(
          <span className="pdetail-sec-tools">
            <div className="pdetail-seg" role="group">
              <button
                type="button"
                className={`pdetail-seg-btn${scope === "current" ? " is-active" : ""}`}
                onClick={() => setScope("current")}
              >
                {t("project.detail.scopeCurrent")}
              </button>
              <button
                type="button"
                className={`pdetail-seg-btn${scope === "all" ? " is-active" : ""}`}
                onClick={() => setScope("all")}
              >
                {t("project.detail.scopeAll")}
              </button>
            </div>
            {scope === "current" && nodeKey && (
              <button type="button" className="pdetail-ref-add" onClick={() => setPickerOpen(true)}>
                {Icons.add}{t("project.detail.refAdd")}
              </button>
            )}
          </span>
        )}
      >
        {scope === "current" ? (
          <div className="pdetail-facelist">
            {nodeViewPaths.length === 0 && (
              <div className="pdetail-empty">{t("project.detail.empty")}</div>
            )}
            {faceCardsOf({
              paths: nodeViewPaths, group, avatarPath, bindingsMap, defProfile,
              entityName: name, refPaths, libraryRoot: ops.libraryRoot,
              fallbackPath: nodePath || undefined,
              entity: entity as ProjectCharacter | ProjectLocation | ProjectProp,
              commit: commitBinding, pickVoice: pickVoiceFor, clearVoice: clearVoiceFor, remove: removeRef,
              setAvatar: (p) => entity && ops.setAvatar(entity as ProjectCharacter, p),
              nodeRemove: nodeKey ? (p) => ops.removeNodeFace(nodeKey, p) : undefined,
              hideRemove: true,
            })}
          </div>
        ) : (
          <div className="pdetail-facegroups">
            <p className="pdetail-note">{t("project.detail.episodeFacesHint")}</p>
            {episodeEntities.map((e, i) => (
              <EntityFaceGroup
                key={e.id}
                group={group}
                entity={e}
                visiblePaths={allScopeGroups[i] ?? []}
                faceMeta={faceMeta}
                ops={ops}
              />
            ))}
          </div>
        )}
      </DetailSection>
      {pickerOpen && nodeKey && (
        <ProjectLibraryPanel
          kind={group === "character" ? "characters" : group === "location" ? "locations" : "props"}
          mode="pick"
          pickTitle={t("project.detail.facePickTitle", { kind: kindLabel })}
          linkedIds={linkedEntryIds}
          disabledIds={facelessIds(group, ops)}
          disabledLabel={t("project.library.noFaceImage")}
          onClose={() => setPickerOpen(false)}
          onPick={(id) => {
            // 库条目点选 = 双写（用户定案「挑一次，两处都有，不能挑完就
            // 丢」）：① 图收进该角色的形象列表（「全部」视角分组可见）；
            // ② 同步挂上本节点（「当前」视角可见）。图已在角色列表时只
            // 补挂载，不重复落库。
            if (!entity) {
              setPickerOpen(false);
              return;
            }
            const res = addPickedFace(group, entity, id, ops);
            if (res.path && nodeKey) ops.addNodeFace(nodeKey, res.path);
            setPickerOpen(false);
          }}
        />
      )}
      <DetailSection label={t("project.detail.defaultSection", { kind: kindLabel })}>
        <p className="pdetail-note">{t("project.detail.defaultHint")}</p>
        {group === "character" && (
          <div className="pdetail-f-gap">
            <VoiceRow
              voicePath={voice}
              onPick={() => {
                void (async () => {
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    const picked = await invoke<{ path: string }>("canvas_pick_media_file", { extensions: [...AUDIO_EXTS] });
                    ops.setVoice(entityId, picked.path);
                  } catch {
                    // 用户取消或 mock 环境无后端：静默。
                  }
                })();
              }}
              onClear={() => ops.setVoice(entityId, "")}
            />
          </div>
        )}
        <DefaultProfileFields
          key={`${group}-${entityId}`}
          initialBio={entity?.bio ?? ""}
          initialPrompt={(entity as { prompt?: string } | undefined)?.prompt ?? ""}
          bioLabel={group === "character" ? t("project.detail.bioLabel") : t("project.detail.describeLabel")}
          onCommit={(bio, prompt) => ops.saveProfile(group, entityId, bio, prompt)}
        />
      </DetailSection>
      <DetailSection label={t("project.detail.stats")}>
        <p className="pdetail-text">
          {t("project.detail.statLine", {
            episodes: (entity as ProjectCharacter | undefined)?.episode_ref_count ?? 0,
            segments: linkedSegments.length,
          })}
        </p>
      </DetailSection>
    </DetailWindow>
  );
}

/** 实体全量图集（与实体详情窗参考图集同语义：头像/旧主图排首位并入，
 *  已在数组中不重复入列）——片段输入卡据此一图一卡陈列（用户定案），
 *  与实体窗参考图集对称。 */
function entityThumbPaths(kind: string, id: string, ops: DetailWindowOps): string[] {
  if (kind === "character") {
    const c = ops.characters.find((x) => x.id === id);
    if (!c) return [];
    const list = parseRefs(c.reference_paths);
    if (c.avatar_path && !list.includes(c.avatar_path)) list.unshift(c.avatar_path);
    return list;
  }
  if (kind === "location" || kind === "prop") {
    const e = kind === "location" ? ops.locations.find((x) => x.id === id) : ops.props.find((x) => x.id === id);
    if (!e) return [];
    const list = parseRefs(e.reference_paths);
    if (e.ref_path && !list.includes(e.ref_path)) list.unshift(e.ref_path);
    return list;
  }
  return [];
}

/** JSON 数组安全解析（三库 reference_paths，非法/缺省按空）。 */
function parseRefs(raw: string | undefined): string[] {
  try {
    const list = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** 实体参考图集（reference_paths 为主，场景/道具旧单张 ref_path 并入；
 *  不含头像——头像不可移除）。 */
function entityRefPaths(group: EntityPhKind, entity: ProjectCharacter | ProjectLocation | ProjectProp): string[] {
  const list = parseRefs(entity.reference_paths);
  const mainRef = group !== "character" ? ((entity as ProjectLocation | ProjectProp).ref_path ?? "") : "";
  if (mainRef && !list.includes(mainRef)) list.unshift(mainRef);
  return list;
}

/** 实体全量图集 = 参考图 + 形象头像（头像排首位，不重复入列）。 */
function entityFacePaths(group: EntityPhKind, entity: ProjectCharacter | ProjectLocation | ProjectProp): string[] {
  const list = entityRefPaths(group, entity);
  const avatar = group === "character" ? ((entity as ProjectCharacter).avatar_path ?? "") : "";
  if (avatar && !list.includes(avatar)) list.unshift(avatar);
  return list;
}

/** 每图绑定（形象卡方案 A）：path → 独立值；未绑定 path 或字段为空 =
 *  跟随实体级默认。 */
function entityBindings(entity: ProjectCharacter | ProjectLocation | ProjectProp): Record<string, ImageBinding> {
  const map: Record<string, ImageBinding> = {};
  try {
    const parsed = JSON.parse(entity.image_bindings ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const p = (item as { path?: unknown } | null)?.path;
        if (item && typeof item === "object" && typeof p === "string") {
          const b = item as Partial<ImageBinding>;
          map[p] = { path: p, name: b.name ?? "", voice_path: b.voice_path ?? "", bio: b.bio ?? "", prompt: b.prompt ?? "", time_hint: b.time_hint ?? "" };
        }
      }
    }
  } catch {
    // 非法 JSON：按无绑定处理（全部跟随默认）。
  }
  return map;
}

/** 无形象图条目 id（角色无头像 / 场景道具无主图）：添加形象面板里禁点
 *  ——点了不会添加任何东西，静默无反应会被当成功能坏了。 */
function facelessIds(group: EntityPhKind, ops: DetailWindowOps): string[] {
  const lib = group === "character" ? ops.characters : group === "location" ? ops.locations : ops.props;
  return lib
    .filter((e) => !(group === "character" ? (e as ProjectCharacter).avatar_path : (e as ProjectLocation | ProjectProp).ref_path))
    .map((e) => e.id);
}

/** 片段输入分组：按口聚合（角色/场景/道具/提示词/剧本/其他），组头计数
 *  + 折叠；每组一行横滑条带陈列全部输入（用户定案「有多少陈列清楚，
 *  多了滚轮左右滑」）。一图一卡：单实体逐张参考图各成一卡、组逐成员各
 *  成一卡（卡名=成员名），图按原始比例完整展示（复用画布图像逻辑）；
 *  点卡片跳对应详情窗（头部返回键跳回来）；移除键=右上角悬浮小图标
 *  （hover 显形）+ 确认框；暂存占位卡=虚线图标块。 */

/** 横滑条带：竖向滚轮增量映射为横向滚动（React 根代理的 wheel 是被动
 *  监听，preventDefault 需原生非被动监听）；条带装得下时不拦截，页面
 *  照常竖滚。 */
function HStrip({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div ref={ref} className="pdetail-ingrid">
      {children}
    </div>
  );
}

function SegmentInputs({ segmentId, ops }: { segmentId: string; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  // 移除确认（用户定案「删除要有确定选项」）：确认框 portal body z1000
  // 压过详情窗与全部二级浮层，确认后才真正调 removeLink。
  const [removeAsk, setRemoveAsk] = useState<{ message: string; run(): void } | null>(null);
  const rows = ops.nodeLinks.filter((l) => l.to_segment === segmentId);
  const pends = ops.pendingLinks.filter((l) => l.toSegmentId === segmentId);
  const ports: Array<{ id: string; label: string; color: string }> = [
    { id: "character", label: t("project.canvas.typeCharacter"), color: "#f472b6" },
    { id: "location", label: t("project.canvas.typeLocation"), color: "#34d399" },
    { id: "prop", label: t("project.canvas.typeProp"), color: "#fbbf24" },
    { id: "prompt", label: t("project.canvas.typePrompt"), color: "#22d3ee" },
    { id: "script", label: t("project.canvas.typeScript"), color: "#fb923c" },
    { id: "other", label: t("project.canvas.typeOther"), color: "#94a3b8" },
  ];
  const nameOf = (kind: string, id: string): string => {
    if (kind === "character") return ops.characters.find((c) => c.id === id)?.name ?? id;
    if (kind === "location") return ops.locations.find((l) => l.id === id)?.name ?? id;
    if (kind === "prop") return ops.props.find((p) => p.id === id)?.name ?? id;
    if (kind === "segment") return `#${ops.segments.findIndex((s) => s.id === id) + 1}`;
    if (kind === "shot") {
      const shot = ops.overview?.scenes.flatMap((s) => s.shots).find((item) => item.id === id);
      return shot?.description || id;
    }
    return id;
  };
  const pendingFromLabel = (fromKey: string): string => {
    if (fromKey.startsWith("eph:")) return t("project.detail.pendingPh");
    if (fromKey.startsWith("prompt:")) return t("project.canvas.typePrompt");
    if (fromKey.startsWith("script:")) return t("project.canvas.typeScript");
    return fromKey;
  };
  // 一图一卡展开（用户定案「一个[图]一个卡片，不要挤在一张卡里」）：
  // 单实体 = 全量图集逐张成卡（与实体窗参考图集对称，素材无上限不设
  // 帽）；组 = 逐成员逐张成卡（卡名=成员名）；无图实体 = 一张图标占位
  // 卡。组头计数与实际卡数一致。
  type InCard = {
    key: string;
    row: ProjectNodeLink;
    label: string;
    path: string;
    fileName: string | null;
    openable: boolean;
    isText: boolean;
  };
  const expandCards = (row: ProjectNodeLink): InCard[] => {
    const owner = row.owner_key ?? "";
    const isGroup = owner.startsWith("grp:");
    const resolved = isGroup
      ? (ops.overview?.node_links ?? []).filter((l) => l.owner_key === owner && l.to_segment === row.to_segment && l.to_port === row.to_port)
      : [row];
    // 概览未载/组线悬空：退化为认领行自身成卡，不吞卡。
    const members = resolved.length > 0 ? resolved : [row];
    return members.flatMap((m) => {
      const imgs = entityThumbPaths(m.from_kind, m.from_id, ops);
      const list = imgs.length > 0 ? imgs : [""];
      const label = nameOf(m.from_kind, m.from_id);
      return list.map((p, i) => ({
        key: `${m.id}-${i}`,
        row: m,
        label,
        path: p,
        fileName: list.length > 1 && p ? (p.split(/[\\/]/).pop() ?? null) : null,
        openable: ["character", "location", "prop", "segment", "shot"].includes(m.from_kind),
        isText: m.from_kind === "script",
      }));
    });
  };
  const openCardOf = (c: InCard) => () => {
    const k = c.row.from_kind;
    if (k === "character" || k === "location" || k === "prop") {
      const prefix = k === "character" ? "char" : k === "location" ? "loc" : "prop";
      ops.openDetail({ kind: "info", group: k as EntityPhKind, sourceKey: `${prefix}:${c.row.from_id}` });
    } else if (k === "segment" || k === "shot") {
      ops.openDetail({ kind: "segment", id: c.row.from_id });
    }
  };
  return (
    <>
      {ports.map((port) => {
        const portRows = rows.filter((l) => l.to_port === port.id);
        const portPends = pends.filter((l) => l.toPort === port.id);
        const cards = portRows.flatMap(expandCards);
        if (cards.length + portPends.length === 0) return null;
        return (
          <DetailSection key={port.id} label={port.label} count={cards.length + portPends.length} foldable defaultFold={false}>
            <div className="pdetail-dot" style={{ background: port.color }} />
            <HStrip>
              {cards.map((c) => (
                <div key={c.key} className={`pdetail-incard${c.openable ? " is-openable" : ""}`}>
                  <button
                    type="button"
                    className="pdetail-incard-view"
                    onClick={c.openable ? openCardOf(c) : undefined}
                    aria-label={c.label}
                  >
                    {c.path ? (
                      <>
                        <ResourceFileImage path={joinLibraryPath(ops.libraryRoot, c.path)} alt="" className="pdetail-incard-ghost" />
                        <ResourceFileImage path={joinLibraryPath(ops.libraryRoot, c.path)} alt="" className="pdetail-incard-img" />
                      </>
                    ) : (
                      <span className="pdetail-incard-fallback">{c.isText ? Icons.file : Icons.image}</span>
                    )}
                  </button>
                  <div className="pdetail-incard-meta">
                    <b className="pdetail-incard-name" title={c.label}>
                      {c.label}
                    </b>
                    {c.fileName && <small className="pdetail-incard-members">{c.fileName}</small>}
                  </div>
                  {/* 移除键：右上角悬浮小图标（hover 显形），点击先确认；
                      同实体多卡共享一条认领线，任一卡移除即整线断。 */}
                  <button
                    type="button"
                    className="pdetail-incard-x"
                    title={t("project.detail.remove")}
                    aria-label={t("project.detail.remove")}
                    onClick={() =>
                      setRemoveAsk({
                        message: t("project.detail.segRemoveConfirm", { name: c.label }),
                        run: () => ops.removeLink({ pending: false, fromKey: c.row.from_id, toSegment: segmentId, toPort: c.row.to_port, ownerKey: c.row.owner_key ?? "", rowId: c.row.id }),
                      })
                    }
                  >
                    {Icons.close}
                  </button>
                </div>
              ))}
              {portPends.map((p) => {
                const pendLabel = pendingFromLabel(p.fromKey);
                return (
                  <div key={`pend-${p.fromKey}`} className="pdetail-incard is-pending">
                    <span className="pdetail-incard-view is-static">
                      <span className="pdetail-incard-fallback">{Icons.image}</span>
                    </span>
                    <div className="pdetail-incard-meta">
                      <b className="pdetail-incard-name">{pendLabel}</b>
                    </div>
                    <button
                      type="button"
                      className="pdetail-incard-x"
                      title={t("project.detail.remove")}
                      aria-label={t("project.detail.remove")}
                      onClick={() =>
                        setRemoveAsk({
                          message: t("project.detail.segRemoveConfirm", { name: pendLabel }),
                          run: () => ops.removeLink({ pending: true, fromKey: p.fromKey, toSegment: segmentId, toPort: p.toPort, ownerKey: "" }),
                        })
                      }
                    >
                      {Icons.close}
                    </button>
                  </div>
                );
              })}
            </HStrip>
          </DetailSection>
        );
      })}
      {/* 移除确认框：顶层 portal（z1000），确认后才执行 removeAsk.run。 */}
      {removeAsk && (
        <ConfirmDialog message={removeAsk.message} onConfirm={removeAsk.run} onCancel={() => setRemoveAsk(null)} />
      )}
    </>
  );
}

/** 批量挂靠浮层：三库 tab + 复选行 + 确认（逐条 linkNode）。 */
function AttachPicker({ segmentId, ops, onClose }: { segmentId: string; ops: DetailWindowOps; onClose(): void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<EntityPhKind>("character");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const list = tab === "character" ? ops.characters : tab === "location" ? ops.locations : ops.props;
  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div className="pdetail-attach">
      <div className="pdetail-attach-tabs">
        {(["character", "location", "prop"] as EntityPhKind[]).map((k) => (
          <button key={k} type="button" className={tab === k ? "is-active" : ""} onClick={() => { setTab(k); setPicked(new Set()); }}>
            {t(k === "character" ? "project.canvas.typeCharacter" : k === "location" ? "project.canvas.typeLocation" : "project.canvas.typeProp")}
          </button>
        ))}
      </div>
      <div className="pdetail-attach-list">
        {list.map((e) => (
          <label key={e.id} className="pdetail-attach-row">
            <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
            <span>{e.name}</span>
          </label>
        ))}
        {list.length === 0 && <div className="pdetail-empty">{t("project.detail.empty")}</div>}
      </div>
      <div className="pdetail-attach-ops">
        <button type="button" onClick={onClose}>{t("common.cancel")}</button>
        <button
          type="button"
          className="is-primary"
          disabled={picked.size === 0}
          onClick={() => {
            ops.attachEntities(segmentId, tab, Array.from(picked).map((id) => ({ kind: tab, id })));
            onClose();
          }}
        >
          {t("project.detail.attachN", { n: picked.size })}
        </button>
      </div>
    </div>
  );
}

/** 片段详情体：产出常显第一屏 + 输入按口分组 + 批量挂靠（动作区钉底）。 */
function SegmentDetail({ segmentId, ops }: { segmentId: string; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const index = ops.segments.findIndex((s) => s.id === segmentId);
  const segment = ops.segments[index];
  const [attachOpen, setAttachOpen] = useState(false);
  if (!segment) return null;
  return (
    <DetailWindow
      title={<><span className="pdetail-kind-label">{t("project.canvas.segName")}</span> · {segment.note || `#${index + 1}`}</>}
      accent="#a78bfa"
      onClose={ops.onClose}
      back={ops.backTarget ? { onBack: ops.goBack } : undefined}
      foot={(
        <>
          <button type="button" className="pdetail-foot-btn" onClick={() => ops.openOutputPick(segmentId)}>
            {t(segment.asset ? "project.detail.outputReplace" : "project.detail.outputPick")}
          </button>
          <button type="button" className="pdetail-foot-btn" onClick={() => setAttachOpen(true)}>
            {t("project.detail.attachPick")}
          </button>
        </>
      )}
    >
      <DetailSection label={t("project.detail.output")} count={segment.asset ? "" : t("project.detail.outputEmpty")}>
        {segment.asset ? (
          <div className="pdetail-output">
            <ResourceVideoPoster
              path={joinLibraryPath(ops.libraryRoot, segment.asset.file_path)}
              version={segment.asset.updated_at}
              fallbackLabel={segment.asset.name || segment.asset.file_path}
            />
            <span className="pdetail-output-name">{segment.asset.name || segment.asset.file_path}</span>
          </div>
        ) : (
          <div className="pdetail-empty">{Icons.link}{t("project.detail.segOutputEmpty")}</div>
        )}
      </DetailSection>
      <DetailSection label={t("project.detail.inputs")}>
        <div className="pdetail-inputs">
          <SegmentInputs segmentId={segmentId} ops={ops} />
        </div>
      </DetailSection>
      {attachOpen && <AttachPicker segmentId={segmentId} ops={ops} onClose={() => setAttachOpen(false)} />}
    </DetailWindow>
  );
}

/** 空白占位详情（用户定案「双击永远先进窗，库选择框从窗里按钮弹出」）：
 *  空态 + 钉底「从库中装入」按钮 → 弹标准库面板挑条目 → 装入后由 Shell
 *  把本窗切换成该实体的详情窗（当前视角），后续操作与已装节点一致。 */
function EntityPhDetail({ id, group, ops }: { id: string; group: EntityPhKind; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const kindLabel = t(
    group === "character" ? "project.canvas.typeCharacter"
      : group === "location" ? "project.canvas.typeLocation"
        : "project.canvas.typeProp",
  );
  return (
    <DetailWindow title={<><span className="pdetail-kind-label">{kindLabel}</span> · {t("project.canvas.ephTitle")}</>} accent="#94a3b8" onClose={ops.onClose}
      back={ops.backTarget ? { onBack: ops.goBack } : undefined}
      foot={(
        <button type="button" className="pdetail-foot-btn" onClick={() => setPickerOpen(true)}>
          {t("project.detail.loadEntity")}
        </button>
      )}
    >
      <div className="pdetail-empty">{Icons.link}{t("project.detail.ephEmptyHint", { kind: kindLabel })}</div>
      {pickerOpen && (
        <ProjectLibraryPanel
          kind={group === "character" ? "characters" : group === "location" ? "locations" : "props"}
          mode="pick"
          pickTitle={t("project.detail.loadEntity")}
          onClose={() => setPickerOpen(false)}
          onPick={(eid) => {
            // 挑完即装入：Shell 装入完成后会把本窗切换成该实体的详情窗。
            ops.loadEntity(id, group, eid);
          }}
        />
      )}
    </DetailWindow>
  );
}

/** 详情窗装配（Shell 按 detailFor 分派）。 */
export function ProjectDetailWindow({ target, ops }: { target: DetailTarget; ops: DetailWindowOps }) {
  if (target.kind === "segment") return <SegmentDetail segmentId={target.id} ops={ops} />;
  if (target.kind === "entityPh") return <EntityPhDetail id={target.id} group={target.group} ops={ops} />;
  if (target.kind === "promptPh") return <PromptPhDetail id={target.id} ops={ops} />;
  if (target.kind === "scriptPh") return <ScriptPhDetail phKey={target.key} ops={ops} />;
  if (target.kind === "output") return <OutputDetail ops={ops} />;
  return <EntityDetail group={target.group} sourceKey={target.sourceKey} nodeKey={target.nodeKey} ops={ops} />;
}

/** 剧本详情体（主剧本 key="script" / 画布剧本纸片 script:<phid>）：已挂接
 *  = 文件名 + 头部内容预览（readResourceTextPreview 与纸片同源）；未挂接 =
 *  空态。动作区钉底「挂接/更换剧本」开文件选择浮层（详情窗保持打开）。 */
function ScriptPhDetail({ phKey, ops }: { phKey: string; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const isMain = phKey === "script";
  const path = isMain
    ? (ops.overview?.episode.script_path ?? "")
    : (ops.scriptPhs.find((ph) => `script:${ph.id}` === phKey)?.path ?? "");
  const fileName = path.split(/[\\/]/).pop() ?? "";
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    readResourceTextPreview(joinLibraryPath(ops.libraryRoot, path))
      .then((result) => {
        if (!cancelled) setPreview(result.content);
      })
      .catch(() => {
        if (!cancelled) setPreview("");
      });
    return () => {
      cancelled = true;
    };
  }, [path, ops.libraryRoot]);
  return (
    <DetailWindow
      title={<><span className="pdetail-kind-label">{t("project.detail.scriptKind")}</span> · {isMain ? t("project.detail.scriptMain") : fileName || t("project.detail.scriptNotLinked")}</>}
      accent="#fb923c"
      onClose={ops.onClose}
      back={ops.backTarget ? { onBack: ops.goBack } : undefined}
      foot={(
        <button type="button" className="pdetail-foot-btn" onClick={() => ops.openScriptPick(phKey)}>
          {path ? t("project.detail.scriptChange") : t("project.canvas.linkScript")}
        </button>
      )}
    >
      {path ? (
        <>
          <DetailSection label={t("project.detail.scriptFile")}>
            <p className="pdetail-text pdetail-text-strong">{fileName || path}</p>
          </DetailSection>
          <DetailSection label={t("project.detail.scriptPreview")}>
            <p className="pdetail-text pdetail-text-prompt">{preview === null ? "…" : preview || t("project.detail.empty")}</p>
          </DetailSection>
        </>
      ) : (
        <DetailSection label={t("project.detail.scriptFile")}>
          <div className="pdetail-empty">{Icons.file}{t("project.detail.scriptEmptyHint")}</div>
        </DetailSection>
      )}
    </DetailWindow>
  );
}

/** 成片详情体（成片卡双击）：output_asset_id 定位资产，视频海报预览 +
 *  文件名；未产出=空态。 */
function OutputDetail({ ops }: { ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const overview = ops.overview;
  const outputId = overview?.episode.output_asset_id ?? "";
  const asset = outputId
    ? overview?.loose_assets.find((a) => a.id === outputId)
      ?? overview?.scenes.flatMap((s) => s.shots).flatMap((sh) => sh.assets).find((a) => a.id === outputId)
    : undefined;
  return (
    <DetailWindow
      title={<><span className="pdetail-kind-label">{t("project.detail.outputKind")}</span>{asset ? <> · {asset.name || asset.file_path}</> : null}</>}
      accent="#c084fc"
      onClose={ops.onClose}
      back={ops.backTarget ? { onBack: ops.goBack } : undefined}
    >
      <DetailSection label={t("project.detail.output")} count={asset ? "" : t("project.detail.outputEmpty")}>
        {asset ? (
          <div className="pdetail-output">
            <ResourceVideoPoster
              path={joinLibraryPath(ops.libraryRoot, asset.file_path)}
              version={asset.updated_at}
              fallbackLabel={asset.name || asset.file_path}
            />
            <span className="pdetail-output-name">{asset.name || asset.file_path}</span>
          </div>
        ) : (
          <div className="pdetail-empty">{Icons.clapperboard}{t("project.detail.outputEmptyHint")}</div>
        )}
      </DetailSection>
    </DetailWindow>
  );
}

/** 提示词纸片详情：挂接的提示词标题 + 全文只读（纸片节点小窗看不全），
 *  空纸片=空态。动作区钉底「选择/更换提示词」开提示词库选浮层（详情窗
 *  保持打开，浮层叠加在其上）。 */
function PromptPhDetail({ id, ops }: { id: string; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const ph = ops.promptPhs.find((item) => item.id === id);
  const prompt = ph ? ops.prompts.find((item) => item.id === ph.promptId) : undefined;
  return (
    <DetailWindow
      title={<><span className="pdetail-kind-label">{t("project.detail.promptKind")}</span> · {prompt?.title ?? t("project.canvas.promptEmpty")}</>}
      accent="#22d3ee"
      onClose={ops.onClose}
      back={ops.backTarget ? { onBack: ops.goBack } : undefined}
      foot={(
        <button type="button" className="pdetail-foot-btn" onClick={() => ops.openPromptPick(`prompt:${id}`)}>
          {prompt ? t("project.detail.promptChange") : t("project.canvas.promptPickTitle")}
        </button>
      )}
    >
      {prompt ? (
        <>
          <DetailSection label={t("project.detail.promptTitleLabel")}>
            <p className="pdetail-text">{prompt.title}</p>
          </DetailSection>
          <DetailSection label={t("project.detail.promptContentLabel")}>
            <p className="pdetail-text pdetail-text-prompt">{prompt.content || t("project.detail.empty")}</p>
          </DetailSection>
        </>
      ) : (
        <DetailSection label={t("project.detail.promptContentLabel")}>
          <div className="pdetail-empty">{Icons.link}{t("project.detail.promptEmptyHint")}</div>
        </DetailSection>
      )}
    </DetailWindow>
  );
}
