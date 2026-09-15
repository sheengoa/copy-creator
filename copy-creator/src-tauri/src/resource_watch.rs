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

/// 监听事件的三种语义：「到达」按发现时间补建入库，「消失」按路径移除
/// 记录（文件不在，记录不留），其余变更（内容修改）只触发前端重扫。
enum WatchSignal {
    Arrived(Vec<PathBuf>),
    Vanished(Vec<PathBuf>),
    Changed,
}

/// notify 事件到业务信号的纯映射（可单测）：创建/改名落入 = 到达；
/// 删除 = 消失 + 触发重扫（改名会先发 Remove 旧路径，新路径由到达补建）；
/// 内容修改只触发重扫；Access 等高频无语义事件忽略以免无谓刷新。
fn classify_event(event: &notify::Event) -> Vec<WatchSignal> {
    match event.kind {
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)) => {
            if event.paths.is_empty() {
                Vec::new()
            } else {
                vec![WatchSignal::Arrived(event.paths.clone())]
            }
        }
        EventKind::Remove(_) => {
            let mut signals = Vec::new();
            if !event.paths.is_empty() {
                signals.push(WatchSignal::Vanished(event.paths.clone()));
            }
            signals.push(WatchSignal::Changed);
            signals
        }
        EventKind::Modify(_) => vec![WatchSignal::Changed],
        EventKind::Access(_) | EventKind::Other | EventKind::Any => Vec::new(),
    }
}

/// 跨 tick 的信号聚合（可单测）：防抖窗口内到达按路径合并；消失与先前的
/// 到达相互抵消（同一文件窗口内到了又走，不应补建入库记录），消失路径
/// 单独收集。冲刷一次取空两组路径。
#[derive(Default)]
struct SignalAccumulator {
    arrived: HashSet<PathBuf>,
    vanished: HashSet<PathBuf>,
}

impl SignalAccumulator {
    fn absorb(&mut self, signal: WatchSignal) {
        match signal {
            WatchSignal::Arrived(paths) => {
                for path in paths {
                    self.arrived.insert(path);
                }
            }
            WatchSignal::Vanished(paths) => {
                for path in paths {
                    self.arrived.remove(&path);
                    self.vanished.insert(path);
                }
            }
            WatchSignal::Changed => {}
        }
    }

    /// 冲刷：返回（消失, 到达）两组路径并清空。
    fn take_flush(&mut self) -> (Vec<PathBuf>, Vec<PathBuf>) {
        (self.vanished.drain().collect(), self.arrived.drain().collect())
    }
}

pub fn spawn<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        // 监听线程承载资源库的自愈语义，任何 panic（notify 平台层、记录
        // 库锁毒化等）都不允许静默终止监听：捕获后整体重建 watch_loop，
        // 循环自身的路径解析与 watcher 重建逻辑会恢复到一致状态。
        loop {
            let outcome =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| watch_loop(app.clone())));
            match outcome {
                Ok(()) => break,
                Err(_) => {
                    log::error!("资源库监听线程发生 panic，3 秒后重建监听循环");
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
    });
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
    // 新出现/消失的文件跨 tick 累积：事件与防抖结束往往不在同一个
    // 200ms tick 里，集合必须活到防抖触发被消费为止。
    let mut accumulator = SignalAccumulator::default();

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
                // 丢弃旧 watcher 到新 watcher 生效之间的文件系统事件无法补收，
                // 修订号也不会自增，前端心跳无从察觉：重建后无条件安排一次
                // 防抖重扫（冲刷是幂等重扫），把间隙内丢失的变更并入冲刷。
                last_event = Some(Instant::now());
            }
        }

        // 汇聚监听事件，防抖后：新文件按发现时间补建入库（置顶），被删除
        // 的文件按路径移除记录，然后通知前端刷新。内容修改只进入防抖触发
        // 重扫，保证外部增删改都实时反映到界面。
        let mut saw_event = false;
        while let Ok(signal) = event_rx.try_recv() {
            saw_event = true;
            accumulator.absorb(signal);
        }
        if saw_event {
            last_event = Some(Instant::now());
        }
        if let Some(at) = last_event {
            if at.elapsed() >= DEBOUNCE {
                last_event = None;
                let (vanished_paths, arrived_paths) = accumulator.take_flush();
                if !vanished_paths.is_empty() {
                    db::forget_resource_records(&app, &vanished_paths);
                }
                if !arrived_paths.is_empty() {
                    db::discover_external_resource_files(&app, &arrived_paths);
                }
                // 修订号随冲刷自增：即使 resource-groups-changed 事件被
                // WebView 丢弃，前端心跳比对也能发现落后并自愈。
                db::bump_resource_library_revision();
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
                for signal in classify_event(&event) {
                    let _ = tx.send(signal);
                }
            }
        }
    })
}

