#!/usr/bin/env node
/**
 * 媒体类型清单生成器：从 config/media-types.json（唯一源）生成 TS 与 Rust
 * 两份代码，生成物提交进仓库（不引入构建顺序耦合）。改配置后必须重新运行
 * 本脚本并提交生成物；架构守卫测试会跑一遍生成器与仓库内生成物做 diff，
 * 不同步即红（DOMAIN_ARCHITECTURE_PLAN.md §5.2 规则 7）。
 *
 * 用法：node scripts/generate-media-types.mjs [仓库根目录]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit } from "node:process";

// --check 模式：只比对生成物是否与配置同步，不写文件（架构守卫规则 7 调用）。
const CHECK_ONLY = argv.includes("--check");
const positional = argv.slice(2).filter((a) => !a.startsWith("--"))[0];
const repoRoot = resolve(positional ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const configPath = join(repoRoot, "config", "media-types.json");
const tsOutPath = join(repoRoot, "copy-creator", "src", "domain", "mediaTypes.generated.ts");
const rsOutPath = join(repoRoot, "copy-creator", "src-tauri", "src", "media_types_generated.rs");

// —— 配置严格校验：未知字段、空清单、重复/非法扩展名一律报错退出 ——
// （"$" 前缀键是 JSON 惯例注释位，校验器放行。）
// 互斥规则：核心四清单（image/video/audio/text）之间不得重复；
// previewableImage / importableImage 是 image 的派生子集，越界即错。
const REQUIRED_KEYS = ["image", "video", "audio", "text", "previewableImage", "importableImage"];
const CORE_KEYS = ["image", "video", "audio", "text"];
const DERIVED_KEYS = ["previewableImage", "importableImage"];
const config = JSON.parse(readFileSync(configPath, "utf8"));
const unknownKeys = Object.keys(config).filter(
  (key) => !REQUIRED_KEYS.includes(key) && !key.startsWith("$"),
);
if (unknownKeys.length > 0) {
  console.error(`media-types.json 含未知字段: ${unknownKeys.join(", ")}`);
  process.exit(1);
}
const seen = new Map();
for (const key of REQUIRED_KEYS) {
  const list = config[key];
  if (!Array.isArray(list) || list.length === 0) {
    console.error(`media-types.json.${key} 必须是非空数组`);
    process.exit(1);
  }
  for (const ext of list) {
    if (typeof ext !== "string" || !/^[a-z0-9][a-z0-9]*$/.test(ext)) {
      console.error(`media-types.json.${key} 含非法扩展名: ${JSON.stringify(ext)}`);
      process.exit(1);
    }
    if (CORE_KEYS.includes(key) && seen.has(ext)) {
      console.error(`扩展名 "${ext}" 同时出现在 ${seen.get(ext)} 与 ${key}`);
      process.exit(1);
    }
    if (DERIVED_KEYS.includes(key) && seen.get(ext) !== "image" && seen.has(ext)) {
      console.error(`派生清单 ${key} 含非 image 扩展名: "${ext}"（归属 ${seen.get(ext)}）`);
      process.exit(1);
    }
    if (!seen.has(ext)) seen.set(ext, key);
  }
}

const header = (language) =>
  [
    "// 本文件由 scripts/generate-media-types.mjs 从 config/media-types.json 生成，",
    "// 禁止手写修改（修改会被架构守卫测试的生成物新鲜度校验拦截）。",
    `// 语言：${language}`,
    "",
  ].join("\n");

const tsLines = (name, list) =>
  `export const ${name}: readonly string[] = ${JSON.stringify(list)};`;
const tsBody = [
  header("TypeScript"),
  tsLines("IMAGE_EXTENSIONS", config.image),
  tsLines("VIDEO_EXTENSIONS", config.video),
  tsLines("AUDIO_EXTENSIONS", config.audio),
  tsLines("TEXT_EXTENSIONS", config.text),
  tsLines("PREVIEWABLE_IMAGE_EXTENSIONS", config.previewableImage),
  tsLines("IMPORTABLE_IMAGE_EXTENSIONS", config.importableImage),
  "",
].join("\n");

const rsLines = (name, list) =>
  `pub const ${name}: &[&str] = &[${
    list.map((ext) => JSON.stringify(ext)).join(", ")
  }];`;
const rsBody = [
  header("Rust"),
  rsLines("IMAGE_EXTENSIONS", config.image),
  rsLines("VIDEO_EXTENSIONS", config.video),
  rsLines("AUDIO_EXTENSIONS", config.audio),
  rsLines("TEXT_EXTENSIONS", config.text),
  rsLines("PREVIEWABLE_IMAGE_EXTENSIONS", config.previewableImage),
  rsLines("IMPORTABLE_IMAGE_EXTENSIONS", config.importableImage),
  "",
].join("\n");

mkdirSync(dirname(tsOutPath), { recursive: true });
if (CHECK_ONLY) {
  const tsCurrent = readFileSync(tsOutPath, "utf8");
  const rsCurrent = readFileSync(rsOutPath, "utf8");
  if (tsCurrent !== tsBody || rsCurrent !== rsBody) {
    console.error(
      "生成物与 config/media-types.json 不同步：请运行 node scripts/generate-media-types.mjs 后提交生成物。",
    );
    exit(1);
  }
  console.log("生成物与配置一致。");
  exit(0);
}

mkdirSync(dirname(tsOutPath), { recursive: true });
writeFileSync(tsOutPath, tsBody);
writeFileSync(rsOutPath, rsBody);
console.log(`已生成:\n  ${tsOutPath}\n  ${rsOutPath}`);
