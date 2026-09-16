//! 资源库目录监听：外部（文件管理器等）对资源库的增删改经防抖后发出
//! `resource-groups-changed`，资源页与径向菜单已有的监听会自动重新扫描，
//! 让「内容即文件」的外部变更实时反映到界面。
//!
//! 运行期间新出现的文件（从外部移入/复制进来，含整个目录）会按发现时间
//! 补建入库记录，使其在「全部」列表置顶——与刚复制的剪切板内容同待遇；
//! 文件管理器的「移动」保留原修改时间，若只靠扫描合成会按旧时间沉底，
//! 因此必须在监听侧显式补建。应用未运行期间放入的文件不追溯。
//!
//! 事件只提供「哪些路径被触碰」，方向（到达还是消失）由防抖结束时按
//! 磁盘现状 stat 裁决：不存在视为消失（含删除、删除到回收站、剪切移出、
//! rename 来源），存在视为到达（含新建、rename 目标、整目录移入）。
//! 不能信任事件类型分类——Windows（ReadDirectoryChangesW）与 Linux
//! （inotify）都把 rename 报成 `Modify(Name(From/To))` 而非 Remove/Create，
//! 删除到回收站正是这样一次 rename，若按「Modify=到达」处理将永远漏删。
//! 方向裁决后的入库/重定向/清退统一收敛在 `db::settle_external_resource_changes`。
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

/// 监听事件的两种语义：「触碰」收集路径，防抖结束后按磁盘现状统一
/// 结算（到达补建 / 消失重定向或清退）；「变化」只触发前端重扫
/// （内容修改，无路径语义）。
enum WatchSignal {
    Touched(Vec<PathBuf>),
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
    // 触碰的路径跨 tick 累积：事件与防抖结束往往不在同一个 200ms tick
    // 里，集合必须活到防抖触发被消费为止。到达与消失不在此分流——同一
    // 路径窗口内先消失后到达等竞态由结算时的 stat 结果一锤定音。
    let mut touched_paths: HashSet<PathBuf> = HashSet::new();

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

        // 汇聚监听事件，防抖结束后统一结算：按 stat 结果重定向/补建/清退，
        // 然后通知前端刷新。内容修改只进入防抖触发重扫，保证外部增删改
        // 都实时反映到界面。
        let mut saw_event = false;
        while let Ok(signal) = event_rx.try_recv() {
            saw_event = true;
            match signal {
                WatchSignal::Touched(paths) => {
                    for path in paths {
                        touched_paths.insert(path);
                    }
                }
                WatchSignal::Changed => {}
            }
        }
        if saw_event {
            last_event = Some(Instant::now());
        }
        if let Some(at) = last_event {
            if at.elapsed() >= DEBOUNCE {
                last_event = None;
                if !touched_paths.is_empty() {
                    let paths: Vec<PathBuf> = touched_paths.drain().collect();
                    db::settle_external_resource_changes(&app, &paths);
                }
                log::info!("资源库外部变更，通知前端刷新");
                let _ = app.emit("resource-groups-changed", ());
            }
        }

        std::thread::sleep(TICK);
    }
}

/// 事件分类（纯函数，可测）：路径出现/消失/改名（含删除到回收站这类
/// rename 移出）收集为「触碰」，方向由防抖结束时的 stat 裁决；内容修改
/// 只触发重扫刷新，否则文件管理器里改动内容后界面永远不更新；Access
/// 等事件高频且无业务语义，忽略以免无谓刷新。
fn classify_watch_event(kind: &EventKind, paths: &[PathBuf]) -> Option<WatchSignal> {
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => {
            if paths.is_empty() {
                None
            } else {
                Some(WatchSignal::Touched(paths.to_vec()))
            }
        }
        EventKind::Modify(_) => Some(WatchSignal::Changed),
        EventKind::Access(_) | EventKind::Other | EventKind::Any => None,
    }
}

fn build_watcher(
    event_tx: &mpsc::Sender<WatchSignal>,
) -> Result<RecommendedWatcher, notify::Error> {
    notify::recommended_watcher({
        let tx = event_tx.clone();
        move |result: Result<notify::Event, notify::Error>| {
            if let Ok(event) = result {
                if let Some(signal) = classify_watch_event(&event.kind, &event.paths) {
                    let _ = tx.send(signal);
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode,
    };

    fn paths() -> Vec<PathBuf> {
        vec![PathBuf::from("/tmp/sample.mp4")]
    }

    #[test]
    fn create_remove_and_rename_are_touched_not_directional() {
        // Windows/inotify 都把 rename 报成 Modify(Name(From/To)) 而非
        // Remove/Create：三类事件必须统一收集为「触碰」，方向交给 stat
        // 裁决——删除到回收站正是一次 rename 移出，按事件类型分流会漏删。
        for kind in [
            EventKind::Create(CreateKind::Any),
            EventKind::Remove(RemoveKind::Any),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
        ] {
            let signal = classify_watch_event(&kind, &paths())
                .unwrap_or_else(|| panic!("{kind:?} 应被收集"));
            assert!(
                matches!(signal, WatchSignal::Touched(_)),
                "{kind:?} 应分类为 Touched"
            );
        }
    }

    #[test]
    fn touched_without_paths_is_dropped() {
        let kind = EventKind::Create(CreateKind::Any);
        assert!(classify_watch_event(&kind, &[]).is_none());
    }

    #[test]
    fn content_modify_is_changed() {
        let kind = EventKind::Modify(ModifyKind::Data(DataChange::Any));
        assert!(matches!(
            classify_watch_event(&kind, &paths()),
            Some(WatchSignal::Changed)
        ));
    }

    #[test]
    fn access_and_unknown_are_ignored() {
        let access = EventKind::Access(AccessKind::Close(AccessMode::Any));
        assert!(classify_watch_event(&access, &paths()).is_none());
        assert!(classify_watch_event(&EventKind::Other, &paths()).is_none());
        assert!(classify_watch_event(&EventKind::Any, &paths()).is_none());
    }
}
