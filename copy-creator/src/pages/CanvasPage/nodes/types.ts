import type { ReactNode } from "react";
import type { CanvasNode, CanvasNodeType } from "../../../stores/canvasStore";

// 节点基座契约（画布节点基座化 2026-11-03）：每个节点类型在 nodes/ 下的
// def 文件里注册一份 NodeDefinition——声明式元数据（端口/颜色/尺寸/菜单/
// 扩展名）内聚在 def 上，渲染自 FreeCanvas 的单体条件链逐族迁入
// Component。新增节点 = 新建 def 文件 + registry 登记 + Rust NodeMeta
// 变体 + i18n 两条（canvas.node.* / canvas.typeHint.*）。

/** 媒体类型四通道（连线/端口/着色同源的键）。 */
export type MediaKind = "text" | "image" | "video" | "audio";

/** 建节点菜单分组（与 i18n canvas.menu.* 键一一对应）。 */
export type MenuGroup = "gen" | "load" | "collection" | "output" | "misc";

export interface PortDef {
  /** 输入口 id（连线 to_port / 实测锚点键）。 */
  id: string;
  /** 接受的上游节点类型（类型匹配校验）。 */
  accepts: CanvasNodeType[];
  mediaKind: MediaKind;
  /** 多线入口（仅合集节点）：落线追加不顶掉；其余口单线，落线顶掉旧线。 */
  multi?: boolean;
}

export interface NodeIO {
  ins: PortDef[];
  out: { mediaKind: MediaKind } | null;
}

/** 跨模块服务（浮层/大图等有状态能力，由 FreeCanvas 构建下发；数据变更
 *  各模块直接 useCanvasStore 订阅，不过此处）。 */
export interface NodeServices {
  /** 统一取媒入口：库选/盘选浮层，按 def.applyMode 分派写回。 */
  pickMedia(node: CanvasNode): void;
  /** 清除已装媒体（load 族清引用 / 视频工具清 video_path 与产物）。 */
  clearMedia(node: CanvasNode): void;
  /** 全屏大图预览。 */
  openLightbox(path: string): void;
}

export interface NodeProps {
  node: CanvasNode;
  /** metadata（模块内按 kind 守卫判窄，与 FreeCanvas 现状同款）。 */
  meta: CanvasNode["metadata"];
  selected: boolean;
  pulsing: boolean;
  autoHeight: boolean;
  /** 视口缩放（合集拖拽位移换算等需要）。 */
  scale: number;
  services: NodeServices;
}

export interface NodeDefinition {
  type: CanvasNodeType;
  /** 壳 chrome 变体：note 无 pc-resized/无端口条/自包 fc-note-body/多 edit 钮。 */
  chrome: "standard" | "note";
  menu: { group: MenuGroup; icon: ReactNode };
  /** 节点主题色（B+ 视觉标准：按所属媒体链路取 MEDIA_COLOR）。 */
  accent: string;
  /** 建节点默认尺寸（h=null = 高度内容自适应撑开）。 */
  size: { w: number; h: number | null };
  /** 缩放下限。 */
  minSize: { w: number; h: number };
  /** 连线锚点实测前的兜底尺寸。 */
  fallbackSize: { w: number; h: number };
  /** 类型化端口矩阵（用户 2026-10-31 定案）：生成节点文本口必连、图像口
   *  可选（纯文生图）；输出节点入口接受对应生成/加载节点。 */
  ports: NodeIO;
  /** 壳恒渲染固定高（load_text 常驻编辑框，视觉标准 B+ 特例）。 */
  fixedHeight?: boolean;
  /** 壳是否包 <div.fc-node-form> 滚动容器（默认 true；note 自包）。 */
  formWrap?: boolean;
  /** 「从资源库选择」浮层的类型白名单（缺省不过滤）。 */
  pickerKinds?: string[];
  /** 取媒写回模式：resource=写 resource_path（缺省）；video-tool=写
   *  video_path 并重置工具参数，语义与抽帧一致（五类型共用）。 */
  applyMode?: "resource" | "video-tool";
  /** OS 拖入是否接收 + 允许的扩展名（拖入命中节点 / 本地选片共用）。 */
  dropAccept?: boolean;
  dropExtensions?: readonly string[];
  /** 拖到空白时按扩展名建此节点（load 三族）。 */
  blankDropExtensions?: readonly string[];
  /** 内容层渲染（阶段 4 逐族迁入；缺省时 FreeCanvas 沿用旧条件链）。 */
  Component?: (props: NodeProps) => ReactNode;
}
