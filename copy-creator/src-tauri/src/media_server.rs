//! 本机回环 HTTP 媒体服务。
//!
//! WebKitGTK 的 `<video>`/`<audio>` 无法播放 asset:// 自定义协议地址：
//! WebKit 的媒体协议白名单只放行 blob/data/file/http/https，且 GStreamer
//! 侧也没有 asset 协议对应的 URI 源元素（报"asset 未实现 URI 处理器"）。
//! 图片走 `<img>` 不受影响，因此仅视频/音频预览改由本服务经 127.0.0.1
//! 提供 HTTP 文件流，并用每次启动随机生成的 token 限制访问。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::db;

pub struct MediaServerState {
    pub origin: String,
    pub token: String,
}

#[derive(Serialize)]
pub struct MediaServerInfo {
    pub origin: String,
    pub token: String,
}

#[tauri::command]
pub fn get_media_server_origin(
    state: tauri::State<'_, MediaServerState>,
) -> Result<MediaServerInfo, String> {
    Ok(MediaServerInfo {
        origin: state.origin.clone(),
        token: state.token.clone(),
    })
}

/// 启动回环监听并托管状态；失败仅记录日志，不影响应用其余功能。
pub fn spawn<R: Runtime>(app: &AppHandle<R>) {
    let token = uuid::Uuid::new_v4().to_string();
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(error) => {
            log::warn!("[media-server] 启动失败，视频/音频将无法预览: {error}");
            return;
        }
    };
    let origin = match listener.local_addr() {
        Ok(address) => format!("http://{}", address),
        Err(error) => {
            log::warn!("[media-server] 获取监听地址失败: {error}");
            return;
        }
    };
    app.manage(MediaServerState {
        origin: origin.clone(),
        token: token.clone(),
    });
    log::info!("[media-server] listening on {origin}");

    // 启动恢复落库的外部媒体授权清单（盘选/拖入文件的跨会话预览）；
    // 再按画布节点已引用的路径自愈补登记——旧版本盘选授权只存内存且
    // 登记形态（反斜杠）与落库引用（正斜杠）失配，历史节点重启即 404。
    // init_db 先于本函数执行，DbState 必已就绪。
    restore_authorized_external_files(app);
    authorize_canvas_referenced_files(app);

    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    let token = token.clone();
                    std::thread::spawn(move || {
                        let _ = handle_connection(stream, &app, &token);
                    });
                }
                Err(error) => log::warn!("[media-server] accept 失败: {error}"),
            }
        }
    });
}

fn write_simple_response(mut stream: &TcpStream, status: u16, text: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {text}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    stream.write_all(head.as_bytes()).and_then(|_| stream.flush())
}

