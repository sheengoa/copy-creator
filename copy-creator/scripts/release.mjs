// Copy Creator 发布脚本（E9）：一步完成版本同步 + CHANGELOG 草稿 + 提交 + 打 tag。
//
// 用法：node scripts/release.mjs <版本号>
//   例：node scripts/release.mjs 0.4.0
//
// 步骤：
//   1. 校验版本号格式与工作区干净；
//   2. 同步四处版本：package.json / tauri.conf.json / Cargo.toml / Cargo.lock；
//   3. 自上个 tag 的提交记录生成 CHANGELOG.md 草稿段落（人工润色后可再改）；
//   4. 提交「工程：发布 X.Y.Z，统一四处版本号」并打 vX.Y.Z 标签。
//
// 后续动作（脚本不做，需人工）：git push --follow-tags，由 build.yml 产出
// 安装包；updater 签名需要 TAURI_SIGNING_PRIVATE_KEY，接入后另行补充。
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// CHANGELOG.md 在仓库根（copy-creator/ 的上一级）。
const repoRoot = join(root, "..");
const run = (cmd, cwd = root) => execSync(cmd, { cwd, encoding: "utf8" }).trim();

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法：node scripts/release.mjs <版本号>（如 0.4.0）");
  process.exit(1);
}

if (run("git status --porcelain")) {
  console.error("工作区不干净，先提交或暂存所有改动再发布。");
  process.exit(1);
}

const packageJsonPath = join(root, "package.json");
const { version: current } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (version === current) {
  console.error(`版本号与当前相同（${current}），请递增。`);
  process.exit(1);
}

// 1. 同步四处版本号。
const write = (path, text) => writeFileSync(join(root, path), text, "utf8");

const packageJson = readFileSync(packageJsonPath, "utf8");
write("package.json", packageJson.replace(/"version": "[^"]+"/, `"version": "${version}"`));

const tauriConf = readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8");
write("src-tauri/tauri.conf.json", tauriConf.replace(/"version": "[^"]+"/, `"version": "${version}"`));

const cargoToml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
write(
  "src-tauri/Cargo.toml",
  cargoToml.replace(/^version = "[^"]+"/m, `version = "${version}"`),
);

const cargoLock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
const lockUpdated = cargoLock.replace(
  /(\[\[package\]\]\nname = "copy-creator"\nversion = ")[^"]+(")/,
  `$1${version}$2`,
);
if (lockUpdated === cargoLock) {
  console.error("Cargo.lock 中未找到 copy-creator 包条目。");
  process.exit(1);
}
write("src-tauri/Cargo.lock", lockUpdated);

// 2. CHANGELOG 草稿：上个 tag 以来的提交按类型归组。
const lastTag = run("git describe --tags --abbrev=0");
const subjects = run(`git log ${lastTag}..HEAD --pretty=format:%s`).split("\n").reverse();
const groups = { 功能: [], 修复: [], 重构: [], 工程: [], 文档: [], 其他: [] };
for (const subject of subjects) {
  const match = subject.match(/^(功能|修复|重构|工程|文档)：(.*)$/);
  const group = match ? match[1] : "其他";
  (groups[group] || groups["其他"]).push(match ? match[2] : subject);
}
const today = new Date().toISOString().slice(0, 10);
const sectionLines = [
  `## [${version}] - ${today}`,
  "",
  ...Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .flatMap(([group, items]) => [
      `### ${group}`,
      ...items.map((item) => `- ${item}`),
      "",
    ]),
];
const changelogPath = join(repoRoot, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const headerEnd = changelog.indexOf("<!-- 新版本插入位置 -->");
if (headerEnd === -1) {
  console.error("CHANGELOG.md 缺少插入位置标记，请检查文件结构。");
  process.exit(1);
}
writeFileSync(
  changelogPath,
  changelog.slice(0, headerEnd) +
    "<!-- 新版本插入位置 -->\n\n" +
    sectionLines.join("\n") +
    changelog.slice(headerEnd + "<!-- 新版本插入位置 -->".length),
);

// 3. 提交 + 打 tag。
run(`git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock ../CHANGELOG.md`);
run(`git commit -m "工程：发布 ${version}，统一四处版本号"`);
run(`git tag v${version}`);

console.log(`已发布 ${version}（自 ${lastTag}）：
  - 四处版本号已同步
  - CHANGELOG.md 已插入 ${sectionLines.filter((l) => l).length - 3} 条变更草稿（请人工润色后 amend）
  - 已提交并打标签 v${version}
后续：git push --follow-tags 触发构建；产物由 build.yml 产出。`);
