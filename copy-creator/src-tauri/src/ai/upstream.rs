// 生成输入收集：合集成员展开 / 文本 / 参考图路径与 data URL（自 ai.rs 零改动拆分，2026-11-03 阶段 9a）。
use super::*;

fn collection_member_order(
    conn: &rusqlite::Connection,
    collection_id: &str,
    order: &[String],
) -> Result<Vec<String>, String> {
    let mut ids: Vec<String> = conn
        .prepare(
            "SELECT from_node FROM canvas_connections \
             WHERE to_node = ?1 ORDER BY created_at ASC, id ASC",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![collection_id], |row| row.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .map_err(|e| e.to_string())?;
    let mut ordered = Vec::new();
    for id in order {
        if let Some(pos) = ids.iter().position(|x| x == id) {
            ordered.push(ids.remove(pos));
        }
    }
    ordered.extend(ids);
    Ok(ordered)
}

/// 合集成员的文本贡献：load_text 非空内容（旧 text 类型兼容读）。
fn member_text(conn: &rusqlite::Connection, node_id: &str) -> Result<Option<String>, String> {
    let (node_type, meta_raw): (String, String) = conn
        .query_row(
            "SELECT type, metadata FROM canvas_nodes WHERE id = ?1",
            params![node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(match parse_node_meta_lenient(&node_type, &meta_raw) {
        NodeMeta::LoadText { content } | NodeMeta::Text { content } => {
            let content = content.trim().to_string();
            if content.is_empty() { None } else { Some(content) }
        }
        _ => None,
    })
}

/// 合集成员的媒体贡献：加载媒体的资源路径 / 生成图像的主图路径。
/// 视频工具节点（首帧/尾帧等）的产物同写节点行 resource_path，走同一
/// 「行级路径」臂——此前落到 `_ => {}` 被静默丢弃（2026-11-01 修复）。
fn member_reference(conn: &rusqlite::Connection, node_id: &str) -> Result<Option<PathBuf>, String> {
    let (node_type, meta_raw, resource_path): (String, String, String) = conn
        .query_row(
            "SELECT type, metadata, resource_path FROM canvas_nodes WHERE id = ?1",
            params![node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(match parse_node_meta_lenient(&node_type, &meta_raw) {
        NodeMeta::Ref {}
        | NodeMeta::LoadImage {}
        | NodeMeta::LoadVideo {}
        | NodeMeta::LoadAudio {}
        | NodeMeta::VideoFirstFrame { .. }
        | NodeMeta::VideoLastFrame { .. }
        | NodeMeta::VideoSeekFrame { .. }
        | NodeMeta::VideoToGif { .. } => {
            if resource_path.trim().is_empty() {
                None
            } else {
                Some(PathBuf::from(resource_path))
            }
        }
        NodeMeta::Image { images, .. } | NodeMeta::GenImage { images, .. } => {
            let primary = images.iter().find(|i| i.primary).or_else(|| images.first());
            primary.and_then(|img| {
                if img.resource_path.trim().is_empty() {
                    None
                } else {
                    Some(PathBuf::from(img.resource_path.clone()))
                }
            })
        }
        _ => None,
    })
}

/// 生成输入收集（方案 3.6 + 节点体系 v2）：入线按连线创建顺序——
/// load_text→提示词（旧 text 兼容），load_image/load_video/load_audio→
/// 资源路径，gen_image→主图路径；合集节点按用户排序展开成员（文本合集
/// 逐项拼提示词，图像/视频合集逐项入参考图）；note 与空路径跳过。
pub(super) fn collect_upstream(conn: &rusqlite::Connection, node_id: &str) -> Result<UpstreamInput, String> {
    let mut prompt_parts: Vec<String> = Vec::new();
    let mut references: Vec<PathBuf> = Vec::new();
    let from_ids: Vec<String> = conn
        .prepare(
            "SELECT from_node FROM canvas_connections \
             WHERE to_node = ?1 ORDER BY created_at ASC, id ASC",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![node_id], |row| row.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .map_err(|e| e.to_string())?;
    for from_id in from_ids {
        let (node_type, meta_raw, resource_path): (String, String, String) = conn
            .query_row(
                "SELECT type, metadata, resource_path FROM canvas_nodes WHERE id = ?1",
                params![&from_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        match parse_node_meta_lenient(&node_type, &meta_raw) {
            NodeMeta::Text { content } | NodeMeta::LoadText { content } => {
                if !content.trim().is_empty() {
                    prompt_parts.push(content);
                }
            }
            NodeMeta::Ref {}
            | NodeMeta::LoadImage {}
            | NodeMeta::LoadVideo {}
            | NodeMeta::LoadAudio {}
            | NodeMeta::VideoFirstFrame { .. }
            | NodeMeta::VideoLastFrame { .. }
            | NodeMeta::VideoSeekFrame { .. }
            | NodeMeta::VideoToGif { .. } => {
                if !resource_path.trim().is_empty() {
                    references.push(PathBuf::from(resource_path));
                }
            }
            NodeMeta::Image { images, .. } | NodeMeta::GenImage { images, .. } => {
                let primary = images.iter().find(|i| i.primary).or_else(|| images.first());
                if let Some(img) = primary {
                    if !img.resource_path.trim().is_empty() {
                        references.push(PathBuf::from(img.resource_path.clone()));
                    }
                }
            }
            NodeMeta::CollectionText { order } => {
                for member in collection_member_order(conn, &from_id, &order)? {
                    if let Some(text) = member_text(conn, &member)? {
                        prompt_parts.push(text);
                    }
                }
            }
            NodeMeta::CollectionImage { order } | NodeMeta::CollectionVideo { order } => {
                for member in collection_member_order(conn, &from_id, &order)? {
                    if let Some(path) = member_reference(conn, &member)? {
                        references.push(path);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(UpstreamInput { prompt: prompt_parts.join("\n"), references })
}

/// 参考路径解析（纯路径逻辑便于单测）：库内相对路径拼库根；画布工具
/// 节点产物是 canvas-gen 绝对路径，直通使用（同 canvas_media resolve_source
/// 的语义，不依赖 root.join 对绝对路径的隐式覆盖行为）。
fn resolve_reference_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.trim().replace('\\', "/");
    if cleaned.is_empty() {
        return Err("参考图路径为空".to_string());
    }
    let candidate = Path::new(&cleaned);
    let abs = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(&cleaned)
    };
    if !abs.exists() {
        return Err(format!("参考图不存在：{cleaned}"));
    }
    Ok(abs)
}

/// 库内相对路径 → 绝对路径（resource_path 与工程域同为相对库根软路径）。
pub(super) fn resolve_library_path(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    resolve_reference_path(&crate::db::get_resource_library_dir(app), rel)
}

pub(super) fn file_to_data_url(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取参考图失败：{e}"))?;
    let mime = match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

pub(super) fn data_url_decode(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let rest = data_url
        .strip_prefix("data:")
        .ok_or_else(|| "非 data URL，需先下载".to_string())?;
    let (meta, data) = rest.split_once(";base64,").ok_or_else(|| "非 base64 data URL".to_string())?;
    let mime = meta.split(';').next().unwrap_or("image/png").to_string();
    let bytes = BASE64.decode(data).map_err(|e| format!("图片 base64 解码失败：{e}"))?;
    Ok((mime, bytes))
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolve_reference_path_rules() {
        // 相对路径拼库根；canvas-gen 绝对路径直通；空路径/缺失报错；
        // 反斜杠统一归一为正斜杠。
        let root = std::env::temp_dir().join(format!("cc-ai-ref-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("frame.png");
        std::fs::write(&file, b"png").unwrap();
        assert_eq!(resolve_reference_path(&root, " frame.png ").unwrap(), file);
        assert_eq!(
            resolve_reference_path(&root, &file.to_string_lossy()).unwrap(),
            file
        );
        assert_eq!(
            resolve_reference_path(&root, "  "),
            Err("参考图路径为空".to_string())
        );
        assert_eq!(
            resolve_reference_path(&root, "sub\\frame.png"),
            Err("参考图不存在：sub/frame.png".to_string())
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn collect_upstream_video_tool_reference() {
        // 帧产物（节点行 resource_path）经连线进 gen_image 参考——此前
        // match 缺臂被静默丢弃；load_image 同臂回归对照，文本拼提示词。
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::ensure_schema(&conn).unwrap();
        let now = "2026-11-01T00:00:00Z";
        conn.execute(
            "INSERT INTO canvases (id, name, created_at, updated_at) VALUES ('cv', 't', ?1, ?1)",
            params![now],
        )
        .unwrap();
        for (id, ty, meta, rp) in [
            ("n_text", "load_text", r#"{"kind":"load_text","content":"画一只猫"}"#, ""),
            ("n_img", "load_image", r#"{"kind":"load_image"}"#, "lib/cat.png"),
            (
                "n_frame",
                "video_first_frame",
                r#"{"kind":"video_first_frame","video_path":"v.mp4"}"#,
                "C:\\cache\\canvas-gen\\u1-first.png",
            ),
        ] {
            conn.execute(
                "INSERT INTO canvas_nodes (id, canvas_id, type, metadata, resource_path, created_at, updated_at) \
                 VALUES (?1, 'cv', ?2, ?3, ?4, ?5, ?5)",
                params![id, ty, meta, rp, now],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO canvas_nodes (id, canvas_id, type, metadata, resource_path, created_at, updated_at) \
             VALUES ('g', 'cv', 'gen_image', '{\"kind\":\"gen_image\"}', '', ?1, ?1)",
            params![now],
        )
        .unwrap();
        for (cid, from) in [("c1", "n_text"), ("c2", "n_img"), ("c3", "n_frame")] {
            conn.execute(
                "INSERT INTO canvas_connections (id, canvas_id, from_node, to_node, to_port, created_at) \
                 VALUES (?1, 'cv', ?2, 'g', 'image', ?3)",
                params![cid, from, now],
            )
            .unwrap();
        }
        let input = collect_upstream(&conn, "g").unwrap();
        assert_eq!(input.prompt, "画一只猫");
        assert_eq!(
            input.references,
            vec![
                PathBuf::from("lib/cat.png"),
                PathBuf::from("C:\\cache\\canvas-gen\\u1-first.png"),
            ]
        );
    }}
