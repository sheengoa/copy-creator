// 浏览器验证专用内存后端——剪切板/快捷输入/资源域与通用命令分派。自
// dev/tauriMock.ts 零改动拆分（2026-11-14，守卫规则 27 行数上限），数据与
// 事件通道见 ./db，媒体合成与 AI 生成模拟见 ./media。

import { clone, libraryRoot, MOCK_NOT_HANDLED, ts } from "./db";

// ── 分组树（浏览器内存账本）：保存面板「面板内新建分组」链路的创建
// 后重拉可断言；与资源记录无联动（mock 资源记录的 resource_group 静态）。 ──
interface MockFolder {
  name: string;
  path: string;
  count: number;
  children: MockFolder[];
}
const mockGroupRoots: MockFolder[] = [
  { name: "scripts", path: "scripts", count: 1, children: [] },
  {
    name: "segments",
    path: "segments",
    count: 2,
    children: [{ name: "第一集", path: "segments/第一集", count: 1, children: [] }],
  },
];
const mockGroupsFind = (path: string): MockFolder | null => {
  let level = mockGroupRoots;
  let prefix = "";
  let found: MockFolder | null = null;
  for (const seg of path.split("/")) {
    prefix = prefix ? `${prefix}/${seg}` : seg;
    found = level.find((f) => f.path === prefix) ?? null;
    if (!found) return null;
    level = found.children;
  }
  return found;
};
const mockGroupsInsert = (path: string) => {
  let level = mockGroupRoots;
  let prefix = "";
  for (const seg of path.split("/")) {
    prefix = prefix ? `${prefix}/${seg}` : seg;
    let node = level.find((f) => f.path === prefix) ?? null;
    if (!node) {
      node = { name: seg, path: prefix, count: 0, children: [] };
      level.push(node);
    }
    level = node.children;
  }
};
const mockGroupsTree = () => [
  // 未分组根（库根直放文件区）与顶级分组同层数组——与真实后端结构一致
  {
    name: "",
    path: "",
    count: 3,
    children: [] as MockFolder[],
  },
  ...mockGroupRoots.map((root) => clone(root)),
];

// 详情页内联编辑的内存补丁：update_clipboard_record_content 写这里，
// list_clipboard_records / get_clipboard_record_content 读取时应用。
const clipboardContentPatches = new Map<string, string>();
// 快捷输入文本短语的正文补丁（详情页内联编辑 → update_phrase）。
const phraseContentPatches = new Map<string, string>();