fn handle_connection<R: Runtime>(
    stream: TcpStream,
    app: &AppHandle<R>,
    token: &str,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut range = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range = value.trim().to_string();
            }
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" && method != "HEAD" {
        return write_simple_response(&stream, 400, "Bad Request");
    }

    let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");
    let params = parse_query(query);
    if params.get("token").map(String::as_str) != Some(token) {
        return write_simple_response(&stream, 403, "Forbidden");
    }
    let Some(raw_path) = params.get("path") else {
        return write_simple_response(&stream, 400, "Bad Request");
    };
    let Some(local_path) = resolve_media_file(app, raw_path) else {
        // 404 原因留痕：未授权（管理目录外且不在清单）或文件缺失，现场
        // 排障看日志即可分辨，不必再猜。
        log::warn!("[media-server] 404：路径未获授权或文件缺失 path={raw_path}");
        return write_simple_response(&stream, 404, "Not Found");
    };
    let Ok(metadata) = std::fs::metadata(&local_path) else {
        return write_simple_response(&stream, 404, "Not Found");
    };
    if !metadata.is_file() {
        return write_simple_response(&stream, 404, "Not Found");
    }
    let length = metadata.len();

    let (status, start, end) = match resolve_byte_range(&range, length) {
        ByteRange::Full => (200, 0_u64, length.saturating_sub(1)),
        ByteRange::Partial(start, end) => (206, start, end),
        ByteRange::Invalid => {
            let mut stream = stream;
            let head = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{length}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            return stream.write_all(head.as_bytes()).and_then(|_| stream.flush());
        }
    };
    let content_type = media_content_type(&local_path);
    let content_length = if length == 0 { 0 } else { end - start + 1 };
    let status_text = if status == 206 { "Partial Content" } else { "OK" };
    // ACAO 必须存在：前端视频海报经 <video crossOrigin="anonymous"> 取帧
    // 导出 canvas，跨源且无此头时 canvas 被污染，toDataURL 直接抛错。
    let mut head = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {content_length}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n"
    );
    if status == 206 {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{length}\r\n"));
    }
    head.push_str("\r\n");

    let mut stream = stream;
    stream.write_all(head.as_bytes())?;
    if method == "HEAD" || length == 0 {
        return stream.flush();
    }

    let mut file = std::fs::File::open(&local_path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = content_length;
    let mut buffer = vec![0_u8; 128 * 1024];
    while remaining > 0 {
        let chunk = buffer.len().min(remaining as usize);
        let read = file.read(&mut buffer[..chunk])?;
        if read == 0 {
            break;
        }
        stream.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    stream.flush()
}

enum ByteRange {
    Full,
    Partial(u64, u64),
    Invalid,
}

/// 解析 `bytes=start-end` 单区间 Range 头；后缀式 `bytes=-n` 取末尾 n 字节。
/// 空头返回 Full；语法不合法或越界返回 Invalid（调用方回复 416）。
fn resolve_byte_range(header: &str, length: u64) -> ByteRange {
    if header.is_empty() {
        return ByteRange::Full;
    }
    if length == 0 {
        return ByteRange::Invalid;
    }
    let Some(spec) = header.strip_prefix("bytes=") else {
        return ByteRange::Invalid;
    };
    let spec = spec.trim();
    if spec.is_empty() || spec.contains(',') {
        return ByteRange::Invalid;
    }
    let Some((start_raw, end_raw)) = spec.split_once('-') else {
        return ByteRange::Invalid;
    };
    let parse_number = |value: &str| -> Option<u64> {
        let value = value.trim();
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        value.parse::<u64>().ok()
    };
    match (parse_number(start_raw), parse_number(end_raw)) {
        (Some(start), Some(end)) if start <= end && start < length => {
            ByteRange::Partial(start, end.min(length - 1))
        }
        (Some(start), None) if start < length => ByteRange::Partial(start, length - 1),
        (None, Some(suffix)) if suffix > 0 => {
            ByteRange::Partial(length.saturating_sub(suffix), length - 1)
        }
        _ => ByteRange::Invalid,
    }
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                output.push(byte);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

/// 与前端 resolveResourceMediaUrl 相同的语义：绝对路径直接使用，
/// 相对路径拼接到应用存储目录之下。解析结果必须落在应用管理目录内
/// （存储目录 / 资源库），或已被剪切板记录在案——剪切板文件记录可以
/// 指向用户复制的任意位置文件，展示与粘贴它们本就是应用既有能力；
/// 前者防 token 泄漏后读任意文件，后者为已复制文件的精确全等匹配，
/// 注入者仍需猜中确切路径。两个条件都必须过，缺一不可。
fn resolve_media_file<R: Runtime>(app: &AppHandle<R>, raw: &str) -> Option<PathBuf> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let path = Path::new(value);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        db::get_storage_dir(app).join(value.trim_start_matches(['/', '\\']))
    };
    if !db::is_app_managed_path(app, &resolved)
        && !db::is_recorded_file_path(app, value)
        && !is_authorized_external_path(&resolved)
    {
        return None;
    }
    Some(resolved)
}

// ── 运行时授权外部文件（画布加载节点） ─────────────────────
// 画布的加载节点允许引用用户通过系统文件对话框明确选择的任意路径文件
// （仅预览/引用，不复制入库）。这类路径不在应用管理目录内，为让媒体
// 服务放行，选择动作发生时把确切路径登记进授权清单——注入者仍需同时
// 猜中 token 与确切文件路径，安全边界与剪切板记录同哲学。
//
// 授权清单持久化在 settings 表（2026-11-06）：节点行的 resource_path
// 落库跨会话存在，而清单此前只在内存——应用重启后所有盘选/拖入的本地
// 文件预览一律 404（用户报告「加载节点无法显示预览图」的根源）。清单
// 落库后重启即恢复，安全面不变：放行的仍只是「用户明确选择过的那些路
// 径」的精确全等匹配，注入者依旧要同时猜中 token 与确切路径。
static AUTHORIZED_EXTERNAL_FILES: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

/// settings 表键：已授权外部媒体路径（JSON 字符串数组）。
const AUTHORIZED_MEDIA_KEY: &str = "canvas_authorized_media";
/// 清单上限（FIFO 淘汰最旧）：只作引用预览，历史路径无限累积无意义。
const AUTHORIZED_MEDIA_CAP: usize = 500;

