// 工程画布浮条与菜单层（自 ProjectCanvas.tsx 渲染区零改动搬运，
// 2026-11-03 引擎拆分阶段 11c；fork 对齐点按原注释保持）：刀切痕层、
// 缺失提醒条、双击空白节点选择框、集信息玻璃卡与右下新建按钮。
import { Icons } from "../../../../components/Icons";
import { useTranslation } from "react-i18next";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ProjectScene } from "../../../../stores/projectStore";
import type { DragState, LiftedWire } from "../engine/useGestures";
import { ADDNODE_OUT_TYPES } from "../colors";
import type { SetDetailFor } from "./NodeExtras";
import type { PendingLink, ScriptPh, WireItem } from "../types";
import type { ProjectNodeLink } from "../../../../stores/projectStore";

type AddMenuStateT = {
  sx: number;
  sy: number;
  wx: number;
  wy: number;
  wire?: {
    fromKey: string;
    fromDir: "out" | "in";
    fromType?: string;
    fromAccepts?: string[];
    fromPortId?: string;
  };
  detached?: { pendings: PendingLink[]; rows: ProjectNodeLink[] };
};

/** 刀切痕层：视口直下的绝对定位层，滑动中 ref 直写双描边。 */
export function CutTrailLayer({
  cutTrailUnderRef, cutTrailRef,
}: {
  cutTrailUnderRef: RefObject<SVGPolylineElement | null>;
  cutTrailRef: RefObject<SVGPolylineElement | null>;
}) {
  return (
    <>
{/* 刀切痕层：视口直下的绝对定位层（pc-world 之后 → 盖在卡片上），
    用视口屏幕坐标画折线——不进 pc-world（祖先 transform 会连
    non-scaling-stroke 一起缩放），也不用 fixed（坐标系会被
    transform 祖先劫持且部分环境逐帧重绘闪烁）。滑动中 ref 直写
    双描边（暗衬 + 白芯），松手清空即隐形。 */}
<svg className="pc-trailayer" aria-hidden="true">
  <polyline ref={cutTrailUnderRef} className="pc-wire-cut-under" points="" />
  <polyline ref={cutTrailRef} className="pc-wire-cut" points="" />
</svg>
    </>
  );
}

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
  setDetailFor: SetDetailFor;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 缺失提醒条（ComfyUI 缺节点警示的对应物）：缺项可点击定位 */}
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
            if (firstEmpty) setDetailFor({ kind: "segment", id: firstEmpty.id, scopes: { chars: "current", locs: "current", props: "current" } });
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

