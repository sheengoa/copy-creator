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
import { ResourceFileImage, ResourceImage, ResourceVideoPoster } from "../ResourceMedia";
import type { EntityPhKind, PendingLink, PromptPh } from "./types";
import { MediaPlayback } from "../../../components/MediaPlayback";

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
  | { kind: "promptPh"; id: string };

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
  /** 音色行：选择/清除（set_character_voice）。 */
  setVoice(id: string, voicePath: string): void;
  /** 设头像（参考图网格的「设为头像」）。 */
  setAvatar(character: ProjectCharacter, refPath: string): void;
  /** 装入占位实体（关联到集 + 暂存线转正 + 占位移除）。 */
  loadEntity(ephId: string, kind: EntityPhKind, entityId: string): void;
  /** 移除片段输入（正式行/暂存线分派）。 */
  removeLink(row: { pending: boolean; fromKey: string; toSegment: string; toPort: string; ownerKey: string; rowId?: string }): void;
  /** 批量挂靠（多选实体逐条落 node_link）。 */
  attachEntities(segmentId: string, port: string, entities: Array<{ kind: EntityPhKind; id: string }>): void;
  /** 提示词纸片「更换提示词」：关详情窗、开提示词库选浮层（同一纸片目标）。 */
  reopenPromptPick(phKey: string): void;
  onClose(): void;
}

/** 参考图懒加载分页大小（滚到底自动续 30/批，方案 §D3）。 */
const REF_PAGE = 30;

/** 音频文件名（相对路径取尾段）。 */
const voiceLabel = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** 三段式骨架：头部标题/主体内部滚动/动作区钉底；portal 到 body 脱离
 *  画布裁剪与 transform 坐标系（与旧 DetailDialog 同挂载策略）。 */
