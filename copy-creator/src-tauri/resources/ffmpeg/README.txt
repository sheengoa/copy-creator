视频首帧/尾帧节点的抽帧引擎目录
================================

应用打包时会把本目录整体复制进安装资源（tauri.conf.json → bundle.resources）。
视频抽帧命令按以下顺序解析 ffmpeg 可执行文件：

1. 资源目录 ffmpeg/ 下的 ffmpeg（Windows: ffmpeg.exe，Linux/macOS: ffmpeg）
2. 系统 PATH

因此：

- 开发机：把 ffmpeg 加入 PATH 即可，无需放置本文件。
- 打包发布：请将 ffmpeg 可执行文件放入本目录（建议裁剪构建，只保留
  常见视频容器/解码器 + PNG 输出，可控制在 20~30MB）。可执行文件体积
  大，不纳入 git 版本控制（.gitignore 已忽略 ffmpeg.exe / ffmpeg）。

下载来源（任选其一）：
- Windows: https://www.gyan.dev/ffmpeg/builds/（release-essentials 或更小裁剪版）
- BtbN 自动构建: https://github.com/BtbN/FFmpeg-Builds/releases（ LGPL 版）

本目录除本说明外的内容均不入库。
