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
    let mut head = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {content_length}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n"
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

/// 与前端 resolveResourceAssetUrl 相同的语义：绝对路径直接使用，
/// 相对路径拼接到应用存储目录之下。
fn resolve_media_file<R: Runtime>(app: &AppHandle<R>, raw: &str) -> Option<PathBuf> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Some(path.to_path_buf());
    }
    Some(db::get_storage_dir(app).join(value.trim_start_matches(['/', '\\'])))
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
        _ => "application/octet-stream",
    }
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
        let app = tauri::test::mock_app();
        spawn(app.handle());
        let (origin, token) = {
            let state = app.state::<MediaServerState>();
            (state.origin.clone(), state.token.clone())
        };

        let dir: PathBuf = std::env::temp_dir().join(format!(
            "copy-creator-media-server-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
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

        std::fs::remove_dir_all(&dir).ok();
    }
}
