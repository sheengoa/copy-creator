// 渠道调度：策略排序 + 故障分类与标记（画布设置页配置，settings 通用键值）（自 ai.rs 零改动拆分，2026-11-03 阶段 9a）。
use super::*;

// ── 调度：策略排序 + 故障分类与标记（画布设置页配置，settings 通用键值） ──

#[derive(Clone, Debug)]
pub(super) struct ChannelTarget {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) protocol: String,
    pub(super) base_url: String,
    pub(super) api_key: String,
    /// 已按「渠道配置 → 全局默认」解析好的模型；节点参数模型在生成时统一覆盖。
    pub(super) model: String,
    /// 价格归一比较值（¥ 折 $；None = 未设价格，排序按最差处理）。
    pub(super) price_norm: Option<f64>,
    /// 最近延迟（主动测速 + 被动 EMA；None = 从未测速）。
    pub(super) latency_ms: Option<i64>,
    /// 渠道级代理原文（空 = 无渠道代理，生成时回退全局 ai_proxy）。
    pub(super) proxy: String,
}

pub(super) struct Scheduling {
    pub(super) strategy: String,
    pub(super) price_weight: i64,
    pub(super) failover: bool,
    pub(super) auto_disable_auth: bool,
    pub(super) cooldown_ms: i64,
    pub(super) manual_channel_id: String,
    pub(super) concurrency: i64,
}

pub(super) fn load_scheduling(conn: &rusqlite::Connection) -> Scheduling {
    Scheduling {
        strategy: read_setting(conn, "ai_strategy"),
        price_weight: read_setting(conn, "ai_balance_price_weight").parse::<i64>().unwrap_or(40).clamp(0, 100),
        failover: read_setting(conn, "ai_failover") == "1",
        auto_disable_auth: read_setting(conn, "ai_auto_disable_auth") != "0",
        cooldown_ms: read_setting(conn, "ai_rate_limit_cooldown").parse::<i64>().unwrap_or(300).clamp(5, 3600) * 1000,
        manual_channel_id: read_setting(conn, "ai_manual_channel_id"),
        concurrency: read_setting(conn, "ai_concurrency").parse::<i64>().unwrap_or(4).clamp(1, 8),
    }
}

