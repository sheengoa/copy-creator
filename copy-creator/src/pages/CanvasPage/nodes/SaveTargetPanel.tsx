import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../../../components/Icons";
import type { ResourceFolder } from "../../../types";
import { useCanvasStore, type CanvasNode } from "../../../stores/canvasStore";
import {
  createGroupPathOf,
  flattenResourceGroups,
  groupAncestors,
  isGroupRowVisible,
  searchGroupRows,
  siblingGroupNames,
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
 *  原生滚轮步长太快看不清层级）：一格滚轮 100px → 25px（0.5 仍嫌快，
 *  二轮反馈再降一档）。 */
const TREE_SCROLL_FACTOR = 0.25;

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
  // 面板内新建分组（2026-11-14 用户定案，原型 specs/原型-保存目标面板-新建分组.html）：
  // creating=正在建子分组的父路径（""=顶级，null=无）；行内输入行 Enter 创建、
  // Esc/失焦取消；创建成功自动选中并展开链路（建完接着确定就存）。
  const [creating, setCreating] = useState<string | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const [creatingError, setCreatingError] = useState("");
  const creatingBusyRef = useRef(false);
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

  // 输入行/错误行超出固定树高时最小位移滚到可见（树高首帧恒定约定下的
  // 兜底：错误行出现在输入行下方，错误态不改树高，只滚）。错误行优先
  // ——输入行可见时 nearest 不会为它下面的错误行滚动。放在条件
  // early return 之前——hooks 不可条件化。
  useEffect(() => {
    if (creating === null) return;
    const tree = treeScrollRef.current;
    if (!tree) return;
    const target =
      tree.querySelector(".fc-save-panel-create-error") ??
      tree.querySelector(".fc-save-panel-create");
    target?.scrollIntoView({ block: "nearest" });
  }, [creating, creatingError]);

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

  // ── 面板内新建分组 ──────────────────────────────────────────────
  /** 开始新建：parentPath=父分组（""=顶级）。搜索入口先清搜索回树视图
   *  （与 pickHit 衔接语义一致），深层父分组展开祖先链让输入行可见。 */
  const startCreate = (parentPath: string, presetName = "") => {
    setCreating(parentPath);
    setCreatingName(presetName);
    setCreatingError("");
    if (query.trim()) setQuery("");
    if (parentPath) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of groupAncestors(parentPath)) next.add(a);
        return next;
      });
    }
  };

  const cancelCreate = () => {
    setCreating(null);
    setCreatingName("");
    setCreatingError("");
  };

  /** 提交创建：同名先拦（文案更明确），再走后端（多级路径自动补建父级），
   *  成功即重拉分组树 + 自动选中新分组 + 展开链路；失败词保留可改续建。 */
  const commitCreate = async () => {
    if (creatingBusyRef.current) return;
    const name = creatingName.trim();
    if (!name) {
      setCreatingError(t("canvas.savePopCreateEmpty"));
      return;
    }
    const parentPath = creating ?? "";
    if (siblingGroupNames(rows, parentPath).includes(name)) {
      setCreatingError(
        t("canvas.savePopCreateDup", { parent: parentPath || t("canvas.savePopCreateTop"), name }),
      );
      return;
    }
    creatingBusyRef.current = true;
    try {
      await invoke("create_resource_group", { name: createGroupPathOf(parentPath, name) });
      const folders = await invoke<ResourceFolder[]>("get_resource_groups");
      setRows(flattenResourceGroups(folders));
      const newPath = createGroupPathOf(parentPath, name);
      setGroup(newPath);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of groupAncestors(newPath)) next.add(a);
        return next;
      });
      setCreating(null);
      setCreatingName("");
      setCreatingError("");
    } catch (error) {
      // 后端报错原样透出（非法字符/并发创建同名等），不关闭不丢词
      setCreatingError(String(error));
    } finally {
      creatingBusyRef.current = false;
    }
  };

  /** 行内新建输入行：缩进=父级下一层；Enter 创建，Esc 不冒泡（面板不收），
   *  失焦取消但焦点留在新建行内（点 ✓/✕）不取消——按钮 mousedown 先
   *  preventDefault 保住焦点。 */
  const renderCreateRow = (depth: number, key: string) => {
    const where = creating === ""
      ? t("canvas.savePopCreateAtTop")
      : t("canvas.savePopCreateUnderShort", { group: creating ?? "" });
    return (
      <Fragment key={key}>
        <div className="fc-save-panel-create" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="fc-save-panel-create-arrow" aria-hidden="true">↳</span>
          {Icons.folderFine}
          <input
            className={`fc-save-panel-create-input${creatingError ? " is-error" : ""}`}
            type="text"
            value={creatingName}
            placeholder={t("canvas.savePopCreatePh", { where })}
            autoFocus
            aria-label={t("canvas.savePopCreateAria")}
            onChange={(e) => {
              setCreatingName(e.target.value);
              if (creatingError) setCreatingError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitCreate();
              } else if (e.key === "Escape") {
                e.stopPropagation(); // 取消新建，不冒泡到面板的 Esc 收起
                cancelCreate();
              }
            }}
            onBlur={(e) => {
              if (e.relatedTarget instanceof Element && e.relatedTarget.closest(".fc-save-panel-create")) return;
              cancelCreate();
            }}
          />
          <button
            type="button"
            className="fc-save-panel-create-btn is-ok"
            title={t("canvas.savePopCreateOk")}
            aria-label={t("canvas.savePopCreateOk")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void commitCreate()}
          >
            {Icons.check}
          </button>
          <button
            type="button"
            className="fc-save-panel-create-btn is-cancel"
            title={t("canvas.savePopClose")}
            aria-label={t("canvas.savePopClose")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancelCreate}
          >
            {Icons.close}
          </button>
        </div>
        {creatingError && <div className="fc-save-panel-create-error">{creatingError}</div>}
      </Fragment>
    );
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
            onChange={(e) => {
              setQuery(e.target.value);
              // 搜索即放弃行内新建（原型同语义）：输入行只在树态有意义，
              // 留着会在清搜索后带旧词复现，反而困惑
              if (creating !== null) cancelCreate();
            }}
          />
          {/* WheelGate：悬浮树上的滚轮只滚列表，不惊动画布缩放。
              树滚动区 + 底部「新建顶级分组」固定钮同区（面板高度首帧恒定）。 */}
          <WheelGate>
            <div className="fc-save-panel-treezone">
              <div className="fc-save-panel-tree" ref={treeScrollRef}>
                {searching ? (
                  hits.length > 0 ? (
                    hits.map((hit) => (
                      <div
                        key={hit.path}
                        className={`fc-save-panel-rowwrap${hit.path === group ? " is-active" : ""}`}
                      >
                        <button
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
                        <button
                          type="button"
                          className="fc-save-panel-fadd"
                          title={t("canvas.savePopCreateUnder", { group: hit.name })}
                          aria-label={t("canvas.savePopCreateUnder", { group: hit.name })}
                          onClick={() => startCreate(hit.path)}
                        >
                          {Icons.add}
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="fc-save-panel-empty is-column">
                      <div>{t("canvas.savePopSearchEmpty", { query: query.trim() })}</div>
                      {/* 搜不到=直接建：搜索词预填为分组名，落在当前选中
                          分组下（未选中=顶级），一步到位 */}
                      <button
                        type="button"
                        className="fc-save-panel-empty-create"
                        onClick={() => startCreate(group || "", query.trim())}
                      >
                        {Icons.add}
                        <span>{t("canvas.savePopSearchEmptyCreate", { query: query.trim() })}</span>
                        <span className="fc-save-panel-empty-create-where">
                          {group
                            ? t("canvas.savePopCreateUnderShort", { group })
                            : t("canvas.savePopCreateAtTop")}
                        </span>
                      </button>
                    </div>
                  )
                ) : (
                  visibleRows.map((row) => (
                    <Fragment key={row.path || "__ungrouped__"}>
                      <div
                        className={`fc-save-panel-rowwrap${row.path === group ? " is-active" : ""}`}
                        style={{ paddingLeft: 8 + row.depth * 14 }}
                      >
                        <button
                          type="button"
                          className={`fc-save-panel-item${row.path === group ? " is-active" : ""}`}
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
                        {/* 行悬停「＋」：在该分组下建子分组；未分组行（库根
                            直属文件区）不提供——顶级新建走树底固定钮 */}
                        {row.path !== "" && (
                          <button
                            type="button"
                            className="fc-save-panel-fadd"
                            title={t("canvas.savePopCreateUnder", { group: row.label })}
                            aria-label={t("canvas.savePopCreateUnder", { group: row.label })}
                            onClick={() => startCreate(row.path)}
                          >
                            {Icons.add}
                          </button>
                        )}
                      </div>
                      {/* 行内新建输入行：插在父分组子级末尾（父折叠时紧跟
                          父行），层级位置所见即所得；未分组行 path 也是
                          空串，顶级新建由树尾单独渲染（不在此重复插入） */}
                      {creating !== "" && creating === row.path && renderCreateRow(row.depth + 1, `create-${row.path}`)}
                    </Fragment>
                  ))
                )}
                {!searching && rows.length === 0 && (
                  <div className="fc-save-panel-empty">{t("canvas.savePopGroupEmpty")}</div>
                )}
                {!searching && creating === "" && renderCreateRow(0, "create-root")}
              </div>
              <button
                type="button"
                className="fc-save-panel-newgroup"
                onClick={() => startCreate("")}
              >
                {Icons.add}
                <span>{t("canvas.savePopCreateRoot")}</span>
              </button>
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