#[cfg(test)]
mod resource_watch_tests {
    use super::*;
    use std::path::Path;

    fn event(kind: EventKind, paths: &[&str]) -> notify::Event {
        let mut event = notify::Event::new(kind);
        event.paths = paths.iter().map(Path::new).map(PathBuf::from).collect();
        event
    }

    fn single(signal: Option<WatchSignal>) -> WatchSignal {
        signal.expect("expected one signal")
    }

    #[test]
    fn create_and_rename_arrivals_map_to_arrived() {
        let created = classify_event(&event(
            EventKind::Create(notify::event::CreateKind::File),
            &["/lib/new.png"],
        ));
        assert!(matches!(single(created.into_iter().next()), WatchSignal::Arrived(_)));

        let renamed = classify_event(&event(
            EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::To)),
            &["/lib/renamed.txt"],
        ));
        assert!(matches!(single(renamed.into_iter().next()), WatchSignal::Arrived(_)));
    }

    #[test]
    fn removal_emits_vanished_then_rescan() {
        let signals = classify_event(&event(
            EventKind::Remove(notify::event::RemoveKind::File),
            &["/lib/gone.png"],
        ));
        assert_eq!(signals.len(), 2);
        assert!(matches!(&signals[0], WatchSignal::Vanished(p) if p == &vec![PathBuf::from("/lib/gone.png")]));
        assert!(matches!(signals[1], WatchSignal::Changed));
    }

    #[test]
    fn content_modify_only_triggers_rescan() {
        let signals = classify_event(&event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Any)),
            &["/lib/a.md"],
        ));
        assert_eq!(signals.len(), 1);
        assert!(matches!(signals[0], WatchSignal::Changed));
    }

    #[test]
    fn access_and_other_events_are_ignored() {
        assert!(classify_event(&event(
            EventKind::Access(notify::event::AccessKind::Read),
            &["/lib/a.md"],
        ))
        .is_empty());
        assert!(classify_event(&event(EventKind::Other, &[])).is_empty());
    }

    #[test]
    fn vanished_cancels_arrival_within_debounce_window() {
        // 同一文件窗口内到了又走：不应补建入库（arrived 为空），
        // 只按消失处理。
        let mut acc = SignalAccumulator::default();
        acc.absorb(WatchSignal::Arrived(vec![PathBuf::from("/lib/new.png")]));
        acc.absorb(WatchSignal::Vanished(vec![PathBuf::from("/lib/new.png")]));

        let (vanished, arrived) = acc.take_flush();
        assert!(arrived.is_empty());
        assert_eq!(vanished, vec![PathBuf::from("/lib/new.png")]);
    }

    #[test]
    fn flush_drains_paths_exactly_once_and_merges_duplicates() {
        let mut acc = SignalAccumulator::default();
        acc.absorb(WatchSignal::Arrived(vec![PathBuf::from("/lib/a.png")]));
        acc.absorb(WatchSignal::Arrived(vec![
            PathBuf::from("/lib/a.png"),
            PathBuf::from("/lib/b.png"),
        ]));

        let (vanished, arrived) = acc.take_flush();
        assert!(vanished.is_empty());
        let mut names: Vec<_> = arrived.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["a.png", "b.png"]);

        // 冲刷后清空：再次冲刷不重复上报。
        let (vanished, arrived) = acc.take_flush();
        assert!(vanished.is_empty() && arrived.is_empty());
    }
}