/// 授权路径归一：① 剥 Windows canonicalize 残留的 `\\?\` / `\\?\UNC\`
/// 扩展前缀；② `\` 统一转 `/`——与节点行落库归一（normalize_project_path）
/// 同形：对话框登记的是反斜杠路径，节点行回读的是正斜杠路径，两侧必须
/// 落在同一形态上，否则精确全等匹配必然失约（盘选预览 404 的真根因）。
fn normalize_external_path(value: &str) -> String {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    // 前缀均为 ASCII，按字符数切原串不越字节界。
    let stripped = if lower.starts_with(r"\\?\unc\") {
        format!("\\\\{}", &trimmed[8..])
    } else if lower.starts_with(r"\\?\") {
        trimmed[4..].to_string()
    } else {
        trimmed.to_string()
    };
    stripped.replace('\\', "/")
}

fn is_authorized_external_path(path: &std::path::Path) -> bool {
    let wanted = normalize_external_path(&path.to_string_lossy());
    let guard = AUTHORIZED_EXTERNAL_FILES.lock().unwrap();
    match guard.as_ref() {
        Some(set) => set.contains(&wanted),
        None => false,
    }
}

/// 登记用户通过系统对话框明确选择的文件路径（画布加载节点引用）：
/// 运行时清单即时生效，并写通 settings 表供下次启动恢复。
pub fn authorize_external_file<R: Runtime>(app: &AppHandle<R>, path: &str) {
    let normalized = normalize_external_path(path);
    AUTHORIZED_EXTERNAL_FILES
        .lock()
        .unwrap()
        .get_or_insert_with(std::collections::HashSet::new)
        .insert(normalized.clone());
    // 落库：读取现有清单 → 去重插入 → FIFO 截断 → 写回。重复路径直接
    // 跳过（绝大多数重选是同一路径），避免无谓的写放大。
    let mut list = authorized_media_from_db(app);
    if list.iter().any(|item| item == &normalized) {
        return;
    }
    list.push(normalized);
    let start = list.len().saturating_sub(AUTHORIZED_MEDIA_CAP);
    let value = serde_json::to_string(&list[start..]).unwrap_or_default();
    if let Err(error) = db::set_setting_inner(app, AUTHORIZED_MEDIA_KEY, &value) {
        log::warn!("[media-server] 授权清单落库失败（重启后该文件预览会失效）: {error}");
    }
}

/// 从 settings 读已授权清单（缺表/坏 JSON 容错为空）。
fn authorized_media_from_db<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    db::get_setting_sync(app, AUTHORIZED_MEDIA_KEY)
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default()
}

/// 启动恢复：媒体服务开始接客前把落库清单装回运行时集合。
pub fn restore_authorized_external_files<R: Runtime>(app: &AppHandle<R>) {
    let list = authorized_media_from_db(app);
    let mut guard = AUTHORIZED_EXTERNAL_FILES.lock().unwrap();
    let set = guard.get_or_insert_with(std::collections::HashSet::new);
    for path in list {
        set.insert(normalize_external_path(&path));
    }
}

/// 画布节点已引用的外部媒体自愈：遍历节点行 resource_path 与
/// metadata.video_path，存在的管理目录外文件补登记（只增授权面，不碰
/// 节点数据；管理目录内的文件本就放行，跳过）。
pub fn authorize_canvas_referenced_files<R: Runtime>(app: &AppHandle<R>) {
    for raw in db::canvas_referenced_media_paths(app) {
        let normalized = normalize_external_path(&raw);
        if normalized.is_empty() {
            continue;
        }
        let path = std::path::PathBuf::from(&normalized);
        if !path.is_file() || db::is_app_managed_path(app, &path) {
            continue;
        }
        authorize_external_file(app, &normalized);
    }
}

fn media_content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "weba" => "audio/webm",
        "mid" | "midi" => "audio/midi",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        // 无扩展名/清单外扩展名的媒体（如「.mp4」无主名文件）按魔数给
        // 出精确类型：浏览器 <video>/<audio> 对 octet-stream 虽常能嗅探
        // 播放，显式类型让 Range 预检与播放器行为保持确定。
        _ => sniff_content_type(path),
    }
}