export function handleClipboardCommands(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    // ── 资源域与通用命令（画布链路会碰到的） ──
    case "get_resource_library_path":
      return libraryRoot;
    case "get_media_server_origin":
      // 浏览器 mock 无回环媒体服务：返回确定结构让 resolveResourceMediaUrl
      // 走完正常链路，产出 /media?… 地址 404 后由各媒体组件的占位/回退
      // 兜底（与真实后端不可用时同语义）；卡片缩略图仍走 fetch 静态资产
      // 的真预览（见 get_resource_file_thumbnail）。
      return { origin: window.location.origin, token: "mock" };
    case "get_clipboard_record_content":
      // 剪切板详情视图全文 / 编辑底稿（列表载荷是截断预览）。
      return clipboardContentPatches.get("clip-text-1")
        ?? "这是 mock 记录的完整正文：\n第一行——剪切板详情视图渲染验证。\n第二行——可全选复制。";
    case "update_clipboard_record_content": {
      // 详情页内联编辑的保存通道：mock 用内存补丁承载，重拉列表即可见
      // 更新（与真实后端的 DB 写入同语义）。
      clipboardContentPatches.set(String(args?.id ?? ""), String(args?.content ?? ""));
      return "";
    }
    case "read_clipboard_text_preview":
    case "read_quick_input_text_preview":
      // 文件承载文本的正文预览（卡片文本预览与查看弹窗共用管线）。
      return "文件承载的 mock 正文：\n第一场：地铁站——小雨在末班车驶离后奔下台阶。\n第二场：天台——回声渐弱，只剩风。";
    case "list_clipboard_records": {
      // 供「从资源库选文件」浮层挑选：剧本文件（挂剧本链路验证）、视频
      // （视频首帧/尾帧节点选片，2026-11-01）、图片与音频（类型过滤与
      // 音频保存/预览链路验证，2026-11-02——浮层按节点类型白名单过滤后
      // 各节点只见自己吃得掉的类型）。resourceGroup 过滤与后端同语义：
      // ""=库根未分组，路径=该分组含子级。
      const mockRecords = [
        {
          id: "rec-script-1",
          type: "file",
          content: `${libraryRoot}/scripts/第一集剧本.txt`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}/scripts/第一集剧本.txt`,
          resource_kind: "text",
          resource_group: null,
        },
        {
          id: "rec-video-1",
          type: "file",
          // 指向可真实播放的 vite 静态视频（浏览器 mock 里 <video> 有真
          // 画面，视频工具节点的预览/钳制播放才可验证）。
          content: `${libraryRoot}/mock-clip.mp4`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}/mock-clip.mp4`,
          resource_kind: "video",
          resource_group: null,
        },
        {
          id: "rec-image-1",
          type: "file",
          content: `${libraryRoot}/mock-image.png`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}/mock-image.png`,
          resource_kind: "image",
          resource_group: null,
        },
        {
          id: "rec-audio-1",
          type: "file",
          content: `${libraryRoot}/mock-tone.wav`,
          source_app: "mock",
          created_at: ts(),
          storage_mode: "resource",
          resource_path: `${libraryRoot}/mock-tone.wav`,
          resource_kind: "audio",
          resource_group: null,
        },
        // ── 剪切板页卡片网格可视化验证的 database 记录（资源记录被
        // 「全部」视图排除，剪切板列表必须另有 database 载荷）──
        {
          id: "clip-text-1",
          type: "text",
          content: "第一条剪切板文本记录：卡片网格与查看弹窗验证用。",
          source_app: "Chrome",
          created_at: ts(),
        },
        {
          id: "clip-text-2",
          type: "text",
          content: "多行文本记录\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行——超六行走摘要截断。",
          source_app: "VSCode",
          created_at: ts(),
        },
        {
          id: "clip-link-1",
          type: "link",
          content: "https://example.com/articles/卡片化验证",
          source_app: "Chrome",
          created_at: ts(),
        },
        {
          id: "clip-image-1",
          type: "image",
          content: `${libraryRoot}/mock-image.png`,
          source_app: "截图工具",
          created_at: ts(),
        },
        {
          id: "clip-file-video",
          type: "file",
          content: `${libraryRoot}/mock-clip.mp4`,
          source_app: "文件管理器",
          created_at: ts(),
        },
        {
          id: "clip-file-audio",
          type: "file",
          content: `${libraryRoot}/mock-tone.wav`,
          source_app: "音乐播放器",
          created_at: ts(),
        },
      ];
      const group = typeof args?.resourceGroup === "string" ? args.resourceGroup : null;
      // 关键词过滤与后端同语义（文件名/路径子串，大小写不敏感）——浮层的
      // 「分组内搜索空态 → 在全部文件中搜索」兜底依赖它才可验证。
      const query = typeof args?.search === "string" ? args.search.trim().toLowerCase() : "";
      const patched = mockRecords.map((record) =>
        clipboardContentPatches.has(record.id)
          ? { ...record, content: clipboardContentPatches.get(record.id)! }
          : record,
      );
      return patched
        .filter((record) => !query || (record.resource_path ?? record.content).toLowerCase().includes(query))
        .filter((record) => {
          if (group === null) return true;
          // database 记录无库内路径，分组过滤只作用于资源记录。
          const resourcePath = record.resource_path;
          if (!resourcePath) return false;
          const prefix = `${libraryRoot}/`;
          if (!resourcePath.startsWith(prefix)) return false;
          const dir = resourcePath
            .slice(prefix.length)
            .replace(/[^\\/]+$/, "")
            .replace(/[\\/]+$/, "");
          if (group === "") return dir === "";
          return dir === group || dir.startsWith(`${group}/`) || dir.startsWith(`${group}\\`);
        });
    }
    case "get_image_thumbnail":
    case "get_resource_file_thumbnail": {
      // 浏览器 mock 的真预览：mock 库根即 vite 静态目录（mock/db.ts 的
      // libraryRoot），图片缩略图命令直接取原文件字节转 base64，列表与
      // 选择浮层的图片行因此有真画面可看（此前恒回空串 → 空 data URL
      // 永远裂图）。调用方按 image/png 包 data URL，故仅对 png 静态资产
      // 生效；非 http 路径或取不到回空串，走「无预览」占位回退，与后端
      // 解不动格式的语义一致。视频封面帧不在此列：load_resource_video_
      // poster 会被包成 image/jpeg，字节错配必裂图，现场抽帧已可用。
      const thumbPath = String(args?.path ?? "");
      if (!/^https?:/i.test(thumbPath)) return "";
      return fetch(thumbPath)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
        .then((buffer) => {
          const bytes = new Uint8Array(buffer);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
          return btoa(binary);
        })
        .catch(() => "");
    }
    case "load_resource_video_poster":
      return "";
    case "read_resource_text_preview":
    case "read_resource_text_detail":
    case "read_text_file_content":
      return { content: "第一场：地铁站\n小雨在末班车驶离后奔下台阶，身后传来金属撞击的回响……", truncated: false };
    case "open_resource_file":
    case "reveal_resource_file":
    case "save_resource_video_poster":
    case "set_setting":
    case "set_settings_batch":
      return null;
    case "validate_autostart":
      return { enabled: false, file_exists: false, path_correct: true, message: "" };
    case "is_autostart_enabled":
    case "set_autostart":
      return false;
    case "get_quick_input_file_limit":
      return 10485760;
    case "get_setting":
      return "";
    case "list_all_settings":
      // 全量设置表（对齐 settingsStore.loadAll 的读取字段）：mock 返回空
      // 会让 store 读 theme 报 TypeError 并每分钟重试刷屏，这里给一份
      // 缺省值齐整的表（与真实后端的 SQLite settings 表同构）。
      return {
        theme: "system",
        language: "zh-CN",
        clipboard_retention: "1month",
        shortcut_key: "",
        shortcut_radial: "",
        shortcut_clipboard_create: "",
        radial_menu_enabled: "1",
        radial_menu_scale: "1",
        paste_left_click: "normal",
        content_sort: "",
        ai_proxy: "",
      };
    case "project_search":
      return [];
    case "list_resource_groups":
      // 「从资源库选文件」浮层与保存面板的分组树：mock 库里 scripts/、
      // segments/ 两个顶级分组（与上方资源路径对应，segments 带一层子级
      // 供折叠树/记忆链路验证），根下另有三个直放文件（视频/图片/音频），
      // 首项固定为「未分组」空路径根；面板内新建分组经 mockGroupsInsert
      // 落进同一棵树（创建后重拉即可见）。
      return mockGroupsTree();
    case "create_resource_group": {
      // 面板内新建分组（保存目标面板）：多级路径自动补建父级，重名报错
      // 与后端同语义。
      const path = String(args?.name ?? "").replace(/[\\/]+/g, "/").replace(/^\/|\/$/g, "");
      if (!path) throw new Error("分组名称不能为空");
      if (mockGroupsFind(path)) throw new Error("分组已存在");
      mockGroupsInsert(path);
      return { name: path, count: 0 };
    }

    // ── 快捷输入（卡片化可视化验证的最小数据集） ──
    case "list_phrase_groups":
      return [
        { id: "pg-1", name: "日常话术", sort_order: 0, created_at: ts(), updated_at: ts() },
        { id: "pg-2", name: "素材引用", sort_order: 1, created_at: ts(), updated_at: ts() },
      ];
    case "list_all_phrases":
    case "list_phrases": {
      // 覆盖卡片各预览分支：纯文本 / 多行话术（占位符）/ 图片文件 /
      // 文本文件。list_phrases 按 group_id 过滤（空数组兜底其它分组）。
      const phrases = [
        {
          id: "ph-1", group_id: "pg-1", title: "开场白",
          content: phraseContentPatches.get("ph-1") ?? "您好，我是验证助手，这条话术用于卡片文本预览。",
          input_type: "text", source_path: "", file_size: 0,
          sort_order: 0, created_at: ts(), updated_at: ts(),
          group_name: "日常话术", last_used_at: ts(), use_count: 3,
        },
        {
          id: "ph-2", group_id: "pg-1", title: "排期模板",
          content: "本批交付时间：{{date}} {{time}}\n占位符在粘贴时由后端展开，卡片原样展示。",
          input_type: "text", source_path: "", file_size: 0,
          sort_order: 1, created_at: ts(), updated_at: ts(),
          group_name: "日常话术", last_used_at: ts(), use_count: 7,
        },
        {
          id: "ph-3", group_id: "pg-2", title: "示例形象图",
          content: `${libraryRoot}/mock-image.png`,
          input_type: "file", source_path: `${libraryRoot}/mock-image.png`, file_size: 102400,
          sort_order: 2, created_at: ts(), updated_at: ts(),
          group_name: "素材引用", last_used_at: ts(), use_count: 1,
        },
        {
          id: "ph-4", group_id: "pg-2", title: "剧本片段",
          content: `${libraryRoot}/scripts/第一集剧本.txt`,
          input_type: "file", source_path: `${libraryRoot}/scripts/第一集剧本.txt`, file_size: 2048,
          sort_order: 3, created_at: ts(), updated_at: ts(),
          group_name: "素材引用", last_used_at: ts(), use_count: 0,
        },
      ];
      const patchedPhrases = phrases.map((p) =>
        phraseContentPatches.has(p.id) ? { ...p, content: phraseContentPatches.get(p.id)! } : p,
      );
      if (cmd === "list_phrases") {
        const groupId = String(args?.groupId ?? "");
        return patchedPhrases.filter((p) => p.group_id === groupId);
      }
      return patchedPhrases;
    }
    case "update_phrase": {
      // 快捷输入详情页内联编辑的保存通道：内存补丁承载正文更新。
      phraseContentPatches.set(String(args?.id ?? ""), String(args?.content ?? ""));
      return "";
    }

    // ── 上传链路（详情窗口「上传文件」）：选本机文件 → 复制入库 ──
    case "select_resource_trace_file":
      return { path: `${libraryRoot}\\scripts\\第一集剧本.txt` };
    case "import_resource_file":
      return { file_path: "scripts/第一集剧本.txt", kind: "text", name: "第一集剧本.txt" };

    default:
      return MOCK_NOT_HANDLED;
  }
}
