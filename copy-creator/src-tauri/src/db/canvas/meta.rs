// 画布节点 metadata 严格类型（serde 枚举 25 变体；自 db/canvas.rs 零改动拆分，2026-11-03 阶段 9b）。
use super::*;

// ── 节点 metadata 严格类型 ──────────────────────────────────

/// 节点 metadata 按节点类型分变体（方案 3.2）：拒绝自由袋子腐化；字段
/// 增删靠 serde default 幂等升级（旧 JSON 缺字段补默认值），与 ensure_column
/// 同哲学。TS 侧类型与此一一对应。
///
/// 节点体系 v2（2026-10-31，用户定案）：生成（gen_x）/ 加载（load_x）/
/// 输出（save_x / preview_x）三类链路 + 便签。旧 text/ref/image 为迁移
/// 来源：schema v4 一次性数据迁移（text→load_text、ref→load_image、
/// image→gen_image），变体保留作读兼容，创建入口已拒绝。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum NodeMeta {
    // ── 旧类型（v4 迁移来源，只读兼容） ──
    Text {
        #[serde(default)]
        content: String,
    },
    Ref {},
    Image {
        #[serde(default)]
        params: ImageGenParams,
        #[serde(default)]
        status: ImageNodeStatus,
        #[serde(default)]
        error: String,
        #[serde(default)]
        images: Vec<GeneratedImage>,
    },

    // ── 加载节点 ──
    LoadText {
        #[serde(default)]
        content: String,
    },
    /// 加载媒体（image/video/audio）：文件在节点行 resource_path 上，
    /// 加载来源（资源库/外部路径/拖入）不进 metadata。
    LoadImage {},
    LoadVideo {},
    LoadAudio {},

    // ── 生成节点 ──
    GenImage {
        #[serde(default)]
        params: ImageGenParams,
        #[serde(default)]
        status: ImageNodeStatus,
        #[serde(default)]
        error: String,
        #[serde(default)]
        images: Vec<GeneratedImage>,
    },
    /// 视频/音频生成：协议层后接（方案决策：先图像全链），占位结构与
    /// GenImage 同源，参数复用 ImageGenParams（model/size/count）。
    GenVideo {
        #[serde(default)]
        params: ImageGenParams,
        #[serde(default)]
        status: ImageNodeStatus,
        #[serde(default)]
        error: String,
    },
    GenAudio {
        #[serde(default)]
        params: ImageGenParams,
        #[serde(default)]
        status: ImageNodeStatus,
        #[serde(default)]
        error: String,
    },

    // ── 合集节点 ──
    /// 合集（图像/文本/视频）：画布上唯一允许多线汇入的节点，把多个
    /// 同类来源排成有序组喂给生成节点。order 存成员 from 节点 id 的展示
    /// 顺序（用户拖拽调序落库）；未登记的新连线按连线时间补尾。
    CollectionImage {
        #[serde(default)]
        order: Vec<String>,
    },
    CollectionText {
        #[serde(default)]
        order: Vec<String>,
    },
    CollectionVideo {
        #[serde(default)]
        order: Vec<String>,
    },

    // ── 输出节点 ──
    /// 保存节点：status = idle | saved | error；target = "library"（入库）
    /// 或 "path"（外部另存）；saved_path 记资源库相对路径或绝对路径。
    /// 自动保存管线（2026-11-01）：auto_target = "" | "library" | "dir"
    /// 为预设目标；auto_dir 记文件夹目标；auto_state = "" | "saving" |
    /// "saved" | "error"；auto_fingerprint 为已保存产物指纹（上游产物
    /// 路径拼接），变化即触发自动重存；auto_error 记最近一次失败原因。
    SaveImage {
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
        #[serde(default)]
        target: String,
        #[serde(default)]
        saved_path: String,
        #[serde(default)]
        auto_target: String,
        #[serde(default)]
        auto_dir: String,
        #[serde(default)]
        auto_state: String,
        #[serde(default)]
        auto_error: String,
        #[serde(default)]
        auto_fingerprint: String,
    },
    SaveVideo {
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
        #[serde(default)]
        target: String,
        #[serde(default)]
        saved_path: String,
        #[serde(default)]
        auto_target: String,
        #[serde(default)]
        auto_dir: String,
        #[serde(default)]
        auto_state: String,
        #[serde(default)]
        auto_error: String,
        #[serde(default)]
        auto_fingerprint: String,
    },
    SaveAudio {
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
        #[serde(default)]
        target: String,
        #[serde(default)]
        saved_path: String,
        #[serde(default)]
        auto_target: String,
        #[serde(default)]
        auto_dir: String,
        #[serde(default)]
        auto_state: String,
        #[serde(default)]
        auto_error: String,
        #[serde(default)]
        auto_fingerprint: String,
    },
    /// 预览节点：内容来自上游（生成产物/加载媒体），metadata 暂无状态。
    PreviewImage {},
    PreviewVideo {},
    PreviewAudio {},

    // ── 视频抽帧节点（2026-11-01）──
    /// 视频首帧/尾帧：video_path 记节点持有的视频；提取出的帧图片写在
    /// 节点行 resource_path 上（下游 save/preview/合集/参考图聚合走通用
    /// resource_path 分支，无需特判）。status/error 留空位。
    VideoFirstFrame {
        #[serde(default)]
        video_path: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
    },
    VideoLastFrame {
        #[serde(default)]
        video_path: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
    },

    // ── 视频工具节点（2026-11-02）──
    /// 视频抽帧（任意时刻）：start_secs 为播放头时间（秒，f64）；产物帧图
    /// 写节点行 resource_path（同首帧/尾帧语义，下游通用分支消费）。
    VideoSeekFrame {
        #[serde(default)]
        video_path: String,
        #[serde(default)]
        start_secs: f64,
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
    },
    /// 视频转 GIF：start_secs/duration_secs 为选区起点与时长（0.5–10s，
    /// 后端命令层再钳制）；产物 GIF 写节点行 resource_path（图像族）。
    VideoToGif {
        #[serde(default)]
        video_path: String,
        #[serde(default)]
        start_secs: f64,
        #[serde(default)]
        duration_secs: f64,
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
    },
    /// 视频抽音轨：选区起点与时长，duration_secs ≤ 0 表示整段；format =
    /// "mp3" | "aac"（空串按 mp3）；产物音频写节点行 resource_path。
    VideoExtractAudio {
        #[serde(default)]
        video_path: String,
        #[serde(default)]
        start_secs: f64,
        #[serde(default)]
        duration_secs: f64,
        #[serde(default)]
        format: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
    },

    // ── 画布备注（不属于三类链路） ──
    Note {
        #[serde(default)]
        content: String,
    },
}