/// 文件头魔数 → 精确 content type（与 media_kind::sniff_media_kind 同一批
/// 魔数；此处需要细分到具体容器，不直接复用其 MediaKind 粗分类）。
fn sniff_content_type(path: &Path) -> &'static str {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return "application/octet-stream";
    };
    let mut head = [0_u8; 12];
    let Ok(bytes_read) = file.read(&mut head) else {
        return "application/octet-stream";
    };
    let head = &head[..bytes_read];
    if head.len() < 12 {
        return "application/octet-stream";
    }
    if &head[4..8] == b"ftyp" {
        return "video/mp4";
    }
    if head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return "video/x-matroska";
    }
    if &head[..4] == b"RIFF" {
        if &head[8..12] == b"AVI " {
            return "video/x-msvideo";
        }
        if &head[8..12] == b"WAVE" {
            return "audio/wav";
        }
        return "application/octet-stream";
    }
    if &head[..4] == b"OggS" {
        return "video/ogg";
    }
    if &head[..3] == b"ID3" {
        return "audio/mpeg";
    }
    "application/octet-stream"
}

#[cfg(test)]
mod media_server_tests {
    use super::{media_content_type, parse_query, percent_decode, resolve_byte_range, ByteRange};
    use std::path::Path;

    #[test]
    fn byte_range_parses_single_ranges() {
        assert!(matches!(
            resolve_byte_range("", 100),
            ByteRange::Full
        ));
        assert!(matches!(
            resolve_byte_range("bytes=0-49", 100),
            ByteRange::Partial(0, 49)
        ));
        assert!(matches!(
            resolve_byte_range("bytes=50-", 100),
            ByteRange::Partial(50, 99)
        ));
        assert!(matches!(
            resolve_byte_range("bytes=-10", 100),
            ByteRange::Partial(90, 99)
        ));
        // 末尾越界时截断到文件末尾
        assert!(matches!(
            resolve_byte_range("bytes=90-200", 100),
            ByteRange::Partial(90, 99)
        ));
        assert!(matches!(
            resolve_byte_range("bytes=100-", 100),
            ByteRange::Invalid
        ));
        assert!(matches!(
            resolve_byte_range("bytes=60-50", 100),
            ByteRange::Invalid
        ));
        assert!(matches!(
            resolve_byte_range("bytes=abc-", 100),
            ByteRange::Invalid
        ));
        assert!(matches!(
            resolve_byte_range("bytes=0-1,5-9", 100),
            ByteRange::Invalid
        ));
        assert!(matches!(
            resolve_byte_range("bytes=0-0", 0),
            ByteRange::Invalid
        ));
    }

    #[test]
    fn percent_decode_restores_utf8_and_keeps_invalid_escapes() {
        assert_eq!(
            percent_decode("%2Fhome%2Fao%2F%E4%B8%8B%E8%BD%BD%2Ftest%2Fa.mp4"),
            "/home/ao/下载/test/a.mp4"
        );
        assert_eq!(percent_decode("a%2zb"), "a%2zb");
        assert_eq!(percent_decode("plain"), "plain");
    }

    #[test]
    fn query_pairs_are_split_and_decoded() {
        let params = parse_query("token=abc&path=%2Fhome%2Fa%20b.mp4");
        assert_eq!(params.get("token").map(String::as_str), Some("abc"));
        assert_eq!(
            params.get("path").map(String::as_str),
            Some("/home/a b.mp4")
        );
    }

