import type { ComponentType, ReactNode } from "react";
import type { CanvasConnection, CanvasNode } from "../../../stores/canvasStore";

// 节点基座契约（画布节点基座化 2026-11-03）：每个节点类型在 nodes/ 下的
// def 文件里注册一份 NodeDefinition——声明式元数据（端口/颜色/尺寸/菜单/
// 扩展名）内聚在 def 上，渲染自 FreeCanvas 的单体条件链逐族迁入
// Component。新增节点 = 新建 def 文件 + registry 登记 + Rust NodeMeta
// 变体 + i18n 两条（canvas.node.* / canvas.typeHint.*）。
//
// 工程视图节点化（2026-11-05 阶段 B）：type 从 CanvasNodeType 放宽为
// string（工程作用域注册自己的类型 id）；def 增加 scope 声明作用域归属，
// 两画布按 scope 完全互斥（工程视图不可加载自由画布节点，反之亦然）。

/** 媒体类型四通道（连线/端口/着色同源的键）。 */
export type MediaKind = "text" | "image" | "video" | "audio";

/** 建节点菜单分组（与 i18n canvas.menu.* 键一一对应）。 */
export type MenuGroup = "gen" | "load" | "collection" | "output" | "misc" | "project";

/** 节点作用域（两画布完全互斥，用户 2026-11-05 定案）：free=仅自由画布
 *  （缺省）；project=仅工程视图；both=两画布共用（便签）。 */
export type NodeScope = "free" | "project" | "both";

/** 端口匹配语义：node = accepts 存节点类型（自由画布惯例）；
 *  data = accepts 存数据类型（image/text/prompt…，工程六口惯例），
 *  拖线/建菜单过滤按来源节点的输出口数据类型判定。 */
export interface PortDef {
  /** 输入口 id（连线 to_port / 实测锚点键）。 */
  id: string;
  /** 接受的类型（含义随 match：节点类型或数据类型）。 */
  accepts: string[];
  /** 媒体通道（口点着色回退 + 建菜单匹配共用）。 */
  mediaKind: MediaKind;
  /** 口名 i18n 键（工程实体口自带名称；缺省 canvas.port.<mediaKind>）。 */
  labelKey?: string;
  /** 口点/连线色（工程实体口每口一色；缺省 MEDIA_COLOR[mediaKind]）。 */
  color?: string;
  /** 匹配语义（缺省 node）。 */
  match?: "node" | "data";
  /** 多线入口（仅合集节点）：落线追加不顶掉；其余口单线，落线顶掉旧线。 */
  multi?: boolean;
}

export interface NodeIO {
  ins: PortDef[];
  /** 输出口：mediaKind 供配色回退；dataType 供工程 data 匹配（缺省
   *  取 mediaKind）；color 覆写口点色。 */
  out: {
    mediaKind: MediaKind;
    dataType?: string;
    color?: string;
  } | null;
}

/** 上游产物聚合结果：paths=参考图/产物路径；text=提示词文本。
 *  null（查询层）严格表示「没有上游连接」；连了但暂无产物返回空 paths，
 *  供占位文案区分「未连接上游」与「已连接，等待产物」。 */
export interface UpstreamMedia {
  paths: string[];
  text: string;
}

/** 跨模块服务（浮层/大图等有状态能力，由 FreeCanvas 构建下发；数据变更
 *  各模块直接 useCanvasStore 订阅，不过此处）。 */
export interface NodeServices {
  /** 统一取媒入口：库选/盘选浮层（浮层状态在 FreeCanvas），按
   *  def.applyMode 分派写回（resource 直写 / video-tool 写 video_path）。 */
  pickMedia(node: CanvasNode, source: "library" | "disk"): void;
  /** 清除已装媒体（load 族清引用 / 视频工具清 video_path 与产物）。 */
  clearMedia(node: CanvasNode): void;
  /** 上游产物聚合查询（生成输入收集 / 预览共用）。 */
  upstream(nodeId: string): UpstreamMedia | null;
  /** 合集成员行点击定位（2026-11-04）：源节点不在视口内则平移居中，
   *  并做边缘脉冲闪烁（复用出生脉冲 pc-spawn 视觉）方便快速定位。 */
  locateNode(nodeId: string): void;
  /** 打开节点详情窗（工程作用域注入；自由画布无此能力）。 */
  openNodeDetail?(node: CanvasNode): void;
}

export interface NodeProps {
  node: CanvasNode;
  selected: boolean;
  pulsing: boolean;
  autoHeight: boolean;
  /** 视口缩放（合集拖拽位移换算等需要）。 */
  scale: number;
  services: NodeServices;
}

export interface NodeDefinition {
  /** 节点类型 id（自由画布 = CanvasNodeType；工程作用域自注册类型）。 */
  type: string;
  /** 作用域归属（缺省 free；便签 = both，两画布共用）。 */
  scope?: NodeScope;
  /** 壳 chrome 变体：note 无 pc-resized/无端口条/自包 fc-note-body/多 edit 钮。 */
  chrome: "standard" | "note";
  /** 隐藏壳头栏（镜头卡自绘 pc-shot-head：序号+描述+对白）。 */
  hideHead?: boolean;
  /** 不进建节点菜单（镜头来自场景框、成片恒存在，画布不新建）。 */
  menuHidden?: boolean;
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
  /** 逐节点端口覆写（工程镜头卡的输出口随素材有无视频切换 image/video）：
   *  存在时壳与匹配逻辑按它的结果取端口，静态 ports 作为缺省。 */
  portsOf?(node: CanvasNode): NodeIO;
  /** 自适应高节点的最小高（工程成片/占位卡的固定视觉高度）。 */
  minHeightOf?(node: CanvasNode): number | undefined;
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
  /** 上游产物聚合覆写（预览/保存/合集/生成输入收集共用；缺省走
   *  resource_path 软路径）。gen_image 主图置顶排序、load_text 提供文本。 */
  aggregate?(from: CanvasNode): UpstreamMedia;
  /** 生成链路就绪钩子：文本源（内容非空/有成员）与保存节点（自动保存
   *  目标已设）各自声明；genReadiness 查表收集缺失项。 */
  ready?(node: CanvasNode, connections: CanvasConnection[]): boolean;
  /** 双击节点动作（便签进编辑 / 预览图像开大图）；缺省无全局动作。 */
  onDoubleClick?(node: CanvasNode, services: NodeServices): void;
  /** 撤销恢复钩子：删除时仍在进行的任务随删除取消，恢复时按 def 归一
   *  状态（gen_image：generating → error「生成已中断」）。 */
  normalizeRestored?(meta: CanvasNode["metadata"]): CanvasNode["metadata"];
  /** 可被批量生成队列选中（gen 家族）。 */
  batchGenerate?: boolean;
  /** 工具条附加按钮（note 的 edit 钮），渲染在默认删除钮之前。 */
  ToolsExtra?: ComponentType<{ node: CanvasNode }>;
  /** 内容层渲染（基座化后全部 22 类型必填——Record 形状 + typecheck 守护）。 */
  Component: (props: NodeProps) => ReactNode;
}