/// 图片节点生成状态机（阶段 2 逐格填充用，一期仅 idle/空壳）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImageNodeStatus {
    #[default]
    Idle,
    Generating,
    Done,
    Error,
}

/// 图片节点自身生成参数（上游连线才是提示词主来源，这里是节点参数面板
/// 的补充项）。字段全 default，阶段 2 增字段不破坏旧 JSON。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub(crate) struct ImageGenParams {
    pub model: String,
    pub size: String,
    pub count: i64,
}

impl Default for ImageGenParams {
    fn default() -> Self {
        ImageGenParams { model: String::new(), size: String::new(), count: 1 }
    }
}

/// 单张生成备选（方案 3.5）：宽高/字节为展示与排序用元数据，
/// resource_path 相对库根，primary 即主图语义（下游引用取主图）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub(crate) struct GeneratedImage {
    pub width: i64,
    pub height: i64,
    pub bytes: i64,
    pub resource_path: String,
    pub primary: bool,
}

impl Default for GeneratedImage {
    fn default() -> Self {
        GeneratedImage { width: 0, height: 0, bytes: 0, resource_path: String::new(), primary: false }
    }
}

impl NodeMeta {
    /// 节点类型的默认 metadata（建节点未传 metadata 时）；未知类型在此
    /// 一并拒绝。旧三类型（text/ref/image）保留默认值供 v4 迁移与宽容读
    /// 使用——创建入口（create_node）已拒绝。
    pub(crate) fn default_for(node_type: &str) -> Result<NodeMeta, String> {
        match node_type {
            "text" => Ok(NodeMeta::Text { content: String::new() }),
            "ref" => Ok(NodeMeta::Ref {}),
            "image" => Ok(NodeMeta::Image {
                params: ImageGenParams::default(),
                status: ImageNodeStatus::Idle,
                error: String::new(),
                images: Vec::new(),
            }),
            "note" => Ok(NodeMeta::Note { content: String::new() }),
            "load_text" => Ok(NodeMeta::LoadText { content: String::new() }),
            "load_image" => Ok(NodeMeta::LoadImage {}),
            "load_video" => Ok(NodeMeta::LoadVideo {}),
            "load_audio" => Ok(NodeMeta::LoadAudio {}),
            "gen_image" => Ok(NodeMeta::GenImage {
                params: ImageGenParams::default(),
                status: ImageNodeStatus::Idle,
                error: String::new(),
                images: Vec::new(),
            }),
            "gen_video" => Ok(NodeMeta::GenVideo {
                params: ImageGenParams::default(),
                status: ImageNodeStatus::Idle,
                error: String::new(),
            }),
            "gen_audio" => Ok(NodeMeta::GenAudio {
                params: ImageGenParams::default(),
                status: ImageNodeStatus::Idle,
                error: String::new(),
            }),
            "save_image" => Ok(NodeMeta::SaveImage {
                status: String::new(),
                error: String::new(),
                target: String::new(),
                saved_path: String::new(),
                auto_target: String::new(),
                auto_dir: String::new(),
                auto_state: String::new(),
                auto_error: String::new(),
                auto_fingerprint: String::new(),
            }),
            "save_video" => Ok(NodeMeta::SaveVideo {
                status: String::new(),
                error: String::new(),
                target: String::new(),
                saved_path: String::new(),
                auto_target: String::new(),
                auto_dir: String::new(),
                auto_state: String::new(),
                auto_error: String::new(),
                auto_fingerprint: String::new(),
            }),
            "save_audio" => Ok(NodeMeta::SaveAudio {
                status: String::new(),
                error: String::new(),
                target: String::new(),
                saved_path: String::new(),
                auto_target: String::new(),
                auto_dir: String::new(),
                auto_state: String::new(),
                auto_error: String::new(),
                auto_fingerprint: String::new(),
            }),
            "preview_image" => Ok(NodeMeta::PreviewImage {}),
            "preview_video" => Ok(NodeMeta::PreviewVideo {}),
            "preview_audio" => Ok(NodeMeta::PreviewAudio {}),
            "video_first_frame" => Ok(NodeMeta::VideoFirstFrame {
                video_path: String::new(),
                status: String::new(),
                error: String::new(),
            }),
            "video_last_frame" => Ok(NodeMeta::VideoLastFrame {
                video_path: String::new(),
                status: String::new(),
                error: String::new(),
            }),
            "video_seek_frame" => Ok(NodeMeta::VideoSeekFrame {
                video_path: String::new(),
                start_secs: 0.0,
                status: String::new(),
                error: String::new(),
            }),
            "video_to_gif" => Ok(NodeMeta::VideoToGif {
                video_path: String::new(),
                start_secs: 0.0,
                // GIF 必须有有效时长（0.5–10s），默认 3.0s。
                duration_secs: 3.0,
                status: String::new(),
                error: String::new(),
            }),
            "video_extract_audio" => Ok(NodeMeta::VideoExtractAudio {
                video_path: String::new(),
                start_secs: 0.0,
                duration_secs: 0.0,
                format: String::new(),
                status: String::new(),
                error: String::new(),
            }),
            "collection_image" => Ok(NodeMeta::CollectionImage { order: Vec::new() }),
            "collection_text" => Ok(NodeMeta::CollectionText { order: Vec::new() }),
            "collection_video" => Ok(NodeMeta::CollectionVideo { order: Vec::new() }),
            other => Err(format!("未知节点类型：{other}")),
        }
    }

