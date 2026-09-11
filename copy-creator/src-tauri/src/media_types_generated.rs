// 本文件由 scripts/generate-media-types.mjs 从 config/media-types.json 生成，
// 禁止手写修改（修改会被架构守卫测试的生成物新鲜度校验拦截）。
// 语言：Rust

pub const IMAGE_EXTENSIONS: &[&str] = &["avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"];
pub const VIDEO_EXTENSIONS: &[&str] = &["avi", "m4v", "mkv", "mov", "mp4", "ogv", "ts", "webm"];
pub const AUDIO_EXTENSIONS: &[&str] = &["aac", "flac", "m4a", "mid", "midi", "mp3", "oga", "ogg", "opus", "wav", "weba"];
pub const TEXT_EXTENSIONS: &[&str] = &["bat", "bash", "c", "cc", "cfg", "clj", "conf", "cpp", "cs", "css", "cxx", "env", "fish", "go", "graphql", "h", "hh", "hpp", "htm", "html", "ini", "java", "js", "json", "jsonl", "jsx", "kt", "kts", "less", "log", "markdown", "md", "mjs", "php", "pl", "properties", "ps1", "py", "rb", "rs", "sass", "scss", "sh", "sql", "svelte", "swift", "tex", "toml", "tsx", "txt", "vue", "xml", "yaml", "yml"];
pub const PREVIEWABLE_IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png"];
pub const IMPORTABLE_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico"];
