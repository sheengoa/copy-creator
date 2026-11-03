// 进行中生成的取消开关：request_id → Notify（自 ai.rs 零改动拆分，2026-11-03 阶段 9a）。
use super::*;

pub(super) fn cancel_registry() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Notify>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) struct ImageTaskResult {
    pub(super) slot: usize,
    pub(super) data_url: Option<String>,
    pub(super) error: Option<String>,
    /// 实际使用的渠道名（成功或最终失败时记录，供排查与展示）。
    pub(super) channel: Option<String>,
}
