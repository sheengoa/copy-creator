//! 媒体类型判定唯一模块（全 Rust 侧事实源）。
//! 扩展名清单引用生成物 `media_types_generated.rs`（由
//! scripts/generate-media-types.mjs 从 config/media-types.json 生成）；
//! 本模块只承载判定逻辑，禁止手写扩展名字面量（架构守卫规则 8）。
use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;

use crate::media_types_generated::{
    AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, IMPORTABLE_IMAGE_EXTENSIONS,
    PREVIEWABLE_IMAGE_EXTENSIONS, TEXT_EXTENSIONS, VIDEO_EXTENSIONS,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    Text,
    File,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
            MediaKind::Audio => "audio",
            MediaKind::Text => "text",
            MediaKind::File => "file",
        }
    }
}

/// 统一判定顺序：image → video → audio → 嗅探 → text（与前端 domain/mediaKind
/// 一致；清单互斥，顺序仅影响可读性）。扩展名全部未命中时按文件头魔数
/// 嗅探音视频兜底——「.mp4」这类无主名文件与无扩展名视频，Windows 按
/// 内容可正常播放，用户要求「文件管理器可见可播放就必须可预览可用」，
/// 判成 File 会失去视频预览与播放能力。
pub fn media_kind_for_path(path: &Path) -> MediaKind {
    if extension_matches(path, IMAGE_EXTENSIONS) {
        return MediaKind::Image;
    }
    if extension_matches(path, VIDEO_EXTENSIONS) {
        return MediaKind::Video;
    }
    if extension_matches(path, AUDIO_EXTENSIONS) {
        return MediaKind::Audio;
    }
    if let Some(kind) = sniff_media_kind(path) {
        return kind;
    }
    if extension_matches(path, TEXT_EXTENSIONS) || is_probably_text_file(path) {
        return MediaKind::Text;
    }
    MediaKind::File
}

fn extension_matches(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| list.contains(&extension.to_ascii_lowercase().as_str()))
}

pub fn is_text_extension(path: &Path) -> bool {
    extension_matches(path, TEXT_EXTENSIONS)
}

/// 扩展名级别的音视频判定（扫描/监听热路径专用，零 IO）：点前缀目录的
/// 放行判定按此口径——无扩展名文件不进（嗅探只在列表组装的返回页做，
/// 收录判定读文件头会让大库每次扫描都付出数千次 IO）。
pub fn is_audio_or_video_extension(path: &Path) -> bool {
    extension_matches(path, VIDEO_EXTENSIONS) || extension_matches(path, AUDIO_EXTENSIONS)
}

/// 剪贴板预览导入子集（jpg/jpeg/png）：复制图片文件时仅该子集导入为图片记录。
pub fn is_previewable_image_file(path: &Path) -> bool {
    extension_matches(path, PREVIEWABLE_IMAGE_EXTENSIONS)
}

/// 剪贴板导入为图片记录的完整集（png/jpg/jpeg/gif/bmp/webp/ico）。
pub fn is_importable_image_file(path: &Path) -> bool {
    extension_matches(path, IMPORTABLE_IMAGE_EXTENSIONS)
}

/// 内容嗅探：空文件以外的 UTF-8 无 NUL 字节文件视作文本（供无扩展名文件兜底）。
pub fn is_probably_text_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        return false;
    }

    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut sample = [0_u8; 8192];
    let Ok(bytes_read) = file.read(&mut sample) else {
        return false;
    };
    bytes_read > 0
        && !sample[..bytes_read].contains(&0)
        && std::str::from_utf8(&sample[..bytes_read]).is_ok()
}

