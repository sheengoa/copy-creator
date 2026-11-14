// 时间戳的唯一产出点：此前 canvas_now / project_now / now_epoch_ms /
// now_millis 四个私有 helper 与 20+ 处内联 chrono 调用各写各的（UTC
// RFC3339 与 Unix 毫秒两族形态，时区与精度口径分散在五处定义），收口
// 于本模块——持久化时间戳一律 UTC RFC3339，调度/看门狗一律 Unix 毫秒
// （i64）。paste.rs 的 Local::now 是用户可见的 {{time}} 占位符（本地
// 时区语义），backup 文件名时间戳同为本地时间展示，均刻意不归口。

pub(crate) fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