    /// 旧三类型已在 v4 迁移为新类型，不再允许创建。
    pub(crate) fn is_legacy_type(node_type: &str) -> bool {
        matches!(node_type, "text" | "ref" | "image")
    }

    fn kind(&self) -> &'static str {
        match self {
            NodeMeta::Text { .. } => "text",
            NodeMeta::Ref { .. } => "ref",
            NodeMeta::Image { .. } => "image",
            NodeMeta::Note { .. } => "note",
            NodeMeta::LoadText { .. } => "load_text",
            NodeMeta::LoadImage { .. } => "load_image",
            NodeMeta::LoadVideo { .. } => "load_video",
            NodeMeta::LoadAudio { .. } => "load_audio",
            NodeMeta::GenImage { .. } => "gen_image",
            NodeMeta::GenVideo { .. } => "gen_video",
            NodeMeta::GenAudio { .. } => "gen_audio",
            NodeMeta::SaveImage { .. } => "save_image",
            NodeMeta::SaveVideo { .. } => "save_video",
            NodeMeta::SaveAudio { .. } => "save_audio",
            NodeMeta::PreviewImage { .. } => "preview_image",
            NodeMeta::PreviewVideo { .. } => "preview_video",
            NodeMeta::PreviewAudio { .. } => "preview_audio",
            NodeMeta::VideoFirstFrame { .. } => "video_first_frame",
            NodeMeta::VideoLastFrame { .. } => "video_last_frame",
            NodeMeta::VideoSeekFrame { .. } => "video_seek_frame",
            NodeMeta::VideoToGif { .. } => "video_to_gif",
            NodeMeta::VideoExtractAudio { .. } => "video_extract_audio",
            NodeMeta::CollectionImage { .. } => "collection_image",
            NodeMeta::CollectionText { .. } => "collection_text",
            NodeMeta::CollectionVideo { .. } => "collection_video",
        }
    }
}

/// 读路径宽容解析：kind 与类型列不符 / JSON 损坏 / 字段缺失时回退该类型
/// 默认值——历史脏数据不阻断加载（对齐工程域幂等升级哲学）。
pub(crate) fn parse_node_meta_lenient(node_type: &str, raw: &str) -> NodeMeta {
    let default = match NodeMeta::default_for(node_type) {
        Ok(default) => default,
        Err(_) => return NodeMeta::Text { content: String::new() },
    };
    match serde_json::from_str::<NodeMeta>(raw) {
        Ok(meta) if meta.kind() == node_type => meta,
        _ => default,
    }
}

/// 写路径严格解析：空串给默认值；kind 与类型列不符直接报错，不让脏
/// metadata 落库。
pub(super) fn parse_node_meta_strict(node_type: &str, raw: &str) -> Result<NodeMeta, String> {
    if raw.trim().is_empty() {
        return NodeMeta::default_for(node_type);
    }
    let meta: NodeMeta =
        serde_json::from_str(raw).map_err(|e| format!("metadata JSON 解析失败：{e}"))?;
    if meta.kind() != node_type {
        return Err(format!(
            "metadata 类型 {} 与节点类型 {node_type} 不符",
            meta.kind()
        ));
    }
    Ok(meta)
}
