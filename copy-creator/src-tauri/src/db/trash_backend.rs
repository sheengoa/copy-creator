// 系统回收站操作抽象：删除/列出/恢复/彻底清除，按原始路径匹配。
// 生产实现包 trash crate（Windows 走 Shell COM、Linux 走 freedesktop
// 回收站规范，两平台的 list/restore_all/purge_all 均受支持）；测试以
// 进程级 fake 替换，绝不触碰真实系统回收站。
//
// 实测约束（Windows spike 结论，trash 5.2）：
// - 系统回收站记录的是干净长路径（无 \\?\ 前缀）；应用侧路径可能带
//   verbatim 前缀或正斜杠，匹配必须剥前缀 + 统一反斜杠 + Windows 下
//   不区分大小写；
// - 同一原始路径多次删除会在回收站内产生多条条目——恢复必须单条取
//   time_deleted 最新（多条一起 restore_all 会 RestoreTwins 报错）；
//   time_deleted 为秒级粒度，同秒双删的先后不可分辨（真实场景极罕见）；
// - restore_all 把文件放回条目记录的 original_parent（目录缺失时由
//   调用方先建）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 系统回收站内一个条目的原始路径快照。
#[derive(Debug, Clone)]
pub(crate) struct BinEntry {
    pub original_path: PathBuf,
}

pub(crate) trait TrashBackend: Send + Sync {
    /// 把文件移入系统回收站（同盘为 rename 级速度）。
    fn send_to_trash(&self, path: &Path) -> Result<(), String>;
    /// 当前系统回收站内全部条目的原始路径。
    fn list_original_paths(&self) -> Result<Vec<BinEntry>, String>;
    /// 恢复原始路径匹配的最新一条到其原路径（多条匹配时其余保留，
    /// 由用户在系统侧自行管理）。
    fn restore_newest(&self, original_path: &Path) -> Result<(), String>;
    /// 永久清除原始路径匹配的全部条目，返回清除数（0 = 本就不在）。
    fn purge(&self, original_path: &Path) -> Result<u32, String>;
    /// 批量清除：一次枚举覆盖全部路径（默认逐路径委托 purge；系统实现
    /// 覆写为单次枚举，「清空回收站」等批量场景避免 N 次全量枚举）。
    fn purge_batch(&self, original_paths: &[PathBuf]) -> Result<u32, String> {
        let mut total = 0u32;
        for path in original_paths {
            total += self.purge(path)?;
        }
        Ok(total)
    }
}

// 测试构建不构造系统实现（默认走 fake），_allow 压掉 lib test 构建的
// dead_code 误报；生产构建它是唯一后端。
#[cfg_attr(test, allow(dead_code))]
pub(crate) struct SystemTrashBackend;

// 系统回收站完整实现：trash crate 的 os_limited 仅编 Windows 与非 Apple
// Unix（freedesktop 规范）——恰为应用的发布平台（Windows / Ubuntu）。
#[cfg(any(
    target_os = "windows",
    all(unix, not(target_os = "macos"), not(target_os = "ios"), not(target_os = "android"))
))]
impl TrashBackend for SystemTrashBackend {
    fn send_to_trash(&self, path: &Path) -> Result<(), String> {
        trash::delete(path).map_err(|e| format!("移入系统回收站失败: {e}"))
    }

    fn list_original_paths(&self) -> Result<Vec<BinEntry>, String> {
        let items = trash::os_limited::list()
            .map_err(|e| format!("读取系统回收站失败: {e}"))?;
        Ok(items
            .into_iter()
            .map(|item| BinEntry {
                original_path: item.original_path(),
            })
            .collect())
    }

