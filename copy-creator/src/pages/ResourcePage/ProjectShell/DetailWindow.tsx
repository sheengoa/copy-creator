import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import type {
  EpisodeOverview,
  ProjectCharacter,
  ProjectLocation,
  ProjectNodeLink,
  ProjectPrompt,
  ProjectProp,
  ProjectSegment,
} from "../../../stores/projectStore";
import { joinLibraryPath } from "../../../domain/projectView";
import { readResourceTextPreview } from "../../../domain/mediaAssets";
import { ResourceFileImage, ResourceImage, ResourceVideoPoster } from "../ResourceMedia";
import type { EntityPhKind, PendingLink, PromptPh, ScriptPh } from "./types";
import { MediaPlayback } from "../../../components/MediaPlayback";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import ProjectFilePickerDialog from "../ProjectFilePickerDialog";

// 工程节点详情窗（工程视图节点化 2026-11-05 阶段 D，方案 §D2-D5）：
// 三段式——头部（标题+关闭）/主体（内部滚动，顶到哪滚到哪）/动作区钉底
// （任何滚动位置可用），亮暗两套走主题变量。角色/场景/道具共用实体骨架
// （参考图网格 30/批懒加载 + 设头像 + 音色行[仅角色] + 人设 + 统计）；
// 片段=产出常显 + 输入按口分组折叠 + 批量挂靠 + 逐项移除；空白占位=实体
// 装入（选择即关联+暂存线转正+占位移除）。

/** 详情窗目标（Shell 的 detailFor 状态同构，B 阶段已接工具按钮）。 */
export type DetailTarget =
  | { kind: "info"; group: EntityPhKind; sourceKey: string }
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
  /** 窗内跳转其它详情（输入卡点击展开：实体/组/片段窗互跳）。 */
  openDetail(target: DetailTarget): void;
  /** 装入占位实体（关联到集 + 暂存线转正 + 占位移除）。 */
  loadEntity(ephId: string, kind: EntityPhKind, entityId: string): void;
  /** 移除片段输入（正式行/暂存线分派）。 */
  removeLink(row: { pending: boolean; fromKey: string; toSegment: string; toPort: string; ownerKey: string; rowId?: string }): void;
  /** 批量挂靠（多选实体逐条落 node_link）。 */
  attachEntities(segmentId: string, port: string, entities: Array<{ kind: EntityPhKind; id: string }>): void;
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
  // Esc 关最上层（无二级面板，直接关）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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

/** 参考图卡片网格：1:1 复刻旧 ProjectNodeDetailDialog 的 pc-detail-card
 *  形态（16:10 预览框 contain 完整展示 + 卡底常驻动作行，auto-fill
 *  minmax(215px,1fr) 多列网格）——素材天然多张，网格规整铺开（用户定案
 *  还原旧实现展示）。30/批懒加载滚动续载保留。 */