/// 按调度策略排出本次生成的渠道尝试顺序：可用 = 启用 + 未自动停用 +
/// 不在限流冷却期。manual 只取指定渠道；latency 按（主动测速 + 被动
/// EMA）延迟升序；price 按归一化价格（¥ 简化按 7.2 折算）升序、同价比
/// 延迟；balance 按归一化价格 × 权重 + 归一化延迟 ×（1-权重）打分。
/// 无测速/价格数据的渠道排尾（视为最差），不阻断调度。
pub(super) fn ordered_channel_targets(conn: &rusqlite::Connection, sched: &Scheduling) -> Result<Vec<ChannelTarget>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, protocol, base_url, api_key, model, price, currency, \
             last_latency_ms, cooldown_until_ms, status, proxy FROM ai_channels \
             WHERE enabled = 1 ORDER BY sort_order ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String, String, Option<f64>, String, Option<i64>, i64, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?,
                row.get(11)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let now_ms = crate::clock::now_ms();
    let global_model = read_setting(conn, "ai_model");
    let mut targets: Vec<ChannelTarget> = Vec::new();
    let mut usable_rows = 0usize;
    // 全被挡住时的报错细分计数：自动停用 / 限流冷却（含最长剩余，供
    // 「约 N 分钟后自动恢复」估算；停用优先于冷却，与过滤条件同序）。
    let mut disabled_rows = 0usize;
    let mut cooldown_rows = 0usize;
    let mut max_cooldown_remaining_ms = 0i64;
    for (id, name, protocol, base_url, api_key, model, price, currency, last_latency_ms, cooldown_until_ms, status, proxy) in &rows {
        if status == "auto_disabled" {
            disabled_rows += 1;
            continue;
        }
        if *cooldown_until_ms > now_ms {
            cooldown_rows += 1;
            max_cooldown_remaining_ms = max_cooldown_remaining_ms.max(*cooldown_until_ms - now_ms);
            continue;
        }
        usable_rows += 1;
        let resolved = match channel_model_or_global(model, &global_model) {
            Ok(m) => m,
            Err(_) => continue, // 无可用模型的渠道剔除，不阻断其余渠道
        };
        // 价格归一比较值：¥ 简化按 7.2 折算为 $；未设价格按最大值排尾。
        let price_norm = price.map(|p| p * if currency == "¥" { 0.1389 } else { 1.0 });
        targets.push(ChannelTarget {
            id: id.clone(),
            name: name.clone(),
            protocol: protocol.clone(),
            base_url: base_url.clone(),
            api_key: api_key.clone(),
            model: resolved,
            price_norm,
            latency_ms: *last_latency_ms,
            proxy: proxy.clone(),
        });
    }
    if targets.is_empty() {
        return Err(if usable_rows > 0 {
            "渠道都没有可用模型：请在渠道或 设置 → 画布 → 生成默认值 里填写模型".to_string()
        } else if disabled_rows == 0 && cooldown_rows > 0 {
            // 单渠道超时/限流被冷却时最常见的现场：如实告知会自动恢复 +
            // 手动恢复入口，不说「请添加或启用渠道」（渠道明明都启用了，
            // 2026-11-06 用户反馈的误导文案）。
            let mins = (max_cooldown_remaining_ms + 59_999) / 60_000;
            format!("启用渠道都在限流冷却中：约 {mins} 分钟后自动恢复，也可到 设置 → 画布 对渠道点「恢复」")
        } else if disabled_rows > 0 && cooldown_rows == 0 {
            "渠道已被自动停用（鉴权/欠费类错误）：请到 设置 → 画布 检查 API Key 或对渠道点「恢复」".to_string()
        } else if disabled_rows > 0 || cooldown_rows > 0 {
            format!(
                "启用渠道都暂不可用：{cooldown_rows} 条限流冷却中、{disabled_rows} 条已自动停用，可到 设置 → 画布 恢复"
            )
        } else {
            "没有可用的生成渠道：请到 设置 → 画布 添加或启用渠道".to_string()
        });
    }

    match sched.strategy.as_str() {
        "manual" => {
            let picked: Vec<ChannelTarget> = targets.into_iter().filter(|t| t.id == sched.manual_channel_id).collect();
            if picked.is_empty() {
                return Err("手动指定的渠道当前不可用（不存在、已停用或冷却中）：请到 设置 → 画布 检查或恢复".to_string());
            }
            Ok(picked)
        }
        "price" => {
            targets.sort_by(|a, b| {
                let pa = a.price_norm.unwrap_or(f64::MAX);
                let pb = b.price_norm.unwrap_or(f64::MAX);
                pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal).then_with(|| {
                    let la = a.latency_ms.unwrap_or(i64::MAX);
                    let lb = b.latency_ms.unwrap_or(i64::MAX);
                    la.cmp(&lb)
                })
            });
            Ok(targets)
        }
        "latency" => {
            targets.sort_by(|a, b| {
                let la = a.latency_ms.unwrap_or(i64::MAX);
                let lb = b.latency_ms.unwrap_or(i64::MAX);
                la.cmp(&lb)
            });
            Ok(targets)
        }
        _ => {
            // balance（默认）：归一化价格 × 权重 + 归一化延迟 ×（1-权重）。
            // 归一范围只看本次可用渠道；无价格/延迟数据的渠道按最差值 1.0。
            let p_values: Vec<f64> = targets.iter().filter_map(|t| t.price_norm).collect();
            let l_values: Vec<i64> = targets.iter().filter_map(|t| t.latency_ms).collect();
            let p_min = p_values.iter().copied().fold(f64::MAX, f64::min);
            let p_max = p_values.iter().copied().fold(f64::MIN, f64::max);
            let l_min = l_values.iter().copied().min().unwrap_or(0);
            let l_max = l_values.iter().copied().max().unwrap_or(1);
            let norm_f = |v: f64, min: f64, max: f64| if max > min { (v - min) / (max - min) } else { 0.5 };
            let norm_i = |v: i64, min: i64, max: i64| if max > min { (v - min) as f64 / (max - min) as f64 } else { 0.5 };
            let w = sched.price_weight as f64 / 100.0;
            let score = |t: &ChannelTarget| -> f64 {
                let price_score = t.price_norm.map(|p| norm_f(p, p_min, p_max)).unwrap_or(1.0);
                let lat_score = t.latency_ms.map(|l| norm_i(l, l_min, l_max)).unwrap_or(1.0);
                price_score * w + lat_score * (1.0 - w)
            };
            targets.sort_by(|a, b| score(a).partial_cmp(&score(b)).unwrap_or(std::cmp::Ordering::Equal));
            Ok(targets)
        }
    }
}

