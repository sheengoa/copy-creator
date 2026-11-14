// Copy Creator 发布脚本（E9）：一条命令完成「发布前校验 → 四处版本同步 +
// CHANGELOG 草稿 → 提交 + 打 tag → 推送 → 盯 GitHub 构建到出结果」。
//
// 用法：
//   pnpm release <版本号>            全流程发布，例：pnpm release 0.4.0
//   pnpm release --check             只跑发布前校验，不改动任何文件
//   pnpm release --repair [版本号]   构建失败后的修复：把该版本 tag 强制移到
//                                    当前 HEAD 重新触发（版本号缺省取 package.json）
// 选项：
//   --no-push   完成提交与 tag 后即停，不推送（沿用手工推送流程）
//   --no-watch  推送后不盯构建，打印 Actions 链接即退
//   --force     跳过 CI 绿灯校验（应急；build.yml 的 gate 仍兜底）
//
// 发布前校验（三种模式共用，任一失败即中止并给指引）：
//   工作区干净 / 在 main 分支 / 与 origin/main 同步 / tag 未被占用 /
//   HEAD 的 CI 已绿。绿灯校验经 gh 查询：gh 不可用降级为警告继续，
//   查到红灯或还在跑则中止——0.3.25 就是顶着红灯打 tag 白等了一场 gate。
//
// 推送用显式的 main + tag 两条命令：脚本打的是轻量 tag，git push
// --follow-tags 只推附注 tag 推不动它，历史上靠手工补推——此处一并修掉。
//
// 构建产物由 build.yml 产出（deb/AppImage/exe/msi）；更新产物（latest.json）
// 需在 GitHub Secrets 配置 TAURI_SIGNING_PRIVATE_KEY（及可选
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD），公钥见 tauri.conf.json 的
// plugins.updater.pubkey。
import { readFileSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// CHANGELOG.md 在仓库根（copy-creator/ 的上一级）。
const repoRoot = join(root, "..");
const run = (cmd, cwd = root) => execSync(cmd, { cwd, encoding: "utf8" }).trim();
// 前台直播执行（push / gh run watch 等 want 实时输出的命令）。
const runLive = (args, cwd = root) => spawnSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
// 同步毫秒级等待（零依赖）：Atomics.wait 阻塞当前线程。
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// gh api 查询。返回 null = gh 不可用（未装/未登录/网络），调用方决定降级策略。
const ghJson = (path) => {
  const r = spawnSync("gh", ["api", path], { cwd: root, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

// ---- 参数解析 ----
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const OPT = {
  push: !flags.has("--no-push"),
  watch: !flags.has("--no-watch"),
  force: flags.has("--force"),
};
const isCheck = flags.has("--check");
const isRepair = flags.has("--repair");
function usage() {
  console.error(`用法：
  pnpm release <版本号>            全流程发布（校验→同步版本→提交→tag→推送→盯构建）
  pnpm release --check             只跑发布前校验，不改动任何文件
  pnpm release --repair [版本号]   构建失败后修复：tag 强制移到当前 HEAD 重新触发
选项：--no-push 完成 tag 后即停 / --no-watch 推送后不盯构建 / --force 跳过 CI 校验`);
  process.exit(1);
}
const KNOWN_FLAGS = new Set(["--check", "--repair", "--no-push", "--no-watch", "--force"]);
const unknownFlags = [...flags].filter((f) => !KNOWN_FLAGS.has(f));
if (unknownFlags.length) {
  console.error(`未知选项：${unknownFlags.join(" ")}`);
  usage();
}
if (isCheck && isRepair) {
  console.error("--check 与 --repair 不能同时使用。");
  process.exit(1);
}
if (positional.length > 1) usage();

const packageJsonPath = join(root, "package.json");
const { version: currentVersion } = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// 版本号：release 必填；repair 缺省取当前版本（修复场景版本不会变）；check 可选。
const versionInput = positional[0];
if (!isCheck && !isRepair && !versionInput) usage();
if (versionInput && !/^\d+\.\d+\.\d+$/.test(versionInput)) {
  console.error(`版本号格式不对：${versionInput}（应为 X.Y.Z，如 0.4.0）`);
  process.exit(1);
}
const version = isRepair ? versionInput ?? currentVersion : versionInput;
if (!isCheck && !isRepair && version === currentVersion) {
  console.error(`版本号与当前相同（${currentVersion}），请递增。`);
  process.exit(1);
}

// gh api 需要 owner/repo：从 origin 远端地址解析（https 与 ssh 两种形态）。
const remoteUrl = run("git remote get-url origin");
const slugMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/);
if (!slugMatch) {
  console.error(`无法从远端地址解析 GitHub 仓库：${remoteUrl}`);
  process.exit(1);
}
const repoSlug = `${slugMatch[1]}/${slugMatch[2]}`;

// ---- 发布前校验 ----
// 逐项即时打印 ✅/⚠️/❌，返回失败项数。version 为 null 时跳过版本相关项。
function preflight({ requireTagAbsent = true } = {}) {
  const problems = [];
  const report = (ok, label, detail = "") => {
    console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `——${detail}` : ""}`);
    if (!ok) problems.push(label);
  };

  report(!run("git status --porcelain"), "工作区干净", "有未提交改动，先提交或暂存");
  report(run("git branch --show-current") === "main", "当前在 main 分支");

  // 本地三件套（lint/typecheck/vitest）：CI 绿灯兜远端，这里兜本地——
  // --force 跳过 CI 校验、或 HEAD 刚推送 CI 尚未跑完的窗口期，发布不裸奔。
  // 顺序失败即中止（首项红了后面项无意义）；失败输出原样透传便于定位。
  for (const [cmd, label] of [
    ["pnpm lint", "lint"],
    ["pnpm typecheck", "typecheck"],
    ["pnpm test", "vitest"],
  ]) {
    let failed = null;
    try {
      execSync(cmd, { cwd: root, stdio: "pipe" });
    } catch (error) {
      failed = error;
    }
    if (failed) {
      if (failed.stdout) process.stdout.write(String(failed.stdout));
      if (failed.stderr) process.stderr.write(String(failed.stderr));
    }
    report(!failed, `本地 ${label}`, failed ? `失败——${cmd}` : "");
    if (failed) return problems;
  }

  // 与 origin/main 同步（fetch 失败视作离线，降级为跳过，推送阶段自然会拦）。
  try {
    run("git fetch origin main");
  } catch {
    /* 离线等场景 */
  }
  const head = run("git rev-parse HEAD");
  const originMain = run("git rev-parse origin/main");
  if (head === originMain) {
    report(true, "与 origin/main 同步");
  } else {
    const behind = Number(run("git rev-list --count HEAD..origin/main"));
    const ahead = Number(run("git rev-list --count origin/main..HEAD"));
    report(
      false,
      "与 origin/main 同步",
      behind > 0
        ? `本地落后 ${behind} 个提交，先 git pull`
        : `本地领先 ${ahead} 个提交——先 git push 并等 CI 跑绿再发布`,
    );
  }

  if (version && requireTagAbsent) {
    const localTag = (() => {
      try {
        return run(`git rev-parse -q --verify refs/tags/v${version}`);
      } catch {
        return "";
      }
    })();
    const remoteTag = run(`git ls-remote --tags origin refs/tags/v${version}`);
    const tagFree = !localTag && !remoteTag;
    report(tagFree, `tag v${version} 未被占用`, tagFree ? "" : localTag ? "本地已存在" : "远端已存在");
  }

  // CI 绿灯守卫：只有 --force 可跳过；gh 不可用降级为警告（gate 兜底）。
  if (OPT.force) {
    console.log("⏭️ CI 绿灯校验已跳过（--force）");
  } else {
    const ci = checkCiGreen(head);
    if (ci.warn) console.log(`⚠️ ${ci.detail}`);
    else report(ci.ok, "HEAD 的 CI 已绿", ci.detail);
  }
  return problems;
}

function checkCiGreen(sha) {
  const data = ghJson(`repos/${repoSlug}/actions/runs?head_sha=${sha}&per_page=100`);
  if (!data) {
    return { warn: true, detail: "gh 不可用，无法校验 CI 状态（build.yml 的 gate 会兜底）" };
  }
  const ciRuns = (data.workflow_runs ?? []).filter((r) => r.name === "CI" && r.head_branch === "main");
  if (ciRuns.length === 0) {
    return { ok: false, detail: "查不到该提交的 CI 记录——推送后稍等片刻再发（或 --force）" };
  }
  if (ciRuns.some((r) => r.status !== "completed")) {
    return { ok: false, detail: "CI 还在跑，等几分钟再发布" };
  }
  if (ciRuns.some((r) => r.conclusion !== "success")) {
    return { ok: false, detail: "CI 是红的，先修复再发布" };
  }
  return { ok: true, detail: "" };
}

// ---- 盯构建 ----
// 轮询等待 tag 触发的 Build run 出现（约 60s），找到后前台直播到结束。
// 必须按 head_sha 对准本次 tag 指向的提交：repair 移过 tag 的分支名上
// 还挂着上一轮失败 run，只按分支名找会盯到陈年尸体（0.3.26 实翻车）。
function watchBuild(version, headSha) {
  const branch = `v${version}`;
  let buildRun = null;
  for (let i = 0; i < 12; i++) {
    const data = ghJson(`repos/${repoSlug}/actions/runs?event=push&per_page=20`);
    buildRun =
      (data?.workflow_runs ?? []).find(
        (r) => r.name === "Build" && r.head_branch === branch && r.head_sha === headSha,
      ) ?? null;
    if (buildRun) break;
    sleep(5000);
  }
  const actionsUrl = `https://github.com/${repoSlug}/actions/workflows/build.yml`;
  if (!buildRun) {
    console.error(`60 秒内未等到 Build run 启动，稍后自行查看：${actionsUrl}`);
    process.exit(1);
  }
  const runUrl = `https://github.com/${repoSlug}/actions/runs/${buildRun.id}`;
  console.log(`Build run #${buildRun.run_number} 已启动，盯守中（Ctrl+C 退出不影响云端构建）…`);
  const watch = runLive(["gh", "run", "watch", String(buildRun.id), "--exit-status", "--interval", "30"]);
  if (watch.status === 0) {
    const rel = ghJson(`repos/${repoSlug}/releases/tags/v${version}`);
    console.log(`\n🎉 v${version} 构建发布成功${rel?.html_url ? `：${rel.html_url}` : ""}`);
    console.log("CHANGELOG 草稿已生成，润色后补交即可（不影响已发产物）。");
    process.exit(0);
  }
  if (watch.signal) {
    console.log(`\n已退出盯守，云端构建仍在继续：${runUrl}`);
    process.exit(0);
  }
  const jobs = ghJson(`repos/${repoSlug}/actions/runs/${buildRun.id}/jobs`);
  const failedJobs = (jobs?.jobs ?? []).filter((j) => j.conclusion === "failed").map((j) => j.name);
  console.error(`\n❌ 构建失败${failedJobs.length ? `：${failedJobs.join("、")}` : `：${runUrl}`}
修复并推送后运行：pnpm release --repair ${version}（把 v${version} 移到当前 HEAD 重新触发）`);
  process.exit(1);
}

// ---- 模式分支 ----
if (isCheck) {
  const problems = preflight({ requireTagAbsent: !!version });
  if (problems.length) {
    console.error(`\n${problems.length} 项未通过，先解决再发布。`);
    process.exit(1);
  }
  console.log("\n全部通过，可以发布：pnpm release <版本号>");
  process.exit(0);
}

if (isRepair) {
  // 防呆：该版本已有带产物的 Release 时移 tag 会造出孤儿 Release——拒绝。
  // （gh 不可用时跳过此守卫，按无 Release 处理。）
  const rel = ghJson(`repos/${repoSlug}/releases/tags/v${version}`);
  if (rel?.assets?.length) {
    console.error(`v${version} 已有 Release 且带 ${rel.assets.length} 个产物——移动 tag 会造成孤儿 Release，请改发新版本号。`);
    process.exit(1);
  }
  if (rel) console.log(`⚠️ v${version} 已存在空 Release 壳（0 产物），tag 移动后构建会复用它。`);

  const problems = preflight({ requireTagAbsent: false });
  if (problems.length) {
    console.error(`\n${problems.length} 项未通过，先解决再修复。`);
    process.exit(1);
  }
  run(`git tag -f v${version} HEAD`);
  console.log(`已把 tag v${version} 强制移到 HEAD，推送…`);
  const tagPush = runLive(["git", "push", "--force", "origin", `v${version}`]);
  if (tagPush.status !== 0) {
    console.error("tag 推送失败——检查网络后重跑 pnpm release --repair。");
    process.exit(1);
  }
  if (OPT.watch) watchBuild(version, run("git rev-parse HEAD"));
  console.log(`已推送 v${version}，构建进度：https://github.com/${repoSlug}/actions/workflows/build.yml`);
  process.exit(0);
}

// ---- 正式发布流程 ----
// 0. 发布前校验：任何一项不过都不动文件。
const preflightProblems = preflight({ requireTagAbsent: !!version });
if (preflightProblems.length) {
  console.error(`\n${preflightProblems.length} 项未通过，已中止——文件未被改动。`);
  process.exit(1);
}

// 1. 四处版本号同步。
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
// 行尾兼容：Windows 检出为 CRLF 时 \n 单独匹配不到条目，用 \r?\n 兼容两种检出。
const lockUpdated = cargoLock.replace(
  /(\[\[package\]\]\r?\nname = "copy-creator"\r?\nversion = ")[^"]+(")/,
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
console.log(`已同步四处版本号并生成 CHANGELOG 草稿（自 ${lastTag}，${sectionLines.filter((l) => l).length - 3} 条），提交并打标签 v${version}。`);

// 4. 推送：main 先行，tag 单独推（轻量 tag 不被 push --follow-tags 覆盖）。
if (!OPT.push) {
  console.log(`到此为止（--no-push）。后续手动推送：
  git push origin main && git push origin v${version}`);
  process.exit(0);
}
console.log("推送 main…");
const mainPush = runLive(["git", "push", "origin", "main"]);
if (mainPush.status !== 0) {
  console.error("main 推送失败（多为远端有新提交被拒）——git pull --rebase 后重跑。tag 未推送，不会触发构建。");
  process.exit(1);
}
console.log(`推送 tag v${version}…`);
const tagPush = runLive(["git", "push", "origin", `v${version}`]);
if (tagPush.status !== 0) {
  console.error(`tag 推送失败——网络恢复后手动执行：git push origin v${version}`);
  process.exit(1);
}

// 5. 盯构建到出结果。
if (!OPT.watch) {
  console.log(`已推送。构建进度：https://github.com/${repoSlug}/actions/workflows/build.yml`);
  process.exit(0);
}
watchBuild(version, run("git rev-parse HEAD"));