function RefGrid({ paths, libraryRoot, onSetAvatar, removableOf, onRemove }: {
  paths: string[];
  libraryRoot: string;
  onSetAvatar?(refPath: string): void;
  /** 哪些图可移除（头像并入展示的行不可移除，只作形象展示）。 */
  removableOf?(refPath: string): boolean;
  onRemove?(refPath: string): void;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(REF_PAGE);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // 懒加载：滚动到底自动续一批（重置列表时回首批）。
  useEffect(() => setLoaded(REF_PAGE), [paths]);
  const onScroll = () => {
    const el = gridRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
      setLoaded((v) => (v < paths.length ? Math.min(v + REF_PAGE, paths.length) : v));
    }
  };
  if (paths.length === 0) {
    return <div className="pdetail-empty">{Icons.image}{t("project.canvas.noRefImage")}</div>;
  }
  return (
    <div className="pdetail-refgrid-wrap">
      <div className="pdetail-refgrid" ref={gridRef} onScroll={onScroll}>
        {paths.slice(0, loaded).map((refPath, i) => {
          const removable = removableOf?.(refPath) ?? false;
          const fileName = refPath.split(/[\\/]/).pop() ?? refPath;
          return (
            <div key={`${refPath}-${i}`} className="pdetail-refcard">
              <div className="pdetail-refcard-view">
                <ResourceImage path={joinLibraryPath(libraryRoot, refPath)} alt={fileName} className="pdetail-refcard-img" />
              </div>
              <div className="pdetail-refcard-meta">
                <b className="pdetail-refcard-name" title={fileName}>{fileName}</b>
              </div>
              {(onSetAvatar || (removable && onRemove)) && (
                <div className="pdetail-refcard-ops">
                  {onSetAvatar && (
                    <button type="button" className="pdetail-refact" onClick={() => onSetAvatar(refPath)}>
                      {t("project.detail.setAvatar")}
                    </button>
                  )}
                  {removable && onRemove && (
                    <button type="button" className="pdetail-refact is-danger" onClick={() => onRemove(refPath)}>
                      {t("project.detail.refRemove")}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {loaded < paths.length && (
        <div className="pdetail-more">{t("project.detail.loadMore", { rest: paths.length - loaded })}</div>
      )}
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

/** 实体详情体（角色/场景/道具）：参考图网格 + 音色[角色] + 人设 + 统计。 */
function EntityDetail({ group, sourceKey, ops }: { group: EntityPhKind; sourceKey: string; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const { overview, characters, locations, props } = ops;
  const entityId = sourceKey.startsWith("grp:")
    ? (overview?.node_links ?? []).find((l) => l.owner_key === sourceKey)?.from_id ?? ""
    : sourceKey.slice(sourceKey.indexOf(":") + 1);
  const entity: ProjectCharacter | ProjectLocation | ProjectProp | undefined =
    group === "character" ? characters.find((c) => c.id === entityId)
      : group === "location" ? locations.find((l) => l.id === entityId)
        : props.find((p) => p.id === entityId);
  const name = entity?.name ?? "";
  // 参考图集（三库统一）：reference_paths JSON 数组为主，场景/道具的旧
  // 单张 ref_path 并入展示（素材天然多张无上限，用户反馈）。头像排首位
  // 仅作形象展示（不可移除），计数与实际展示一致。
  const refPaths = useMemo(() => {
    let list: string[] = [];
    try {
      const parsed = JSON.parse(entity?.reference_paths ?? "[]") as unknown;
      if (Array.isArray(parsed)) list = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      // 旧数据非法 JSON：按空处理。
    }
    const mainRef = group !== "character" ? ((entity as ProjectLocation | ProjectProp | undefined)?.ref_path ?? "") : "";
    if (mainRef && !list.includes(mainRef)) list.unshift(mainRef);
    return list;
  }, [entity, group]);
  const voice = group === "character" ? ((entity as ProjectCharacter | undefined)?.voice_path ?? "") : "";
  // 展示列表 = 参考图 + 形象头像（头像排首位）——详情窗是预览窗，已有
  // 形象必须直接可见，计数与实际展示一致（用户反馈「共 0 张」下却有图）。
  const avatarPath = group === "character" ? ((entity as ProjectCharacter | undefined)?.avatar_path ?? "") : "";
  const gridPaths = useMemo(() => {
    const list = [...refPaths];
    if (avatarPath && !list.includes(avatarPath)) list.unshift(avatarPath);
    return list;
  }, [refPaths, avatarPath]);
  // 参考图管理：添加（库选/导入，浮层保持连续加）与逐张移除，整体覆写
  // reference_paths（project_set_references）。
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
  const pickVoice = () => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const picked = await invoke<{ path: string }>("canvas_pick_media_file", { extensions: ["wav", "mp3", "flac", "ogg"] });
        ops.setVoice(entityId, picked.path);
      } catch {
        // 用户取消或 mock 环境无后端：静默。
      }
    })();
  };
  return (
    <DetailWindow
      title={<><span className="pdetail-kind-label">{kindLabel}</span> · {name}</>}
      accent={accent}
      onClose={ops.onClose}
      back={ops.backTarget ? { onBack: ops.goBack } : undefined}
    >
      <DetailSection
        label={t("project.detail.refs")}
        count={t("project.detail.refCount", { n: gridPaths.length })}
        extra={(
          <button type="button" className="pdetail-ref-add" onClick={() => setPickerOpen(true)}>
            {Icons.add}{t("project.detail.refAdd")}
          </button>
        )}
      >
        <RefGrid
          paths={gridPaths}
          libraryRoot={ops.libraryRoot}
          onSetAvatar={group === "character" ? (ref) => entity && ops.setAvatar(entity as ProjectCharacter, ref) : undefined}
          removableOf={(p) => refPaths.includes(p)}
          onRemove={removeRef}
        />
      </DetailSection>
      {pickerOpen && (
        <ProjectFilePickerDialog
          title={t("project.detail.refAdd")}
          pickLabel={t("project.library.pickAction")}
          importLabel={t("project.library.importAction")}
          onClose={() => setPickerOpen(false)}
          onPick={(file) => {
            // 选一张加一张即关（用户实测「选完不消失」）；要再加点段头按钮重开。
            if (!refPaths.includes(file.filePath)) {
              ops.setReferences(group, entityId, [...refPaths, file.filePath]);
            }
            setPickerOpen(false);
          }}
        />
      )}
      {group === "character" && (
        <DetailSection label={t("project.detail.voice")} count={voice ? "1" : "0"}>
          <VoiceRow
            voicePath={voice}
            onPick={pickVoice}
            onClear={() => ops.setVoice(entityId, "")}
          />
        </DetailSection>
      )}
      <DetailSection label={t("project.detail.profile")}>
        <p className="pdetail-text">{(entity?.bio ?? "") || t("project.detail.empty")}</p>
        {(entity?.prompt ?? "") && <p className="pdetail-text pdetail-text-prompt">{(entity as { prompt?: string }).prompt}</p>}
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
                      <ResourceFileImage path={joinLibraryPath(ops.libraryRoot, c.path)} alt="" className="pdetail-incard-img" />
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

/** 空白占位详情：实体装入（选择即关联 + 暂存线转正 + 占位移除）。 */
function EntityPhDetail({ id, group, ops }: { id: string; group: EntityPhKind; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const list = group === "character" ? ops.characters : group === "location" ? ops.locations : ops.props;
  const kindLabel = t(
    group === "character" ? "project.canvas.typeCharacter"
      : group === "location" ? "project.canvas.typeLocation"
        : "project.canvas.typeProp",
  );
  return (
    <DetailWindow title={<><span className="pdetail-kind-label">{kindLabel}</span> · {t("project.canvas.ephTitle")}</>} accent="#94a3b8" onClose={ops.onClose}
      back={ops.backTarget ? { onBack: ops.goBack } : undefined}>
      <DetailSection label={t("project.detail.loadEntity")}>
        <div className="pdetail-attach-list is-flat">
          {list.map((e) => (
            <button key={e.id} type="button" className="pdetail-attach-row" onClick={() => ops.loadEntity(id, group, e.id)}>
              <ResourceFileImage
                path={joinLibraryPath(ops.libraryRoot, (e as ProjectCharacter).avatar_path ?? (e as ProjectLocation | ProjectProp).ref_path ?? "")}
                alt=""
                className="pdetail-attach-thumb"
              />
              <span>{e.name}</span>
            </button>
          ))}
          {list.length === 0 && <div className="pdetail-empty">{t("project.detail.empty")}</div>}
        </div>
      </DetailSection>
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
  return <EntityDetail group={target.group} sourceKey={target.sourceKey} ops={ops} />;
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
