//! 资源库目录监听：外部（文件管理器等）对资源库的增删改经防抖后发出
//! `resource-groups-changed`，资源页与径向菜单已有的监听会自动重新扫描，
//! 让「内容即文件」的外部变更实时反映到界面。
//!
//! 监听目录通过周期性调用 `db::get_resource_library_dir` 解析，用户切换
//! 资源库路径、迁移存储位置等所有变更途径都会被跟进；监听失败按退避
//! 间隔重试。应用自身对资源库的写入同样会触发事件，但刷新是幂等重扫，
//! 且与自身操作发出的事件在防抖窗口内合并，不会形成反馈循环。

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Runtime};

use crate::db;

/// 变更防抖窗口：文件管理器常把一次操作拆成多个事件，窗口内的变更
/// 合并为一次刷新。
const DEBOUNCE: Duration = Duration::from_millis(500);
/// 事件汇聚循环的轮询间隔。
const TICK: Duration = Duration::from_millis(200);
/// 资源库目录的重新解析间隔（路径切换、存储迁移都靠它跟进）。
const RESOLVE_INTERVAL: Duration = Duration::from_secs(2);
/// 监听建立失败后的重试间隔，避免对失效路径每两秒刷一遍告警日志。
const RETRY_INTERVAL: Duration = Duration::from_secs(10);

pub fn spawn<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || watch_loop(app));
}

fn watch_loop<R: Runtime>(app: AppHandle<R>) {
    let (event_tx, event_rx) = mpsc::channel::<()>();
    // 常驻发送端：重建 watcher 时把克隆交给回调，保证 event_rx 永不断开。
    let keeper = event_tx.clone();
    drop(event_tx);

    let mut watcher: Option<RecommendedWatcher> = None;
    let mut watched_path: Option<PathBuf> = None;
    let mut watch_failed = false;
    let mut last_event: Option<Instant> = None;
    let mut next_resolve = Instant::now();

    loop {
        // 跟进资源库目录变化（含首次解析）。
        if next_resolve <= Instant::now() {
            next_resolve = Instant::now() + RESOLVE_INTERVAL;
            let current = db::get_resource_library_dir(&app);
            if watch_failed || watched_path.as_deref() != Some(current.as_path()) {
                watch_failed = false;
                watched_path = Some(current.clone());
                drop(watcher.take());
                match build_watcher(&keeper) {
                    Ok(new_watcher) => {
                        let mut new_watcher = new_watcher;
                        match new_watcher.watch(&current, RecursiveMode::Recursive) {
                            Ok(()) => {
                                log::info!("资源库目录监听已启动: {}", current.display());
                                watcher.replace(new_watcher);
                            }
                            Err(error) => {
                                log::warn!(
                                    "资源库目录监听失败 {}: {error}",
                                    current.display()
                                );
                                watch_failed = true;
                            }
                        }
                    }
                    Err(error) => {
                        log::warn!("创建资源库目录监听器失败: {error}");
                        watch_failed = true;
                    }
                }
                if watch_failed {
                    next_resolve = Instant::now() + RETRY_INTERVAL;
                }
            }
        }

        // 汇聚监听事件，防抖后发一次刷新。
        let mut saw_event = false;
        while event_rx.try_recv().is_ok() {
            saw_event = true;
        }
        if saw_event {
            last_event = Some(Instant::now());
        }
        if let Some(at) = last_event {
            if at.elapsed() >= DEBOUNCE {
                last_event = None;
                log::info!("资源库外部变更，通知前端刷新");
                let _ = app.emit("resource-groups-changed", ());
            }
        }

        std::thread::sleep(TICK);
    }
}

fn build_watcher(
    event_tx: &mpsc::Sender<()>,
) -> Result<RecommendedWatcher, notify::Error> {
    notify::recommended_watcher({
        let tx = event_tx.clone();
        move |result: Result<notify::Event, notify::Error>| {
            // 忽略事件内容与具体错误：任何变动都只需触发一次重扫。
            if result.is_ok() {
                let _ = tx.send(());
            }
        }
    })
}