    fn restore_newest(&self, original_path: &Path) -> Result<(), String> {
        let items = trash::os_limited::list()
            .map_err(|e| format!("读取系统回收站失败: {e}"))?;
        let newest = items
            .into_iter()
            .filter(|item| bin_path_eq(&item.original_path(), original_path))
            .max_by_key(|item| item.time_deleted)
            .ok_or_else(|| "系统回收站中没有该文件".to_string())?;
        trash::os_limited::restore_all(vec![newest])
            .map_err(|e| format!("从系统回收站恢复失败: {e}"))
    }

    fn purge(&self, original_path: &Path) -> Result<u32, String> {
        let items = trash::os_limited::list()
            .map_err(|e| format!("读取系统回收站失败: {e}"))?;
        let matches: Vec<_> = items
            .into_iter()
            .filter(|item| bin_path_eq(&item.original_path(), original_path))
            .collect();
        let count = matches.len() as u32;
        if count > 0 {
            trash::os_limited::purge_all(matches)
                .map_err(|e| format!("从系统回收站彻底清除失败: {e}"))?;
        }
        Ok(count)
    }

    fn purge_batch(&self, original_paths: &[PathBuf]) -> Result<u32, String> {
        let items = trash::os_limited::list()
            .map_err(|e| format!("读取系统回收站失败: {e}"))?;
        let matches: Vec<_> = items
            .into_iter()
            .filter(|item| {
                original_paths
                    .iter()
                    .any(|path| bin_path_eq(&item.original_path(), path))
            })
            .collect();
        let count = matches.len() as u32;
        if count > 0 {
            trash::os_limited::purge_all(matches)
                .map_err(|e| format!("从系统回收站彻底清除失败: {e}"))?;
        }
        Ok(count)
    }
}

// macOS：trash crate 支持 delete（进访达废纸篓）但 os_limited 未编译——
// 列举/恢复/清除不可用。恢复走 Relinked/MetadataOnly 兜底，数据不丢
// （文件在访达废纸篓可见、可手动放回）。应用不发布 macOS，此实现仅为
// 保持平台可编译。
#[cfg(target_os = "macos")]
impl TrashBackend for SystemTrashBackend {
    fn send_to_trash(&self, path: &Path) -> Result<(), String> {
        trash::delete(path).map_err(|e| format!("移入废纸篓失败: {e}"))
    }
    fn list_original_paths(&self) -> Result<Vec<BinEntry>, String> {
        Err("当前系统不支持读取废纸篓".to_string())
    }
    fn restore_newest(&self, _original_path: &Path) -> Result<(), String> {
        Err("当前系统不支持从废纸篓自动恢复".to_string())
    }
    fn purge(&self, _original_path: &Path) -> Result<u32, String> {
        Err("当前系统不支持从废纸篓清除".to_string())
    }
}

// 其余平台（iOS / Android / wasm 等，应用不发布）：全部操作不可用。
#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    all(unix, not(target_os = "ios"), not(target_os = "android"))
)))]
impl TrashBackend for SystemTrashBackend {
    fn send_to_trash(&self, _path: &Path) -> Result<(), String> {
        Err("当前系统不支持回收站操作".to_string())
    }
    fn list_original_paths(&self) -> Result<Vec<BinEntry>, String> {
        Err("当前系统不支持回收站操作".to_string())
    }
    fn restore_newest(&self, _original_path: &Path) -> Result<(), String> {
        Err("当前系统不支持回收站操作".to_string())
    }
    fn purge(&self, _original_path: &Path) -> Result<u32, String> {
        Err("当前系统不支持回收站操作".to_string())
    }
}

/// 当前生效的回收站后端。测试构建默认进程级 fake（临时目录模拟，绝不
/// 触碰真实系统回收站——各测试路径带 uuid 互不干扰）；生产构建为系统
/// 实现。
pub(crate) fn trash_backend() -> Arc<dyn TrashBackend> {
    #[cfg(test)]
    {
        Arc::new(fake::FakeTrashBackend) as Arc<dyn TrashBackend>
    }
    #[cfg(not(test))]
    {
        Arc::new(SystemTrashBackend) as Arc<dyn TrashBackend>
    }
}

