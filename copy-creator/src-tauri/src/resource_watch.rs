//! 资源库目录监听：外部（文件管理器等）对资源库的增删改经防抖后发出
//! `resource-groups-changed`，资源页与径向菜单已有的监听会自动重新扫描，
//! 让「内容即文件」的外部变更实时反映到界面。
//!
//! 运行期间新出现的文件（从外部移入/复制进来）会按发现时间补建入库记录，
//! 使其在「全部」列表置顶——与刚复制的剪切板内容同待遇；文件管理器的
//! 「移动」保留原修改时间，若只靠扫描合成会按旧时间沉底，因此必须在
//! 监听侧显式补建。应用未运行期间放入的文件不追溯。
//!
//! 监听目录通过周期性调用 `db::get_resource_library_dir` 解析，用户切换
//! 资源库路径、迁移存储位置等所有变更途径都会被跟进；监听失败按退避
//! 间隔重试。应用自身对资源库的写入同样会触发事件，但刷新是幂等重扫，
//! 且与自身操作发出的事件在防抖窗口内合并，不会形成反馈循环。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::event::{EventKind, ModifyKind};
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

/// 监听事件的两种语义：只有「到达」需要按发现时间补建入库记录，
/// 其余变更（删除、内容修改）只需触发前端重扫。
enum WatchSignal {
    Arrived(Vec<PathBuf>),
    Changed,
}

pub fn spawn<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || watch_loop(app));
}

fn watch_loop<R: Runtime>(app: AppHandle<R>) {
    let (event_tx, event_rx) = mpsc::channel::<WatchSignal>();
    // 常驻发送端：重建 watcher 时把克隆交给回调，保证 event_rx 永不断开。
    let keeper = event_tx.clone();
    drop(event_tx);

    let mut watcher: Option<RecommendedWatcher> = None;
    let mut watched_path: Option<PathBuf> = None;
    let mut watch_failed = false;
    let mut last_event: Option<Instant> = None;
    let mut next_resolve = Instant::now();
    // 新出现文件跨 tick 累积：事件与防抖结束往往不在同一个 200ms tick 里，
    // 集合必须活到防抖触发被消费为止。
    let mut arrived_paths: HashSet<PathBuf> = HashSet::new();

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

        // 汇聚监听事件，防抖后：新文件先按发现时间补建入库（置顶），
        // 再通知前端刷新。删除与内容修改没有「到达」路径可补建，
        // 但同样进入防抖并触发重扫，保证外部增删改都实时反映到界面。
        let mut saw_event = false;
        while let Ok(signal) = event_rx.try_recv() {
            saw_event = true;
            if let WatchSignal::Arrived(paths) = signal {
                for path in paths {
                    arrived_paths.insert(path);
                }
            }
        }
        if saw_event {
            last_event = Some(Instant::now());
        }
        if let Some(at) = last_event {
            if at.elapsed() >= DEBOUNCE {
                last_event = None;
                if !arrived_paths.is_empty() {
                    let paths: Vec<PathBuf> = arrived_paths.drain().collect();
                    db::discover_external_resource_files(&app, &paths);
                }
                log::info!("资源库外部变更，通知前端刷新");
                let _ = app.emit("resource-groups-changed", ());
            }
        }

        std::thread::sleep(TICK);
    }
}

fn build_watcher(
    event_tx: &mpsc::Sender<WatchSignal>,
) -> Result<RecommendedWatcher, notify::Error> {
    notify::recommended_watcher({
        let tx = event_tx.clone();
        move |result: Result<notify::Event, notify::Error>| {
            if let Ok(event) = result {
                match event.kind {
                    // 「新出现的文件路径」（创建 / 改名落入监听目录）：按
                    // 发现时间补建入库记录，使其在「全部」列表置顶。
                    EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)) => {
                        if !event.paths.is_empty() {
                            let _ = tx.send(WatchSignal::Arrived(event.paths.clone()));
                        }
                    }
                    // 删除与内容修改不影响置顶语义，但必须触发重扫刷新，
                    // 否则文件管理器里删除/改动内容后界面永远不更新。
                    EventKind::Remove(_) | EventKind::Modify(_) => {
                        let _ = tx.send(WatchSignal::Changed);
                    }
                    // Access 等事件高频且无业务语义，忽略以免无谓刷新。
                    EventKind::Access(_) | EventKind::Other | EventKind::Any => {}
                }
            }
        }
    })
}
