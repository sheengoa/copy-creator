import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../../../components/Icons";
import type { ResourceFolder } from "../../../types";
import { useCanvasStore, type CanvasNode } from "../../../stores/canvasStore";
import {
  flattenResourceGroups,
  groupAncestors,
  isGroupRowVisible,
  searchGroupRows,
  type SaveGroupHit,
  type SaveGroupRow,
} from "./saveTarget";
import { useSaveRuntime } from "./saveRuntimeCtx";
import { WheelGate } from "./WheelGate";

// 保存目标配置面板（2026-11-10 内嵌化，用户定案「从节点扩展出来，确定
// 后收起，不显乱」）：不再做悬浮弹层——面板直接渲染在节点目标行下方
// （SaveMediaBody），配置区是节点的一部分，确定/收起后节点恢复原状，
// 画布永不被遮挡，也无翻转/视口推算。库目标配「名称 + 分组树」，指定
// 路径目标配「名称 + 重新选目录」。收起：标题行 × / Esc / 点节点外。
// 确定即写详情——详情纳入指纹，管线自动对现有产物重存一份（旧文件保
// 留，冲突加 (1) 序号不覆盖，见 saveTarget.ts）。
//
// 分组选择（2026-11-14 用户定案，原型 specs/原型-保存目标面板.html）：
// 分组多、嵌套深时全量拍平列表找不到目标——① 树默认折叠只列顶级分组，
// 点行逐层展开（点已展开行=折叠切换，选中始终生效）；② 搜索框输入即
// 过滤，命中项平铺、主行命中段名高亮、次行父路径，点击即选并回到树视
// 图；③ 上次选中的分组链路自动展开高亮——复用路径零点击直接确定。
// 命名一次性（同日定案）：保存成功即清空，见 saveRuntime.tsx。
//
// 宽度守护（用户 2026-11-11 反馈「节点尺寸不够显示选项时自动调整」）：
// 面板理想宽 222（= 默认 250 节点的内容宽减边框，按钮行 nowrap 实测单行下限），
// 展开时节点逻辑宽不足 250 则加宽到 250（走 commitLayout 落库，与拖拽
// 手柄同管道，只改 width、高度仍自适应）；加宽持久保留，收起不缩回
// （避免节点尺寸来回跳）。比较用 offsetWidth（布局像素）而非
// getBoundingClientRect（屏幕系，视图缩放 ≠100% 时会误判）。
const PANEL_MIN_WIDTH = 222;
const NODE_FORM_PADDING = 24;
/** 分组树滚轮降速系数（用户 2026-11-14 反馈：浏览分组是「看」的过程，
 *  原生滚轮步长太快看不清层级）：一格滚轮 100px → 50px。 */
const TREE_SCROLL_FACTOR = 0.5;

/** 命中段名高亮：不区分大小写定位首个命中子串，mark 包裹。 */
function HitName({ name, query }: { name: string; query: string }) {
  const q = query.trim().toLowerCase();
  const idx = name.toLowerCase().indexOf(q);
  if (idx < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, idx)}
      <mark>{name.slice(idx, idx + q.length)}</mark>
      {name.slice(idx + q.length)}
    </>
  );
}