// ── 测试 fake（仅测试构建编译）────────────────────────────────────
// 进程级单例状态：文件 rename 进共享 fake 根并记录原始路径，list /
// restore / purge 按原始路径匹配；seq 保证「最新一条」语义可严格判定。
#[cfg(test)]
mod fake {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    #[derive(Debug, Clone)]
    struct FakeEntry {
        original: PathBuf,
        stored: PathBuf,
        seq: u64,
    }

    static FAKE_SEQ: AtomicU64 = AtomicU64::new(0);
    static FAKE_BIN: Mutex<Vec<FakeEntry>> = Mutex::new(Vec::new());

    pub(crate) struct FakeTrashBackend;

    impl TrashBackend for FakeTrashBackend {
        fn send_to_trash(&self, path: &Path) -> Result<(), String> {
            let seq = FAKE_SEQ.fetch_add(1, Ordering::SeqCst);
            let stored = fake_root().join(format!("{seq}"));
            std::fs::rename(path, &stored).map_err(|e| format!("fake 移入失败: {e}"))?;
            FAKE_BIN.lock().unwrap().push(FakeEntry {
                original: path.to_path_buf(),
                stored,
                seq,
            });
            Ok(())
        }

        fn list_original_paths(&self) -> Result<Vec<BinEntry>, String> {
            Ok(FAKE_BIN
                .lock()
                .unwrap()
                .iter()
                .map(|entry| BinEntry {
                    original_path: entry.original.clone(),
                })
                .collect())
        }

        fn restore_newest(&self, original_path: &Path) -> Result<(), String> {
            let mut bin = FAKE_BIN.lock().unwrap();
            let best = bin
                .iter()
                .enumerate()
                .filter(|(_, entry)| bin_path_eq(&entry.original, original_path))
                .max_by_key(|(_, entry)| entry.seq)
                .map(|(index, _)| index)
                .ok_or_else(|| "系统回收站中没有该文件".to_string())?;
            let entry = bin.remove(best);
            drop(bin);
            if let Some(parent) = original_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("fake 建目录失败: {e}"))?;
            }
            std::fs::rename(&entry.stored, original_path).map_err(|e| format!("fake 恢复失败: {e}"))
        }

        fn purge(&self, original_path: &Path) -> Result<u32, String> {
            let mut bin = FAKE_BIN.lock().unwrap();
            let mut kept = Vec::new();
            let mut removed = 0u32;
            for entry in bin.drain(..) {
                if bin_path_eq(&entry.original, original_path) {
                    let _ = std::fs::remove_file(&entry.stored);
                    removed += 1;
                } else {
                    kept.push(entry);
                }
            }
            *bin = kept;
            Ok(removed)
        }
    }

    fn fake_root() -> PathBuf {
        let root = std::env::temp_dir().join("copy-creator-fake-trash");
        std::fs::create_dir_all(&root).ok();
        root
    }

    /// 测试助手：模拟资源管理器删除——把磁盘上已存在的文件送进 fake。
    pub(crate) fn fake_send(path: &Path) {
        FakeTrashBackend
            .send_to_trash(path)
            .expect("fake send 不应失败");
    }

    /// 测试助手：fake 回收站内该原始路径的条目数。
    pub(crate) fn fake_count(path: &Path) -> usize {
        FAKE_BIN
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| bin_path_eq(&entry.original, path))
            .count()
    }
}

#[cfg(test)]
pub(crate) use fake::{fake_count, fake_send};

/// 回收站原始路径匹配：剥 verbatim 前缀 + 统一反斜杠 + Windows 下不区分
/// 大小写（实测：bin 记录干净长路径，应用侧可能带 \\?\ 前缀或正斜杠）。
pub(crate) fn bin_path_eq(a: &Path, b: &Path) -> bool {
    norm(a) == norm(b)
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let s = s.strip_prefix(r"\\?\UNC\").unwrap_or(s);
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}