export function DetailWindow({ title, accent, children, foot, onClose }: {
  title: React.ReactNode;
  accent: string;
  children: React.ReactNode;
  foot?: React.ReactNode;
  onClose(): void;
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

/** 参考图网格：30/批懒加载（滚到底自动续），图卡悬浮「设为头像」。 */
function RefGrid({ paths, libraryRoot, onSetAvatar }: {
  paths: string[];
  libraryRoot: string;
  onSetAvatar?(refPath: string): void;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(REF_PAGE);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 懒加载：滚动到底自动续一批（重置列表时回首批）。
  useEffect(() => setLoaded(REF_PAGE), [paths]);
  const onScroll = () => {
    const el = listRef.current;
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
      <div className="pdetail-refgrid" ref={listRef} onScroll={onScroll}>
        {paths.slice(0, loaded).map((refPath, i) => (
          <div key={`${refPath}-${i}`} className="pdetail-refcell">
            <ResourceImage path={joinLibraryPath(libraryRoot, refPath)} alt="" className="pdetail-refimg" />
            {onSetAvatar && (
              <button type="button" className="pdetail-refavatar" onClick={() => onSetAvatar(refPath)}>
                {t("project.detail.setAvatar")}
              </button>
            )}
          </div>
        ))}
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
      <button type="button" className="pdetail-voice-act" onClick={onClear}>{t("common.delete")}</button>
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
  const refPaths = useMemo(() => {
    if (group !== "character") {
      const ref = (entity as ProjectLocation | ProjectProp | undefined)?.ref_path ?? "";
      return ref ? [ref] : [];
    }
    try {
      const list = JSON.parse((entity as ProjectCharacter | undefined)?.reference_paths ?? "[]") as string[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }, [entity, group]);
  const voice = group === "character" ? ((entity as ProjectCharacter | undefined)?.voice_path ?? "") : "";
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
    >
      <DetailSection label={t("project.detail.refs")} count={t("project.detail.refCount", { n: refPaths.length })}>
        <RefGrid paths={refPaths} libraryRoot={ops.libraryRoot} onSetAvatar={group === "character" ? (ref) => entity && ops.setAvatar(entity as ProjectCharacter, ref) : undefined} />
      </DetailSection>
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

/** 片段输入分组：按口聚合（角色/场景/道具/提示词/剧本/其他），组头计数
 *  + 折叠；行=承载节点名（组行展开成员）+ 移除。 */
function SegmentInputs({ segmentId, ops }: { segmentId: string; ops: DetailWindowOps }) {
  const { t } = useTranslation();
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
  return (
    <>
      {ports.map((port) => {
        const portRows = rows.filter((l) => l.to_port === port.id);
        const portPends = pends.filter((l) => l.toPort === port.id);
        const total = portRows.length + portPends.length;
        if (total === 0) return null;
        return (
          <DetailSection key={port.id} label={port.label} count={total} foldable defaultFold={false}>
            <div className="pdetail-dot" style={{ background: port.color }} />
            <div className="pdetail-rows">
              {portRows.map((row) => {
                const owner = row.owner_key ?? "";
                const isGroup = owner.startsWith("grp:");
                const members = isGroup
                  ? (ops.overview?.node_links ?? []).filter((l) => l.owner_key === owner && l.to_segment === segmentId && l.to_port === row.to_port)
                  : [row];
                return (
                  <div key={row.id} className="pdetail-row">
                    <span className="pdetail-row-name">
                      {isGroup ? t("project.detail.groupLine", { n: members.length }) : nameOf(row.from_kind, row.from_id)}
                      {isGroup && <small className="pdetail-row-members">{members.map((m) => nameOf(m.from_kind, m.from_id)).join(" · ")}</small>}
                    </span>
                    <button
                      type="button"
                      className="pdetail-row-x"
                      onClick={() => ops.removeLink({ pending: false, fromKey: row.from_id, toSegment: segmentId, toPort: row.to_port, ownerKey: row.owner_key ?? "", rowId: row.id })}
                    >
                      {t("project.detail.remove")}
                    </button>
                  </div>
                );
              })}
              {portPends.map((p) => (
                <div key={`pend-${p.fromKey}`} className="pdetail-row is-pending">
                  <span className="pdetail-row-name">{pendingFromLabel(p.fromKey)}</span>
                  <button
                    type="button"
                    className="pdetail-row-x"
                    onClick={() => ops.removeLink({ pending: true, fromKey: p.fromKey, toSegment: segmentId, toPort: p.toPort, ownerKey: "" })}
                  >
                    {t("project.detail.remove")}
                  </button>
                </div>
              ))}
            </div>
          </DetailSection>
        );
      })}
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
          <div className="pdetail-empty">{Icons.link}{t("project.canvas.segEmpty")}</div>
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
    <DetailWindow title={<><span className="pdetail-kind-label">{kindLabel}</span> · {t("project.canvas.ephTitle")}</>} accent="#94a3b8" onClose={ops.onClose}>
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
  return <EntityDetail group={target.group} sourceKey={target.sourceKey} ops={ops} />;
}

/** 提示词纸片详情：挂接的提示词标题 + 全文只读（纸片节点小窗看不全），
 *  动作区「更换提示词」关窗重开库选浮层。 */
function PromptPhDetail({ id, ops }: { id: string; ops: DetailWindowOps }) {
  const { t } = useTranslation();
  const ph = ops.promptPhs.find((item) => item.id === id);
  const prompt = ph ? ops.prompts.find((item) => item.id === ph.promptId) : undefined;
  return (
    <DetailWindow
      title={<><span className="pdetail-kind-label">{t("project.detail.promptKind")}</span> · {prompt?.title ?? t("project.canvas.promptEmpty")}</>}
      accent="#22d3ee"
      onClose={ops.onClose}
      foot={(
        <button type="button" className="pdetail-foot-btn" onClick={() => ops.reopenPromptPick(`prompt:${id}`)}>
          {t("project.detail.promptChange")}
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
          <div className="pdetail-empty">{Icons.link}{t("project.canvas.promptEmpty")}</div>
        </DetailSection>
      )}
    </DetailWindow>
  );
}
