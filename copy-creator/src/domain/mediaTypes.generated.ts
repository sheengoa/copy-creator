// 本文件由 scripts/generate-media-types.mjs 从 config/media-types.json 生成，
// 禁止手写修改（修改会被架构守卫测试的生成物新鲜度校验拦截）。
// 语言：TypeScript

export const IMAGE_EXTENSIONS: readonly string[] = ["avif","bmp","gif","heic","heif","ico","jpeg","jpg","png","svg","tif","tiff","webp"];
export const VIDEO_EXTENSIONS: readonly string[] = ["avi","m4v","mkv","mov","mp4","ogv","ts","webm"];
export const AUDIO_EXTENSIONS: readonly string[] = ["aac","flac","m4a","mid","midi","mp3","oga","ogg","opus","wav","weba"];
export const TEXT_EXTENSIONS: readonly string[] = ["bat","bash","c","cc","cfg","clj","conf","cpp","cs","css","cxx","env","fish","go","graphql","h","hh","hpp","htm","html","ini","java","js","json","jsonl","jsx","kt","kts","less","log","markdown","md","mjs","php","pl","properties","ps1","py","rb","rs","sass","scss","sh","sql","svelte","swift","tex","toml","tsx","txt","vue","xml","yaml","yml"];
export const PREVIEWABLE_IMAGE_EXTENSIONS: readonly string[] = ["jpg","jpeg","png"];
export const IMPORTABLE_IMAGE_EXTENSIONS: readonly string[] = ["png","jpg","jpeg","gif","bmp","webp","ico"];