    #[test]
    fn content_type_sniffs_media_magic_for_extensionless_files() {
        // 无主名「.mp4」与清单外扩展名按魔数给精确类型（与收录嗅探同源）。
        let dir = std::env::temp_dir().join(format!("copy-creator-mime-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        };
        assert_eq!(
            media_content_type(&write(".mp4", b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41pad")),
            "video/mp4"
        );
        assert_eq!(
            media_content_type(&write("clip.bin", &[0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4, 5, 6, 7, 8])),
            "video/x-matroska"
        );
        assert_eq!(
            media_content_type(&write("snd.bin", b"RIFF\x24\x00\x00\x00WAVEfmt ")),
            "audio/wav"
        );
        assert_eq!(
            media_content_type(&write("data.bin", [0x50, 0x4B, 0x03, 0x04, 0, 1, 2, 3, 4, 5, 6, 7].as_slice())),
            "application/octet-stream"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn content_type_matches_media_extensions() {
        assert_eq!(
            media_content_type(Path::new("/tmp/a.MP4")),
            "video/mp4"
        );
        assert_eq!(media_content_type(Path::new("/tmp/a.mkv")), "video/x-matroska");
        assert_eq!(media_content_type(Path::new("/tmp/a.mp3")), "audio/mpeg");
        assert_eq!(media_content_type(Path::new("/tmp/a.m4a")), "audio/mp4");
        assert_eq!(
            media_content_type(Path::new("/tmp/a.unknown")),
            "application/octet-stream"
        );
    }
}

#[cfg(test)]
mod media_server_http_tests {
    use super::{spawn, MediaServerState};
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::PathBuf;
    use tauri::Manager;

    fn percent_encode(value: &str) -> String {
        value
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect()
    }

    fn request(
        origin: &str,
        method: &str,
        target: &str,
        range: Option<&str>,
    ) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let address = origin.trim_start_matches("http://");
        let mut stream = TcpStream::connect(address).unwrap();
        let mut head = format!("{method} {target} HTTP/1.1\r\nHost: {address}\r\n");
        if let Some(range) = range {
            head.push_str(&format!("Range: {range}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("response head terminator");
        let head = String::from_utf8_lossy(&response[..split]).to_string();
        let body = response[split + 4..].to_vec();
        let mut lines = head.lines();
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
            .expect("status code");
        let headers = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
            })
            .collect();
        (status, headers, body)
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn serves_local_media_with_token_and_byte_ranges() {
        let dir: PathBuf = std::env::temp_dir().join(format!(
            "copy-creator-media-server-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let app = tauri::test::mock_app();
        // 媒体解析的白名单需要 DbState（存储/资源库目录）：内存库 +
        // storage_path 指向测试目录，使被请求文件落在放行边界内。
        // clipboard_records 供"记录在案"例外使用（剪切板文件记录可以
        // 指向管理目录之外，如下载目录里的原始文件）。
        {
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE clipboard_records (
                     id TEXT PRIMARY KEY,
                     type TEXT NOT NULL,
                     content TEXT NOT NULL,
                     source_app TEXT DEFAULT '',
                     created_at TEXT NOT NULL,
                     user_api_key INTEGER DEFAULT 0,
                     sort_order REAL,
                     group_name TEXT DEFAULT '',
                     attachments TEXT DEFAULT '[]',
                     storage_mode TEXT DEFAULT 'database',
                     resource_path TEXT DEFAULT '',
                     resource_note TEXT DEFAULT '',
                     resource_external INTEGER DEFAULT 0,
                     last_used_at TEXT DEFAULT '',
                     use_count INTEGER DEFAULT 0,
                     touched_ms INTEGER DEFAULT 0
                 );
                 CREATE TABLE phrases (
                     id TEXT PRIMARY KEY,
                     group_id TEXT NOT NULL DEFAULT '',
                     title TEXT NOT NULL DEFAULT '',
                     content TEXT NOT NULL DEFAULT '',
                     input_type TEXT DEFAULT 'text',
                     source_path TEXT DEFAULT '',
                     file_size INTEGER DEFAULT 0,
                     sort_order REAL,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL,
                     last_used_at TEXT DEFAULT '',
                     use_count INTEGER DEFAULT 0,
                     touched_ms INTEGER DEFAULT 0
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('storage_path', ?1)",
                rusqlite::params![dir.to_string_lossy()],
            )
            .unwrap();
            app.manage(crate::db::DbState {
                conn: std::sync::Mutex::new(conn),
            });
        }
        spawn(app.handle());
        let (origin, token) = {
            let state = app.state::<MediaServerState>();
            (state.origin.clone(), state.token.clone())
        };

        let file = dir.join("clip.mp4");
        let data: Vec<u8> = (0..1000_u32).map(|value| (value % 251) as u8).collect();
        std::fs::write(&file, &data).unwrap();
        let path_param = percent_encode(file.to_str().unwrap());

        let (status, _, _) = request(&origin, "GET", &format!("/media?path={path_param}"), None);
        assert_eq!(status, 403);
        let (status, _, _) = request(
            &origin,
            "GET",
            &format!("/media?token=wrong&path={path_param}"),
            None,
        );
        assert_eq!(status, 403);

        let target = format!("/media?token={token}&path={path_param}");
        let (status, headers, body) = request(&origin, "GET", &target, None);
        assert_eq!(status, 200);
        assert_eq!(header(&headers, "content-type"), Some("video/mp4"));
        assert_eq!(header(&headers, "content-length"), Some("1000"));
        assert_eq!(header(&headers, "accept-ranges"), Some("bytes"));
        assert_eq!(body, data);

        let (status, headers, body) = request(&origin, "GET", &target, Some("bytes=100-199"));
        assert_eq!(status, 206);
        assert_eq!(header(&headers, "content-range"), Some("bytes 100-199/1000"));
        assert_eq!(header(&headers, "content-length"), Some("100"));
        assert_eq!(body, data[100..200].to_vec());

        let (status, headers, body) = request(&origin, "GET", &target, Some("bytes=-50"));
        assert_eq!(status, 206);
        assert_eq!(header(&headers, "content-range"), Some("bytes 950-999/1000"));
        assert_eq!(body, data[950..].to_vec());

        let (status, headers, _) = request(&origin, "GET", &target, Some("bytes=2000-"));
        assert_eq!(status, 416);
        assert_eq!(header(&headers, "content-range"), Some("bytes */1000"));

        let (status, headers, body) = request(&origin, "HEAD", &target, None);
        assert_eq!(status, 200);
        assert_eq!(header(&headers, "content-length"), Some("1000"));
        assert!(body.is_empty());

        let missing = percent_encode(dir.join("missing.mp4").to_str().unwrap());
        let (status, _, _) = request(
            &origin,
            "GET",
            &format!("/media?token={token}&path={missing}"),
            None,
        );
        assert_eq!(status, 404);

        // 图片与音视频共用本服务（asset 协议停用后这是唯一本地媒体通道）：
        // 必须以正确的 image content-type 全量返回。
        let image = dir.join("clip.png");
        std::fs::write(&image, [0x89_u8, b'P', b'N', b'G', 0x0A]).unwrap();
        let image_param = percent_encode(image.to_str().unwrap());
        let (status, headers, body) = request(
            &origin,
            "GET",
            &format!("/media?token={token}&path={image_param}"),
            None,
        );
        assert_eq!(status, 200);
        assert_eq!(header(&headers, "content-type"), Some("image/png"));
        assert_eq!(body, vec![0x89_u8, b'P', b'N', b'G', 0x0A]);

        // 记录在案的管理目录外文件（剪切板文件记录指向下载目录等原始位置）
        // 必须放行——这是 0.3.2 图片无法预览的另一半根因；未记录的越界
        // 路径仍拒绝。相似路径（目录前缀、子串）同样拒绝。
        let outside_dir = std::env::temp_dir().join(format!(
            "copy-creator-media-server-outside-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside_file = outside_dir.join("from-explorer.png");
        std::fs::write(&outside_file, [0x89_u8, b'P', b'N', b'G']).unwrap();
        {
            let state = app.state::<crate::db::DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, created_at) VALUES ('r1', 'file', ?1, '2026-09-15T00:00:00Z')",
                rusqlite::params![outside_file.to_string_lossy()],
            )
            .unwrap();
        }
        let outside_param = percent_encode(outside_file.to_str().unwrap());
        let (status, headers, _) = request(
            &origin,
            "GET",
            &format!("/media?token={token}&path={outside_param}"),
            None,
        );
        assert_eq!(status, 200);
        assert_eq!(header(&headers, "content-type"), Some("image/png"));

        let sibling = outside_dir.join("unrecorded.png");
        std::fs::write(&sibling, b"x").unwrap();
        let sibling_param = percent_encode(sibling.to_str().unwrap());
        let (status, _, _) = request(
            &origin,
            "GET",
            &format!("/media?token={token}&path={sibling_param}"),
            None,
        );
        assert_eq!(status, 404);

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&outside_dir).ok();
    }
}

#[cfg(test)]
mod media_serving_tests {
    use super::{spawn, MediaServerState};
    use crate::db::{ensure_schema, DbState};
    use rusqlite::params;
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::Mutex;
    use tauri::Manager;

    pub(crate) fn encode_query_value(value: &str) -> String {        let mut out = String::new();
        for byte in value.as_bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                    out.push(*byte as char)
                }
                other => out.push_str(&format!("%{other:02X}")),
            }
        }
        out
    }

    pub(crate) fn http_get(origin: &str, target: &str) -> (u16, String, Vec<u8>) {
        let address = origin.trim_start_matches("http://");
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("响应缺少头部结束标记");
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let status: u16 = head
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let body = raw[split + 4..].to_vec();
        (status, head, body)
    }

    // 端到端：真实启动媒体服务线程，带 token 请求库内已收录文件——
    // 回收站「恢复后可正常展示」的协议级证据（令牌/白名单/路径解析/
    // 内容类型/字节流全链路）。
    #[test]
    fn serving_recorded_library_file_returns_full_bytes() {
        let app = tauri::test::mock_app();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        app.manage(DbState { conn: Mutex::new(conn) });
        let library = std::env::temp_dir().join(format!(
            "copy-creator-media-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&library).unwrap();
        let handle = app.handle().clone();

        {
            let state = handle.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            ensure_schema(&conn).unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('resource_library_path', ?1)",
                params![library.to_string_lossy().as_ref()],
            )
            .unwrap();
        }

        // 真实 PNG（1x1 像素）作为库内文件。
        let png_bytes: [u8; 84] = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        let picture = library.join("pic.png");
        std::fs::write(&picture, png_bytes).unwrap();
        {
            let state = handle.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO clipboard_records
                 (id, type, content, created_at, group_name, storage_mode, resource_path, resource_external, attachments)
                 VALUES ('r1', 'file', ?1, '2026-09-19T00:00:00Z', '', 'resource', ?1, 1, '[]')",
                params![picture.to_string_lossy().as_ref()],
            )
            .unwrap();
        }

        spawn(&handle);
        let state = handle.state::<MediaServerState>();
        let origin = state.origin.clone();
        let token = state.token.clone();
        drop(state);

        let target = format!(
            "/media?token={}&path={}",
            encode_query_value(&token),
            encode_query_value(picture.to_string_lossy().as_ref())
        );
        let (status, head, body) = http_get(&origin, &target);
        assert_eq!(status, 200, "head: {head}");
        assert!(head.to_lowercase().contains("content-type: image/png"));
        assert_eq!(body, png_bytes, "媒体字节流必须与文件完全一致");

        // 缺失文件 → 404；令牌错误 → 403（白名单外的路径同样 404）。
        let missing = library.join("nope.png");
        let (status, _, _) = http_get(
            &origin,
            &format!(
                "/media?token={}&path={}",
                encode_query_value(&token),
                encode_query_value(missing.to_string_lossy().as_ref())
            ),
        );
        assert_eq!(status, 404);
        let (status, _, _) = http_get(
            &origin,
            &format!(
                "/media?token=wrong&path={}",
                encode_query_value(picture.to_string_lossy().as_ref())
            ),
        );
        assert_eq!(status, 403);

        std::fs::remove_dir_all(&library).ok();
    }
}

#[cfg(test)]
mod external_authorization_tests {
    use super::{
        authorize_canvas_referenced_files, authorize_external_file, is_authorized_external_path,
        normalize_external_path, restore_authorized_external_files, spawn, MediaServerState,
        AUTHORIZED_EXTERNAL_FILES,
    };
    use super::media_serving_tests::{encode_query_value, http_get};
    use crate::db::canvas_referenced_media_paths;
    use crate::db::{ensure_schema, get_setting_sync, DbState};
    use std::sync::Mutex;
    use tauri::Manager;

    /// 触碰全局授权集合的测试串行执行：并行测试共享进程级集合，清空/
    /// 恢复操作会互相踩踏。
    static AUTH_TEST_SEQ: Mutex<()> = Mutex::new(());

    #[test]
    fn normalize_unifies_prefixes_and_separators() {
        // 落库归一（normalize_project_path）把 `\` 换 `/`：请求侧永远是
        // 正斜杠形态，登记侧（对话框返回反斜杠）必须归一到同一形态。
        assert_eq!(normalize_external_path(r"\\?\C:\a\b.png"), "C:/a/b.png");
        assert_eq!(
            normalize_external_path(r"\\?\UNC\server\share\a.png"),
            "//server/share/a.png"
        );
        assert_eq!(normalize_external_path(r"C:\a\b.png"), "C:/a/b.png");
        assert_eq!(normalize_external_path("C:/a/b.png"), "C:/a/b.png");
        assert_eq!(normalize_external_path("  C:\\a\\b.png  "), "C:/a/b.png");
    }

    /// 盘选/拖入的外部媒体授权：登记即时生效并落库；模拟重启（运行时
    /// 清单清空）后从 settings 恢复，预览不再 404。对话框反斜杠、verbatim
    /// 前缀、落库正斜杠三种形态在归一后互相命中。
    #[test]
    fn authorization_persists_across_restart() {
        let _seq = AUTH_TEST_SEQ.lock().unwrap();
        let app = tauri::test::mock_app();
        {
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            conn.execute(
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )
            .unwrap();
            app.manage(DbState {
                conn: std::sync::Mutex::new(conn),
            });
        }

        let picked = r"C:\Users\someone\Pictures\盘选图.png";
        authorize_external_file(app.handle(), picked);
        // 反斜杠（对话框原样）、verbatim 前缀、正斜杠（落库回读）都命中。
        assert!(is_authorized_external_path(std::path::Path::new(picked)));
        assert!(is_authorized_external_path(std::path::Path::new(
            r"\\?\C:\Users\someone\Pictures\盘选图.png"
        )));
        assert!(is_authorized_external_path(std::path::Path::new(
            "C:/Users/someone/Pictures/盘选图.png"
        )));
        let stored = get_setting_sync(app.handle(), "canvas_authorized_media")
            .unwrap_or_default();
        assert!(stored.contains("盘选图.png"), "授权应落库: {stored}");

        // 模拟重启：内存清单随进程消失，settings 恢复后重新放行。
        *AUTHORIZED_EXTERNAL_FILES.lock().unwrap() = None;
        assert!(!is_authorized_external_path(std::path::Path::new(picked)));
        restore_authorized_external_files(app.handle());
        assert!(is_authorized_external_path(std::path::Path::new(picked)));

        // 重复登记同一文件不产生重复条目。
        authorize_external_file(app.handle(), picked);
        let stored = get_setting_sync(app.handle(), "canvas_authorized_media")
            .unwrap_or_default();
        let list: Vec<String> = serde_json::from_str(&stored).unwrap();
        assert_eq!(list.len(), 1);
    }

    /// 端到端：磁盘选片的真实形态全链路——对话框返回反斜杠路径授权 →
    /// 落库经 normalize_project_path 存正斜杠 → 前端以正斜杠路径构造
    /// 媒体 URL → 服务放行返回完整字节。此前的失配正是盘选预览 404
    /// 的真根因（授权存反斜杠、请求带正斜杠）。
    #[test]
    fn serves_authorized_external_file_picked_via_dialog() {
        let _seq = AUTH_TEST_SEQ.lock().unwrap();
        let app = tauri::test::mock_app();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        app.manage(DbState { conn: Mutex::new(conn) });

        // 管理目录之外的「用户文件」。
        let dir = std::env::temp_dir().join(format!(
            "copy-creator-ext-media-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let png_bytes: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let picked = dir.join("盘选图.png");
        std::fs::write(&picked, png_bytes).unwrap();

        // ① 对话框形态登记（反斜杠）。
        authorize_external_file(app.handle(), picked.to_string_lossy().as_ref());
        // ② 落库形态（normalize_project_path → 正斜杠）也必须命中。
        let stored_form = picked.to_string_lossy().replace('\\', "/");
        assert!(is_authorized_external_path(std::path::Path::new(&stored_form)));

        spawn(app.handle());
        let (origin, token) = {
            let state = app.state::<MediaServerState>();
            (state.origin.clone(), state.token.clone())
        };
        // ③ 前端 URL：正斜杠路径 + encodeURIComponent 语义。
        let (status, _, body) = http_get(
            &origin,
            &format!(
                "/media?token={}&path={}",
                encode_query_value(&token),
                encode_query_value(&stored_form)
            ),
        );
        assert_eq!(status, 200, "盘选文件必须可预览");
        assert_eq!(body, png_bytes);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 启动自愈：旧版本盘选的节点（授权从未落库且形态失配）重启后由
    /// 节点引用扫描补登记，预览恢复，无需逐个重选。
    #[test]
    fn startup_scan_heals_canvas_referenced_files() {
        let _seq = AUTH_TEST_SEQ.lock().unwrap();
        let app = tauri::test::mock_app();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        app.manage(DbState { conn: Mutex::new(conn) });

        let dir = std::env::temp_dir().join(format!(
            "copy-creator-heal-media-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let healed = dir.join("旧盘选.png");
        std::fs::write(&healed, b"png").unwrap();

        // 模拟旧数据：节点行引用该文件（落库正斜杠形态），授权清单为空。
        {
            let handle = app.handle();
            let state = handle.state::<DbState>();
            let conn = state.conn.lock().unwrap();
            let stored = healed.to_string_lossy().replace('\\', "/");
            conn.execute(
                "INSERT INTO canvases (id, name, viewport_x, viewport_y, viewport_k, groups, created_at, updated_at)
                 VALUES ('c1', '画布', 0, 0, 1, '[]', '2026-01-01', '2026-01-01')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO canvas_nodes (id, canvas_id, type, title, pos_x, pos_y, width, height, metadata, resource_path, created_at, updated_at)
                 VALUES ('n1', 'c1', 'load_image', '', 0, 0, NULL, NULL, '{}', ?1, '2026-01-01', '2026-01-01')",
                rusqlite::params![stored],
            )
            .unwrap();
        }

        let refs = canvas_referenced_media_paths(app.handle());
        assert_eq!(refs.len(), 1);
        *AUTHORIZED_EXTERNAL_FILES.lock().unwrap() = None;
        authorize_canvas_referenced_files(app.handle());
        assert!(
            is_authorized_external_path(std::path::Path::new(&healed)),
            "节点引用的外部文件应被自愈授权"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