/** 双击空白的节点选择框（ComfyUI 搜索框的对应物）。 */
export function AddMenuBlock({
  addMenu, addMenuQuery, setAddMenuQuery, setAddMenu, discardDetachedWire,
  setLiftedWire, armSpawnAt, addScriptPh, setLocationPickOpen, dragRef,
}: {
  addMenu: AddMenuStateT | null;
  addMenuQuery: string;
  setAddMenuQuery(q: string): void;
  setAddMenu: Dispatch<SetStateAction<AddMenuStateT | null>>;
  discardDetachedWire(detached: { pendings: PendingLink[]; rows: ProjectNodeLink[] }): void;
  setLiftedWire(w: LiftedWire | null): void;
  armSpawnAt(x: number, y: number): void;
  addScriptPh(): void;
  setLocationPickOpen(open: boolean): void;
  dragRef: RefObject<DragState | null>;
}) {
  const { t } = useTranslation();
  return (
    <>
{/* 双击空白的节点选择框（ComfyUI 搜索框的对应物） */}
{addMenu && (
  <div
    className="pc-addmenu"
    style={{ left: addMenu.sx, top: addMenu.sy }}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <input
      className="pc-addmenu-search"
      placeholder={t("project.canvas.addNodeSearch")}
      value={addMenuQuery}
      onChange={(event) => setAddMenuQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // 取消菜单＝不建节点直接退出：摘下的线就此断开
          // （见 discardDetachedWire），不放回原口。
          if (addMenu.detached) discardDetachedWire(addMenu.detached);
          setAddMenu(null);
        }
      }}
      // 聚焦必须带 preventScroll：菜单常弹出在画布边缘，默认聚焦
      // 会让浏览器滚动 overflow:hidden 的视口容器把输入框露出来，
      // 表现为整个画布节点集体平移（连线/断线时位置漂移的根源）。
      ref={(el) => {
        el?.focus({ preventScroll: true });
      }}
    />
    {[
      {
        key: "segment",
        label: t("project.canvas.segName"),
        hint: t("project.canvas.typeSegmentHint"),
        icon: Icons.clapperboard,
        panel: "",
      },
      {
        key: "episodeScript",
        label: t("project.canvas.typeEpisode"),
        hint: t("project.canvas.typeEpisodeHint"),
        icon: Icons.file,
        panel: "script",
      },
      {
        key: "character",
        label: t("project.canvas.typeCharacter"),
        hint: t("project.canvas.typeCharacterHint"),
        icon: Icons.clipboard,
        panel: "",
      },
      {
        key: "location",
        label: t("project.canvas.typeLocation"),
        hint: t("project.canvas.typeLocationHint"),
        icon: Icons.resources,
        panel: "",
      },
      {
        // 关联场景：把库内已有场景关联到本集（原「本集资料」框标签
        // 条的 + 入口随框移除，改挂到添加菜单，功能不丢）。
        key: "linkScene",
        label: t("project.canvas.linkScene"),
        hint: t("project.canvas.linkSceneHint"),
        icon: Icons.resources,
        panel: "linkScene",
      },
      {
        key: "prop",
        label: t("project.canvas.typeProp"),
        hint: t("project.canvas.typePropHint"),
        icon: Icons.star,
        panel: "",
      },
      {
        key: "note",
        label: t("project.canvas.typeNote"),
        hint: t("project.canvas.typeNoteHint"),
        icon: Icons.edit,
        panel: "",
      },
      {
        key: "prompt",
        label: t("project.canvas.typePrompt"),
        hint: t("project.canvas.typePromptHint"),
        icon: Icons.file,
        panel: "",
      },
    ]
      .filter((item) => item.label.toLowerCase().includes(addMenuQuery.trim().toLowerCase()))
      .filter((item) => {
        // 摘线到空白的菜单按原口兼容过滤：建出来的新源接不回原
        // 口的类型不再列出（摘剧本线甩空白不再给 角色/场景/道具）。
        // 剧本纸片/关联场景/便签不接线原样放回、片段走「换目标」
        // 同名口与来源类型无关——任何来源都保留。
        if (!addMenu.detached) return true;
        const accepts = addMenu.wire?.fromAccepts;
        if (!accepts) return true;
        const out = ADDNODE_OUT_TYPES[item.key];
        return !out || accepts.includes(out);
      })
      .map((item) => (
        <button
          key={item.key}
          type="button"
          className="pc-addmenu-item"
          // 剧本项：每次点击都放一个空纸片（双击纸片再选文件，
          // 与其他节点的加载节奏统一）；「关联场景」打开库场景挑选
          // 面板；
          // 其余项（片段/角色/场景/道具/便签/提示词/素材）支持
          // 点击与按住拖到画布松手两种落位（ComfyUI 搜索框惯例），
          // 资料类先落空白节点、绝不先弹挑选面板；从「拖线到空
          // 白」进入时创建的节点自动接上那条线（占位未加载实体，
          // 连线先走暂存线）。
          {...(item.panel === "script"
            ? {
                onClick: () => {
                  // 纸片不接线：被摘的线放回原口。
                  if (addMenu.detached) setLiftedWire(null);
                  setAddMenu(null);
                  setAddMenuQuery("");
                  // 与其他节点统一：每次都放一个空剧本纸片（出生在
                  // 双击位置），双击纸片再从库选文件；本集还没剧本
                  // 时首个挂接的文件转正为主剧本。
                  armSpawnAt(addMenu.wx, addMenu.wy);
                  addScriptPh();
                },
              }
            : item.panel === "linkScene"
              ? {
                  onClick: () => {
                    // 场景挑选面板不自接线：被摘的线放回原口。
                    if (addMenu.detached) setLiftedWire(null);
                    setAddMenu(null);
                    setAddMenuQuery("");
                    // 新关联的场景节点出生在双击位置（视线附近）。
                    armSpawnAt(addMenu.wx, addMenu.wy);
                    setLocationPickOpen(true);
                  },
                }
              : {
                  onPointerDown: (event: React.PointerEvent) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    event.preventDefault();
                    // 立即捕获指针：菜单按钮随 setAddMenu(null) 卸载，
                    // 卸载后浏览器释放捕获，pointerup 按 hit-test 落到
                    // 视口、照常冒泡给 document 的 onUp 收尾（落节点
                    // /摘线转接）。不捕获的话，按住拖到窗外松手或松
                    // 手恰逢按钮已卸载，up 丢失会让「摘下的线」永久
                    // 悬空——无菜单可取消、无口可放回。
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // 指针已不可捕获（合成事件等）：退化为无捕获。
                    }
                    dragRef.current = {
                      kind: "addnode", sx: event.clientX, sy: event.clientY, moved: false,
                      fox: addMenu.wx, foy: addMenu.wy, frameKey: item.key,
                      wire: addMenu.wire,
                      detached: addMenu.detached,
                    };
                    setAddMenu(null);
                    setAddMenuQuery("");
                  },
                })}
        >
          {item.icon}
          <span>{item.label}</span>
          <small>{item.hint}</small>
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
{/* 集信息玻璃卡 + 统计 */}
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