fn latency_map(conn: &rusqlite::Connection) -> std::collections::HashMap<String, i64> {
    conn.prepare("SELECT id, last_latency_ms FROM ai_channels WHERE last_latency_ms IS NOT NULL")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default()
}

/// 生成失败分类：鉴权/欠费类（重试无意义）→ 自动停用；限流类 →
/// 冷却到期自动恢复；**超时不冷却**（2026-11-06 用户反馈：单次超时多
/// 为网络抖动或本张生成超预算，渠道本身没坏——拉出调度 5 分钟等于把
/// 用户锁在门外，重试点一下就好），与其余错误一样仅记录错误文案。
pub(super) fn classify_failure(message: &str) -> &'static str {
    let m = message.to_lowercase();
    let auth_keys = ["认证失败", "401", "403", "invalid_api_key", "unauthorized", "insufficient", "quota", "欠费", "余额不足", "billing", "permission"];
    let rate_keys = ["429", "限流", "rate limit", "too many requests"];
    if auth_keys.iter().any(|k| m.contains(k)) {
        "auth"
    } else if rate_keys.iter().any(|k| m.contains(k)) {
        "rate"
    } else {
        "other"
    }
}

pub(super) fn mark_channel_failure(conn: &rusqlite::Connection, channel_id: &str, kind: &str, sched: &Scheduling, message: &str) {
    let now = crate::clock::now_rfc3339();
    let update = match kind {
        "auth" if sched.auto_disable_auth => conn.execute(
            "UPDATE ai_channels SET status = 'auto_disabled', last_error = ?1, updated_at = ?2 WHERE id = ?3",
            params![message, now, channel_id],
        ),
        "rate" => conn.execute(
            "UPDATE ai_channels SET cooldown_until_ms = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4",
            params![crate::clock::now_ms() + sched.cooldown_ms, message, now, channel_id],
        ),
        _ => conn.execute(
            "UPDATE ai_channels SET last_error = ?1, updated_at = ?2 WHERE id = ?3",
            params![message, now, channel_id],
        ),
    };
    if let Err(error) = update {
        log::error!("写入渠道故障状态失败: {error}");
    }
}

/// 真实生成的耗时按渠道做 EMA（旧值 70% + 新值 30%）：让「延迟优先 /
/// 综合最优」随真实使用自校准，主动测速只做初始标定。
pub(super) fn record_channel_latency(conn: &rusqlite::Connection, channel_id: &str, latency_ms: u64) {
    let now = crate::clock::now_rfc3339();
    if let Err(error) = conn.execute(
        "UPDATE ai_channels SET last_latency_ms = \
         CASE WHEN last_latency_ms IS NULL THEN ?1 ELSE (last_latency_ms * 7 + ?1 * 3) / 10 END, \
         last_tested_at = ?2 WHERE id = ?3",
        params![latency_ms as i64, now, channel_id],
    ) {
        log::error!("写入渠道耗时统计失败: {error}");
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failure_classification_rules() {
        // 鉴权/欠费类：命中即停（重试无意义）
        assert_eq!(classify_failure("认证失败，请检查 API Key"), "auth");
        assert_eq!(classify_failure("HTTP 401"), "auth");
        assert_eq!(classify_failure("insufficient_quota: 已欠费"), "auth");
        // 限流类：冷却后自动恢复；超时不再冷却（渠道没坏，不该锁 5 分钟）
        assert_eq!(classify_failure("请求过于频繁（限流），请稍后再试"), "rate");
        assert_eq!(classify_failure("HTTP 429"), "rate");
        assert_eq!(classify_failure("请求失败：operation timed out"), "other");
        assert_eq!(classify_failure("请求失败：timeout"), "other");
        // 其余（网络/参数/内容策略等）只记录不动作
        assert_eq!(classify_failure("接口没有返回任何图片"), "other");
        assert_eq!(classify_failure("图片尺寸无效"), "other");
        // 优先级：同时含两类关键字时按鉴权处理（更保守，避免反复撞墙）
        assert_eq!(classify_failure("401 rate limit"), "auth");
    }
}
