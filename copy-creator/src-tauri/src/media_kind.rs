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

/// 统一判定顺序：image → video → audio → text（与前端 domain/mediaKind 一致；
/// 清单互斥，顺序仅影响可读性）。
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
}