export function SaveTargetPanel({ node, onClose }: { node: CanvasNode; onClose: () => void }) {
  const { t } = useTranslation();
  const runtime = useSaveRuntime();
  const meta = node.metadata;
  const isSaveMeta =
    meta.kind === "save_image" || meta.kind === "save_video" || meta.kind === "save_audio";
  const [name, setName] = useState(isSaveMeta ? (meta.auto_name ?? "") : "");
  const [group, setGroup] = useState(isSaveMeta ? (meta.auto_group ?? "") : "");
  const [rows, setRows] = useState<SaveGroupRow[]>([]);
  // 折叠树展开集：初始即含已选分组的祖先链（记忆路径自动可见，2026-11-14）
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(isSaveMeta ? groupAncestors(meta.auto_group ?? "") : []),
  );
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void invoke<ResourceFolder[]>("get_resource_groups")
      .then((folders) => {
        if (alive) setRows(flattenResourceGroups(folders));
      })
      .catch(() => {
        // 分组树加载失败：保留已选值，列表留空（确定仍可用）
      });
    return () => {
      alive = false;
    };
  }, []);

  // 分组树滚轮降速：拦截原生滚动按系数缩放步长（line 模式按行高 16px
  // 归一），浏览层级是「看」的过程不需要原生快滚。降速监听落在树容器
  // 自身，WheelGate 只管截留不冒泡（职责分离）；指定路径目标无树，ref
  // 为空即跳过。搜索态与树态共用同一容器，一并生效。
  useEffect(() => {
    const tree = treeScrollRef.current;
    if (!tree) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      tree.scrollTop += dy * TREE_SCROLL_FACTOR;
    };
    tree.addEventListener("wheel", onWheel, { passive: false });
    return () => tree.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // 点节点外收起：面板与宿主节点内的点击不收（目标行 toggle 自理）。
    const onOutside = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (panelRef.current?.contains(target)) return;
      if (panelRef.current?.closest(".pc-node")?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [onClose]);

  // 展开期间宿主节点抬升：相邻节点重叠时配置区不被后序兄弟盖住
  // （pc-node 的 backdrop-filter 自成堆叠上下文，z-index 锁在节点层内）。
  useEffect(() => {
    const host = panelRef.current?.closest(".pc-node") as HTMLElement | null;
    if (!host) return;
    const prev = host.style.zIndex;
    host.style.zIndex = "70";
    return () => {
      host.style.zIndex = prev;
    };
  }, []);

  // 宽度守护：节点逻辑宽不足面板理想宽时自动加宽节点（paint 前完成，
  // 不闪窄帧）。只改 width 落布局，height 仍自适应；加宽持久保留。
  useLayoutEffect(() => {
    const host = panelRef.current?.closest(".pc-node") as HTMLElement | null;
    if (!host) return;
    const need = PANEL_MIN_WIDTH + NODE_FORM_PADDING;
    if (host.offsetWidth >= need - 0.5) return;
    const state = useCanvasStore.getState();
    const current = state.nodes.find((n) => n.id === node.id);
    if (!current) return;
    state.commitLayout(current.canvas_id, [
      { id: current.id, pos_x: current.pos_x, pos_y: current.pos_y, width: need, height: current.height },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅展开挂载时守护一次
  }, []);

  if (meta.kind !== "save_image" && meta.kind !== "save_video" && meta.kind !== "save_audio") return null;
  const isLibrary = meta.auto_target === "library";

  const confirm = () => {
    runtime.setSaveTargetDetails(node.id, isLibrary ? group : "", name.trim());
    onClose();
  };

  /** 树行点击：选中始终生效；有子级时切换展开（折叠树浏览手势）。 */
  const pickRow = (row: SaveGroupRow) => {
    setGroup(row.path);
    if (!row.hasChildren) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.path)) next.delete(row.path);
      else next.add(row.path);
      return next;
    });
  };

  /** 搜索命中点击：选中 + 清搜索回树视图 + 展开该链路（选中项立即可见）。 */
  const pickHit = (hit: SaveGroupHit) => {
    setGroup(hit.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of groupAncestors(hit.path)) next.add(a);
      return next;
    });
    setQuery("");
  };

  const searching = query.trim().length > 0;
  const hits = searching ? searchGroupRows(rows, query) : [];
  const visibleRows = searching ? [] : rows.filter((row) => isGroupRowVisible(row.path, expanded));

  return (
    <div
      ref={panelRef}
      className="fc-save-panel"
      role="region"
      aria-label={t("canvas.savePopTitle")}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fc-save-panel-head">
        <span className="fc-save-panel-title">{t("canvas.savePopTitle")}</span>
        <button
          type="button"
          className="fc-save-panel-close"
          aria-label={t("canvas.savePopClose")}
          onClick={onClose}
        >
          {Icons.close}
        </button>
      </div>
      <label className="fc-save-panel-label" htmlFor={`save-panel-name-${node.id}`}>{t("canvas.savePopNameLabel")}</label>
      <input
        id={`save-panel-name-${node.id}`}
        className="fc-save-panel-input"
        type="text"
        value={name}
        placeholder={t("canvas.savePopNamePh")}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="fc-save-panel-hint">{t("canvas.savePopNameHint")}</div>
      {isLibrary ? (
        <>
          <div className="fc-save-panel-label">
            {t("canvas.savePopGroupLabel")}
            {/* 上次选择保留提示：仅打开时有记忆（auto_group 非空）才显示，
                面板内改选后提示即失效不更新 */}
            {isSaveMeta && (meta.auto_group ?? "") !== "" && (
              <span className="fc-save-panel-label-hint"> — {t("canvas.savePopGroupKept")}</span>
            )}
          </div>
          <input
            className="fc-save-panel-search"
            type="text"
            value={query}
            placeholder={t("canvas.savePopSearchPh")}
            aria-label={t("canvas.savePopSearchPh")}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* WheelGate：悬浮树上的滚轮只滚列表，不惊动画布缩放 */}
          <WheelGate>
            <div className="fc-save-panel-tree" ref={treeScrollRef}>
              {searching ? (
                hits.length > 0 ? (
                  hits.map((hit) => (
                    <button
                      key={hit.path}
                      type="button"
                      className={`fc-save-panel-item${hit.path === group ? " is-active" : ""}`}
                      aria-pressed={hit.path === group}
                      onClick={() => pickHit(hit)}
                    >
                      <span className="fc-save-panel-caret is-leaf" />
                      {Icons.folderFine}
                      <span className="fc-save-panel-hit-text">
                        <span className="fc-save-panel-hit-name">
                          <HitName name={hit.name} query={query} />
                        </span>
                        <span className="fc-save-panel-hit-parent">
                          {hit.parent || t("canvas.savePopRootPath")}
                        </span>
                      </span>
                      <span className="fc-save-panel-item-count">{hit.count}</span>
                    </button>
                  ))
                ) : (
                  <div className="fc-save-panel-empty">
                    {t("canvas.savePopSearchEmpty", { query: query.trim() })}
                  </div>
                )
              ) : (
                visibleRows.map((row) => (
                  <button
                    key={row.path}
                    type="button"
                    className={`fc-save-panel-item${row.path === group ? " is-active" : ""}`}
                    style={{ paddingLeft: 8 + row.depth * 14 }}
                    aria-pressed={row.path === group}
                    onClick={() => pickRow(row)}
                  >
                    <span className={`fc-save-panel-caret${row.hasChildren ? "" : " is-leaf"}`}>
                      {expanded.has(row.path) ? Icons.chevronDown : Icons.chevronRight}
                    </span>
                    {Icons.folderFine}
                    <span className="fc-save-panel-item-name">
                      {row.path === "" ? t("canvas.savePopUngrouped") : row.label}
                    </span>
                    <span className="fc-save-panel-item-count">{row.count}</span>
                  </button>
                ))
              )}
              {!searching && rows.length === 0 && (
                <div className="fc-save-panel-empty">{t("canvas.savePopGroupEmpty")}</div>
              )}
            </div>
          </WheelGate>
        </>
      ) : (
        <div className="fc-save-panel-dirhint">
          {t("canvas.savePopDirHint", { dir: meta.auto_dir ?? "" })}{" "}
          <button
            type="button"
            className="fc-save-panel-dirlink"
            onClick={() => {
              onClose();
              void runtime.pickSaveAutoDir(node.id);
            }}
          >
            {t("canvas.savePopRePickDirShort")}
          </button>
        </div>
      )}
      <div className="fc-save-panel-foot">
        {/* 底部链接 = 模式互换：库目标切指定路径，指定路径切回资源库
            （对称入口，用户定案方向后补齐反向切换） */}
        <button
          type="button"
          className="fc-save-panel-link"
          onClick={() => {
            onClose();
            if (isLibrary) void runtime.pickSaveAutoDir(node.id);
            else runtime.setSaveAutoTarget(node.id, "library", "");
          }}
        >
          {isLibrary ? t("canvas.savePopUseDir") : t("canvas.savePopUseLib")}
        </button>
        <button type="button" className="fc-save-panel-ghost" onClick={() => { setName(""); setGroup(""); }}>
          {t("canvas.savePopReset")}
        </button>
        <button type="button" className="fc-save-panel-ok" onClick={confirm}>
          {t("canvas.savePopOk")}
        </button>
      </div>
    </div>
  );
}