/// 音视频魔数嗅探（扩展名未命中清单时的兜底）：读文件头判定主流容器
/// 格式。判定从紧——只认高置信魔数，裸流（如无同步帧校验的 MPEG-TS、
/// 无 ID3 的裸 MP3）不判，宁缺勿滥，避免把任意二进制误判成媒体。
pub fn sniff_media_kind(path: &Path) -> Option<MediaKind> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return None;
    };
    let mut head = [0_u8; 12];
    let Ok(bytes_read) = file.read(&mut head) else {
        return None;
    };
    let head = &head[..bytes_read];
    if head.len() < 12 {
        return None;
    }
    // MP4/M4V/MOV 家族：offset 4 起的 "ftyp" 品牌框。
    if &head[4..8] == b"ftyp" {
        return Some(MediaKind::Video);
    }
    // WebM/MKV 家族：EBML 魔数。
    if head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return Some(MediaKind::Video);
    }
    // RIFF 容器按子标识细分：AVI 视频与 WAV 音频。
    if &head[..4] == b"RIFF" {
        if &head[8..12] == b"AVI " {
            return Some(MediaKind::Video);
        }
        if &head[8..12] == b"WAVE" {
            return Some(MediaKind::Audio);
        }
        return None;
    }
    // Ogg 容器：OggS 页头（ogv 视频 / ogg·oga·opus 音频统一归视频清单
    // 已覆盖扩展名侧，这里按视频兜底与清单归属一致）。
    if &head[..4] == b"OggS" {
        return Some(MediaKind::Video);
    }
    // MP3 带 ID3 头。
    if &head[..3] == b"ID3" {
        return Some(MediaKind::Audio);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_lists_drive_media_kind_for_path() {
        // 生成清单 → 判定函数的联结锁定：每个清单的每项扩展名都必须
        // 映射到对应 MediaKind（防止生成物与逻辑重构后联结断裂）。
        for ext in IMAGE_EXTENSIONS {
            assert_eq!(media_kind_for_path(Path::new(&format!("a.{ext}"))), MediaKind::Image);
        }
        for ext in VIDEO_EXTENSIONS {
            assert_eq!(media_kind_for_path(Path::new(&format!("a.{ext}"))), MediaKind::Video);
        }
        for ext in AUDIO_EXTENSIONS {
            assert_eq!(media_kind_for_path(Path::new(&format!("a.{ext}"))), MediaKind::Audio);
        }
        for ext in TEXT_EXTENSIONS {
            assert_eq!(
                media_kind_for_path(Path::new(&format!("a.{ext}"))),
                MediaKind::Text,
                "扩展名 {ext} 被更靠前的清单命中（判定顺序或清单互斥被破坏）"
            );
        }
    }

    #[test]
    fn unknown_extensions_fall_back_to_file_kind() {
        assert_eq!(media_kind_for_path(Path::new("a.unknownext")), MediaKind::File);
    }

    #[test]
    fn previewable_and_importable_subsets_match_original_semantics() {
        assert!(is_previewable_image_file(Path::new("a.JPG")));
        assert!(is_previewable_image_file(Path::new("b.jpeg")));
        assert!(is_previewable_image_file(Path::new("c.png")));
        assert!(!is_previewable_image_file(Path::new("d.gif")));

        assert!(is_importable_image_file(Path::new("a.webp")));
        assert!(is_importable_image_file(Path::new("b.ICO")));
        assert!(!is_importable_image_file(Path::new("c.svg")));
    }

    #[test]
    fn video_list_owns_ts_after_resolution() {
        // ts 归属裁决（2026-09-12）：MPEG-TS 媒体语义优先，两侧清单统一为 video。
        assert_eq!(media_kind_for_path(Path::new("a.ts")), MediaKind::Video);
    }

    #[test]
    fn sniff_recovers_media_kind_for_extensionless_files() {
        // 用户要求：文件管理器可见且系统可播放的媒体必须可预览可用。
        // 无扩展名与「.mp4」无主名文件（Path::extension() 返回 None）按
        // 文件头魔数兜底判定，不再落入 File 失去视频预览。
        let dir = std::env::temp_dir().join(format!("copy-creator-sniff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let mp4 = dir.join("video"); // 无扩展名
        std::fs::write(&mp4, b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41pad").unwrap();
        assert_eq!(media_kind_for_path(&mp4), MediaKind::Video);

        let dot_mp4 = dir.join(".mp4"); // 无主名
        std::fs::write(&dot_mp4, b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41pad").unwrap();
        assert_eq!(media_kind_for_path(&dot_mp4), MediaKind::Video);

        let mkv = dir.join("movie.bin"); // 清单外扩展名 + EBML
        std::fs::write(&mkv, [0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4, 5, 6, 7, 8]).unwrap();
        assert_eq!(media_kind_for_path(&mkv), MediaKind::Video);

        let wav = dir.join("audio.bin"); // RIFF/WAVE
        std::fs::write(&wav, b"RIFF\x24\x00\x00\x00WAVEfmt ").unwrap();
        assert_eq!(media_kind_for_path(&wav), MediaKind::Audio);

        let avi = dir.join("clip.dat"); // RIFF/AVI
        std::fs::write(&avi, b"RIFF\x24\x00\x00\x00AVI LIST").unwrap();
        assert_eq!(media_kind_for_path(&avi), MediaKind::Video);

        let binary = dir.join("data.bin"); // 非媒体二进制不误判
        std::fs::write(&binary, [0x50, 0x4B, 0x03, 0x04, 0, 1, 2, 3, 4, 5, 6, 7]).unwrap();
        assert_eq!(media_kind_for_path(&binary), MediaKind::File);

        let tiny = dir.join("tiny"); // 长度不足 12 字节不判
        std::fs::write(&tiny, b"\x00\x00").unwrap();
        assert_eq!(media_kind_for_path(&tiny), MediaKind::File);

        std::fs::remove_dir_all(&dir).ok();
    }
}
