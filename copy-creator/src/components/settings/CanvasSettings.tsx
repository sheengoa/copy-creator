// 画布设置页（画布设置独立成页）：生成服务渠道（多组 Base URL + Key，
// 拖拽排序 + 互斥手风琴编辑）→ 自动调度（手动/延迟/价格/综合四策略 +
// 价格权重滑杆）→ 故障处理（失败切换 / 鉴权自动停用 / 限流冷却）→
// 生成默认值（默认模型 / 单次并发 / 请求超时）。全部自持久化：改动即
// 落库，不走设置页统一保存按钮（与原 AI 生图分区同惯例）。
// Key 不回传前端：列表只有掩码，编辑表单 Key 留空 = 保留原值。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore, type AiChannel, type AiChannelInput, type AiStrategy } from "../../stores/settingsStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { Icons } from "../Icons";
import { IosSelect, Segmented, Toggle } from "../ui";

// ── 渠道行（可拖拽排序） ──

function ChannelRow({
  channel,
  open,
  testing,
  onToggle,
  onEnabledChange,
  onDelete,
  onTest,
}: {
  channel: AiChannel;
  open: boolean;
  testing: boolean;
  onToggle: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: channel.id,
  });
  const [showKey, setShowKey] = useState(false);
  // 展开编辑为本地表单：装载/切换渠道时以外部值重挂（key=渠道 id），与
  // 节点参数输入同惯例（失焦提交，不吃快速输入的字）。
  const [name, setName] = useState(channel.name);
  const [protocol, setProtocol] = useState(channel.protocol);
  const [baseUrl, setBaseUrl] = useState(channel.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(channel.model);
  const [priceText, setPriceText] = useState(channel.price == null ? "" : String(channel.price));
  const [currency, setCurrency] = useState(channel.currency);
  const [error, setError] = useState("");
  const updateAiChannel = useSettingsStore((s) => s.updateAiChannel);
  const dimmed = !channel.enabled || channel.status === "auto_disabled";

  // 行首状态：测速中 → 转圈；自动停用 → 红点；最近一次测速失败 → 红点
  //（tooltip 见错误）；有延迟 → 绿点；从未测速 → 灰点。
  const failed = !testing && channel.lastError !== "";
  const latencyText = testing
    ? t("settings.canvas.testing")
    : failed
      ? t("settings.canvas.testFailed")
      : channel.lastLatencyMs == null
        ? t("settings.canvas.untested")
        : `${channel.lastLatencyMs} ms`;
  const latencyClass = testing
    ? " testing"
    : channel.status === "auto_disabled" || failed
      ? " off"
      : channel.lastLatencyMs == null ? " none" : " ok";
  const dotClass = testing
    ? " testing"
    : channel.status === "auto_disabled" || failed
      ? " bad"
      : channel.lastLatencyMs == null ? " none" : " ok";

  const submit = async () => {
    setError("");
    // 无变更不提交：blur 逐字段触发，原样提交会顺带把后端的故障状态
    //（auto_disabled / last_error / 测速记录）重置掉。
    const price = priceText.trim() === "" ? null : Number.parseFloat(priceText);
    const priceDirty = priceText.trim() === ""
      ? channel.price != null
      : !Number.isFinite(price) || (price as number) !== channel.price;
    if (
      name === channel.name &&
      protocol === channel.protocol &&
      baseUrl === channel.baseUrl &&
      apiKey.trim() === "" &&
      model === channel.model &&
      currency === channel.currency &&
      !priceDirty
    ) {
      return;
    }
    if (priceText.trim() !== "" && (!Number.isFinite(price) || (price as number) < 0)) {
      setError(t("settings.canvas.priceInvalid"));
      return;
    }
    try {
      await updateAiChannel(channel.id, {
        name,
        protocol,
        baseUrl,
        apiKey: apiKey.trim() === "" ? null : apiKey.trim(),
        model,
        price,
        currency,
      });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      ref={setNodeRef}
      className={`canvas-ch${open ? " open" : ""}${dimmed ? " dim" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="canvas-ch-head">
        <button
          type="button"
          className="canvas-ch-grip"
          aria-label={t("settings.canvas.dragHandle")}
          {...attributes}
          {...listeners}
        >
          {Icons.drag}
        </button>
        <button type="button" className="canvas-ch-summary" onClick={onToggle}>
          <span className={`canvas-dot${dotClass}`} />
          <span className="canvas-ch-txt">
            <span className="canvas-ch-name-row">
              <span className="canvas-ch-name">{channel.name}</span>
              <span className={`canvas-tag ${channel.protocol === "gemini" ? "gemini" : "openai"}`}>
                {channel.protocol === "gemini" ? t("settings.canvas.protocolGemini") : t("settings.canvas.protocolOpenai")}
              </span>
            </span>
            <span className="canvas-ch-sub">
              {channel.baseUrl.replace(/^https?:\/\//, "")}
              {" · "}
              {channel.model || t("settings.canvas.globalModel")}
              {" · "}
              {channel.price == null
                ? t("settings.canvas.noPrice")
                : `${channel.currency}${channel.price}/${t("settings.canvas.perImage")}`}
            </span>
          </span>
          {channel.status === "auto_disabled" && channel.lastError && (
            <span className="canvas-lat off" title={channel.lastError}>{t("settings.canvas.autoDisabled")}</span>
          )}
          <span className={`canvas-lat${latencyClass}`}>{latencyText}</span>
          <Toggle
            checked={channel.enabled}
            onChange={onEnabledChange}
            ariaLabel={channel.name}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="canvas-chev">{Icons.chevronRight}</span>
        </button>
      </div>
      {open && (
        <div className="canvas-ch-body">
          <div className="canvas-form-grid">
            <div className="canvas-field">
              <span className="canvas-field-label">{t("settings.canvas.fieldName")}</span>
              <input className="settings-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void submit()} />
            </div>
            <div className="canvas-field">
              <span className="canvas-field-label">{t("settings.canvas.fieldProtocol")}</span>
              <Segmented
                value={protocol}
                options={[
                  { value: "openai", label: t("settings.canvas.protocolOpenai") },
                  { value: "gemini", label: t("settings.canvas.protocolGemini") },
                ]}
                onChange={setProtocol}
                ariaLabel={t("settings.canvas.fieldProtocol")}
              />
            </div>
            <div className="canvas-field full">
              <span className="canvas-field-label">
                {t("settings.canvas.fieldBaseUrl")}
                <em> · {t("settings.canvas.baseUrlHint")}</em>
              </span>
              <input
                className="settings-input canvas-mono"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={() => void submit()}
                spellCheck={false}
              />
            </div>
            <div className="canvas-field full">
              <span className="canvas-field-label">
                {t("settings.canvas.fieldApiKey")}
                <em> · {channel.apiKeySet ? t("settings.canvas.apiKeyKeep") : t("settings.canvas.apiKeyMissing")}</em>
              </span>
              <div className="canvas-key-wrap">
                <input
                  className="settings-input canvas-mono"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  placeholder={channel.apiKeySet ? channel.apiKeyPreview : ""}
                  onChange={(e) => setApiKey(e.target.value)}
                  onBlur={() => void submit()}
                  spellCheck={false}
                  autoComplete="new-password"
                />
                <button type="button" className="canvas-eye" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? Icons.eyeOff : Icons.eye}
                </button>
              </div>
            </div>
            <div className="canvas-field">
              <span className="canvas-field-label">
                {t("settings.canvas.fieldModel")}
                <em> · {t("settings.canvas.modelHint")}</em>
              </span>
              <input
                className="settings-input canvas-mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => void submit()}
                spellCheck={false}
              />
            </div>
            <div className="canvas-field">
              <span className="canvas-field-label">
                {t("settings.canvas.fieldPrice")}
                <em> · {t("settings.canvas.priceHint")}</em>
              </span>
              <div className="canvas-price">
                <input
                  className="settings-input"
                  value={priceText}
                  inputMode="decimal"
                  onChange={(e) => setPriceText(e.target.value)}
                  onBlur={() => void submit()}
                />
                <IosSelect
                  className="canvas-currency"
                  value={currency}
                  options={[
                    { value: "$", label: "$" },
                    { value: "¥", label: "¥" },
                  ]}
                  onChange={(v) => {
                    setCurrency(v);
                    void submit();
                  }}
                />
              </div>
            </div>
          </div>
          {error && (
            <div className="ui-error" role="alert">{error}</div>
          )}
          <div className="canvas-form-actions">
            <button
              type="button"
              className="ui-btn"
              data-testing={testing ? "1" : undefined}
              onClick={onTest}
            >
              <i className="canvas-btn-spin" />
              {Icons.activity}
              <span>{testing ? t("settings.canvas.testing") : t("settings.canvas.test")}</span>
            </button>
            <button type="button" className="ui-btn-danger" onClick={onDelete}>
              {Icons.delete}
              {t("settings.canvas.deleteChannel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 新建渠道表单（列表尾部展开） ──

function ChannelCreateForm({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  const createAiChannel = useSettingsStore((s) => s.createAiChannel);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<"openai" | "gemini">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [priceText, setPriceText] = useState("");
  const [currency, setCurrency] = useState("$");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError("");
    if (baseUrl.trim() === "") {
      setError(t("settings.canvas.baseUrlRequired"));
      return;
    }
    if (apiKey.trim() === "") {
      setError(t("settings.canvas.apiKeyRequired"));
      return;
    }
    const price = priceText.trim() === "" ? null : Number.parseFloat(priceText);
    if (priceText.trim() !== "" && (!Number.isFinite(price) || (price as number) < 0)) {
      setError(t("settings.canvas.priceInvalid"));
      return;
    }
    setSaving(true);
    try {
      const input: AiChannelInput = {
        name,
        protocol,
        baseUrl,
        apiKey: apiKey.trim(),
        model,
        price,
        currency,
      };
      await createAiChannel(input);
      onCancel();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="canvas-ch open">
      <div className="canvas-ch-body">
        <div className="canvas-form-grid">
          <div className="canvas-field">
            <span className="canvas-field-label">{t("settings.canvas.fieldName")}</span>
            <input className="settings-input" value={name} placeholder={t("settings.canvas.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="canvas-field">
            <span className="canvas-field-label">{t("settings.canvas.fieldProtocol")}</span>
          <Segmented
            value={protocol}
            options={[
              { value: "openai", label: t("settings.canvas.protocolOpenai") },
              { value: "gemini", label: t("settings.canvas.protocolGemini") },
            ]}
            onChange={setProtocol}
            ariaLabel={t("settings.canvas.fieldProtocol")}
          />
          </div>
          <div className="canvas-field full">
            <span className="canvas-field-label">
              {t("settings.canvas.fieldBaseUrl")}
              <em> · {t("settings.canvas.baseUrlHint")}</em>
            </span>
            <input className="settings-input canvas-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
          </div>
          <div className="canvas-field full">
            <span className="canvas-field-label">{t("settings.canvas.fieldApiKey")}</span>
            <input
              className="settings-input canvas-mono"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              spellCheck={false}
              autoComplete="new-password"
            />
          </div>
          <div className="canvas-field">
            <span className="canvas-field-label">
              {t("settings.canvas.fieldModel")}
              <em> · {t("settings.canvas.modelHint")}</em>
            </span>
            <input className="settings-input canvas-mono" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
          </div>
          <div className="canvas-field">
            <span className="canvas-field-label">
              {t("settings.canvas.fieldPrice")}
              <em> · {t("settings.canvas.priceHint")}</em>
            </span>
            <div className="canvas-price">
              <input className="settings-input" value={priceText} inputMode="decimal" onChange={(e) => setPriceText(e.target.value)} />
              <IosSelect
                className="canvas-currency"
                value={currency}
                options={[
                  { value: "$", label: "$" },
                  { value: "¥", label: "¥" },
                ]}
                onChange={setCurrency}
              />
            </div>
          </div>
        </div>
        {error && <div className="ui-error" role="alert">{error}</div>}
        <div className="canvas-form-actions">
          <button type="button" className="ui-btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="ui-btn-primary" disabled={saving} onClick={() => void submit()}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 生效渠道预览：按当前策略与渠道数据本地演算下次生成会用谁 ──

function RoutePreview() {
  const { t } = useTranslation();
  // 精确订阅：只挑演算要用的字段，仓库其他设置变化不触发本组件重渲染。
  const { aiChannels: channels, aiStrategy, aiBalancePriceWeight, aiManualChannelId } = useSettingsStore(
    useShallow((s) => ({
      aiChannels: s.aiChannels,
      aiStrategy: s.aiStrategy,
      aiBalancePriceWeight: s.aiBalancePriceWeight,
      aiManualChannelId: s.aiManualChannelId,
    })),
  );
  const pick = useMemo<AiChannel | null>(() => {
    const usable = channels.filter((c) => c.enabled && c.status !== "auto_disabled");
    const candidates = usable.length > 0 ? usable : [];
    if (candidates.length === 0) return null;
    switch (aiStrategy) {
      case "manual":
        return candidates.find((c) => c.id === aiManualChannelId) ?? null;
      case "latency": {
        const withLatency = candidates.filter((c) => c.lastLatencyMs != null);
        if (withLatency.length === 0) return candidates[0];
        return withLatency.reduce((a, b) => ((b.lastLatencyMs as number) < (a.lastLatencyMs as number) ? b : a));
      }
      case "price": {
        const withPrice = candidates.filter((c) => c.price != null);
        if (withPrice.length === 0) return candidates[0];
        return withPrice.reduce((a, b) => {
          const pa = (a.price as number) * (a.currency === "¥" ? 1 / 7.2 : 1);
          const pb = (b.price as number) * (b.currency === "¥" ? 1 / 7.2 : 1);
          if (pb !== pa) return pb < pa ? b : a;
          return ((b.lastLatencyMs ?? Infinity) < (a.lastLatencyMs ?? Infinity) ? b : a);
        });
      }
      case "balance": {
        const scored = candidates.map((c) => ({
          c,
          price: c.price == null ? null : c.price * (c.currency === "¥" ? 1 / 7.2 : 1),
        }));
        const prices = scored.map((s) => s.price).filter((p): p is number => p != null);
        const lats = candidates.map((c) => c.lastLatencyMs).filter((l): l is number => l != null);
        const pMin = Math.min(...(prices.length > 0 ? prices : [0]));
        const pMax = Math.max(...(prices.length > 0 ? prices : [1]));
        const lMin = Math.min(...(lats.length > 0 ? lats : [0]));
        const lMax = Math.max(...(lats.length > 0 ? lats : [1]));
        const norm = (v: number, min: number, max: number) =>
          max > min ? (v - min) / (max - min) : 0.5;
        const w = aiBalancePriceWeight / 100;
        return scored
          .map(({ c, price }) => {
            const priceScore = price == null ? 1 : norm(price, pMin, pMax);
            const latScore = c.lastLatencyMs == null ? 1 : norm(c.lastLatencyMs, lMin, lMax);
            return { c, score: priceScore * w + latScore * (1 - w) };
          })
          .reduce((a, b) => (b.score < a.score ? b : a)).c;
      }
    }
  }, [channels, aiStrategy, aiBalancePriceWeight, aiManualChannelId]);

  const desc = (c: AiChannel): string => {
    const parts: string[] = [];
    if (c.price != null) parts.push(`${c.currency}${c.price}/${t("settings.canvas.perImage")}`);
    if (c.lastLatencyMs != null) parts.push(`${c.lastLatencyMs} ms`);
    return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  };

  return (
    <div className="canvas-route">
      {Icons.route}
      {pick ? (
        <span>
          {t("settings.canvas.routePrefix")}
          <b>{pick.name}</b>
          <span>{desc(pick)}</span>
        </span>
      ) : (
        <span>{t("settings.canvas.routeEmpty")}</span>
      )}
    </div>
  );
}

// ── 页面主体 ──

export function CanvasSettings() {
  const { t } = useTranslation();
  // 精确订阅：逐字段挑本页实际用到的数据与动作，仓库其他设置变化
  //（如剪切板、径向菜单）不再触发整页重渲染。
  const settings = useSettingsStore(
    useShallow((s) => ({
      aiChannels: s.aiChannels,
      aiStrategy: s.aiStrategy,
      aiBalancePriceWeight: s.aiBalancePriceWeight,
      aiFailover: s.aiFailover,
      aiAutoDisableAuth: s.aiAutoDisableAuth,
      aiRateLimitCooldown: s.aiRateLimitCooldown,
      aiConcurrency: s.aiConcurrency,
      aiManualChannelId: s.aiManualChannelId,
      aiModel: s.aiModel,
      aiTimeout: s.aiTimeout,
      saveAiScheduling: s.saveAiScheduling,
      testAiChannel: s.testAiChannel,
      loadAiChannels: s.loadAiChannels,
      reorderAiChannels: s.reorderAiChannels,
      setAiChannelEnabled: s.setAiChannelEnabled,
      deleteAiChannel: s.deleteAiChannel,
      saveAiSettings: s.saveAiSettings,
    })),
  );
  const {
    aiChannels: channels,
    aiStrategy,
    aiBalancePriceWeight,
    aiFailover,
    aiAutoDisableAuth,
    aiRateLimitCooldown,
    aiConcurrency,
    aiManualChannelId,
    aiModel,
    aiTimeout,
  } = settings;
  // 互斥手风琴：同一时间只展开一条渠道（null = 全部收起；"__new__" = 新建表单）。
  const [expanded, setExpanded] = useState<string | null>(null);
  // 测速进行中的渠道集合与「全部测速」进度（null = 空闲）。
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testAllProgress, setTestAllProgress] = useState<{ done: number; total: number } | null>(null);
  // 权重滑杆拖动中的草稿值（null = 空闲）：拖动只更新本地预览，
  // 松手/松键/失焦才落库，避免拖一次写几十条设置。
  const [weightDraft, setWeightDraft] = useState<number | null>(null);
  // 待删除确认的渠道（删除会连带 Key，走应用内确认对话框）。
  const [pendingDelete, setPendingDelete] = useState<AiChannel | null>(null);

  const commitWeight = async () => {
    if (weightDraft == null) return;
    const value = weightDraft;
    setWeightDraft(null);
    await settings.saveAiScheduling({ aiBalancePriceWeight: value });
  };

  const runTest = async (id: string) => {
    if (testingIds.has(id)) return;
    setTestingIds((prev) => new Set(prev).add(id));
    try {
      await settings.testAiChannel(id);
    } catch (e) {
      console.error("Channel speed test failed:", e);
    } finally {
      setTestingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // 全部测速：并发 2 逐条跑完启用渠道，按钮显示进度。
  const runTestAll = async () => {
    if (testAllProgress) return;
    const targets = channels.filter((c) => c.enabled);
    if (targets.length === 0) return;
    const total = targets.length;
    setTestAllProgress({ done: 0, total });
    let done = 0;
    const queue = [...targets];
    const worker = async () => {
      while (queue.length > 0) {
        const channel = queue.shift();
        if (!channel) break;
        await runTest(channel.id);
        done += 1;
        setTestAllProgress({ done, total });
      }
    };
    await Promise.all([worker(), worker()]);
    setTestAllProgress(null);
  };

  useEffect(() => {
    void settings.loadAiChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = channels.findIndex((c) => c.id === active.id);
    const newIndex = channels.findIndex((c) => c.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    void settings.reorderAiChannels(arrayMove(channels.map((c) => c.id), oldIndex, newIndex));
  };

  // 本地数值输入（并发/冷却/超时）：失焦钳制提交，与既有 AI 设置同惯例。
  // 文本状态跟随 store 装载同步：设置可能在组件挂载后才异步就绪，不同步
  // 会把装载到的真实值在下次失焦时覆盖回默认值。
  const [cooldownText, setCooldownText] = useState(String(aiRateLimitCooldown));
  const [concurrencyText, setConcurrencyText] = useState(String(aiConcurrency));
  const [timeoutText, setTimeoutText] = useState(String(aiTimeout));
  const [modelText, setModelText] = useState(aiModel);
  useEffect(() => setCooldownText(String(aiRateLimitCooldown)), [aiRateLimitCooldown]);
  useEffect(() => setConcurrencyText(String(aiConcurrency)), [aiConcurrency]);
  useEffect(() => setTimeoutText(String(aiTimeout)), [aiTimeout]);
  useEffect(() => setModelText(aiModel), [aiModel]);

  const enabledChannels = channels.filter((c) => c.enabled);

  return (
    <div className="canvas-settings">
      {/* ── 1. 生成服务渠道 ── */}
      <div className="canvas-sec">
        <div className="canvas-sec-title">
          <span>{t("settings.canvas.channelsTitle")}</span>
          <button
            type="button"
            className="ui-btn"
            data-testing={testAllProgress ? "1" : undefined}
            disabled={channels.filter((c) => c.enabled).length === 0}
            onClick={() => void runTestAll()}
          >
            <i className="canvas-btn-spin" />
            {Icons.activity}
            <span>
              {testAllProgress
                ? t("settings.canvas.testAllProgress", { done: testAllProgress.done, total: testAllProgress.total })
                : t("settings.canvas.testAll")}
            </span>
          </button>
        </div>
        <p className="ui-sub">{t("settings.canvas.channelsNote")}</p>
        <div className="settings-card canvas-channel-card">
          {channels.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext items={channels.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                {channels.map((channel) => (
                  <ChannelRow
                    key={channel.id}
                    channel={channel}
                    open={expanded === channel.id}
                    testing={testingIds.has(channel.id)}
                    onToggle={() => setExpanded(expanded === channel.id ? null : channel.id)}
                    onEnabledChange={(enabled) => void settings.setAiChannelEnabled(channel.id, enabled)}
                    onDelete={() => setPendingDelete(channel)}
                    onTest={() => void runTest(channel.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            <div className="canvas-ch-empty">{t("settings.canvas.emptyHint")}</div>
          )}
          {expanded === "__new__" ? (
            <ChannelCreateForm onCancel={() => setExpanded(null)} />
          ) : (
            <button type="button" className="canvas-ch-add" onClick={() => setExpanded("__new__")}>
              {Icons.add}
              {t("settings.canvas.addChannel")}
            </button>
          )}
        </div>
      </div>

      {/* 删除渠道确认：连带 Base URL 与 Key 且不可撤销 */}
      {pendingDelete && (
        <ConfirmDialog
          message={t("settings.canvas.deleteConfirm", { name: pendingDelete.name })}
          hint={t("settings.canvas.deleteConfirmHint")}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            if (expanded === pendingDelete.id) setExpanded(null);
            void settings.deleteAiChannel(pendingDelete.id);
          }}
        />
      )}

      {/* ── 2. 自动调度 ── */}
      <div className="canvas-sec">
        <div className="canvas-sec-title"><span>{t("settings.canvas.strategyTitle")}</span></div>
        <p className="ui-sub">{t("settings.canvas.strategyNote")}</p>
        <div className="settings-card">
          {(
            [
              ["manual", t("settings.canvas.strategyManual"), t("settings.canvas.strategyManualDesc")],
              ["latency", t("settings.canvas.strategyLatency"), t("settings.canvas.strategyLatencyDesc")],
              ["price", t("settings.canvas.strategyPrice"), t("settings.canvas.strategyPriceDesc")],
              ["balance", t("settings.canvas.strategyBalance"), t("settings.canvas.strategyBalanceDesc")],
            ] as [AiStrategy, string, string][]
          ).map(([key, label, desc]) => (
            <button
              key={key}
              type="button"
              className={`canvas-strategy${aiStrategy === key ? " on" : ""}`}
              onClick={() => void settings.saveAiScheduling({ aiStrategy: key })}
            >
              <span className="canvas-radio" />
              <span className="canvas-st-main">
                <span className="canvas-st-name">{label}</span>
                <span className="canvas-st-desc ui-sub">{desc}</span>
              </span>
            </button>
          ))}
          {aiStrategy === "manual" && (
            <div className="canvas-st-extra">
              <IosSelect
                className="canvas-st-select"
                value={aiManualChannelId}
                disabled={enabledChannels.length === 0}
                placeholder={t("settings.canvas.noEnabledChannels")}
                options={enabledChannels.map((c) => ({
                  value: c.id,
                  label:
                    c.name +
                    (c.price != null ? `（${c.currency}${c.price}/${t("settings.canvas.perImage")}` : "") +
                    (c.lastLatencyMs != null ? ` · ${c.lastLatencyMs} ms）` : c.price != null ? "）" : ""),
                }))}
                onChange={(v) => void settings.saveAiScheduling({ aiManualChannelId: v })}
              />
            </div>
          )}
          {aiStrategy === "balance" && (
            <div className="canvas-st-extra">
              <div className="canvas-slider-row">
                <span className="canvas-slider-cap">{t("settings.canvas.preferPrice")}</span>
                <div className="canvas-slider-mid">
                  <input
                    type="range"
                    className="ui-slider"
                    min={0}
                    max={100}
                    value={weightDraft ?? aiBalancePriceWeight}
                    onChange={(e) => setWeightDraft(Number(e.target.value))}
                    onPointerUp={() => void commitWeight()}
                    onKeyUp={() => void commitWeight()}
                    onBlur={() => void commitWeight()}
                  />
                </div>
                <span className="canvas-slider-cap">{t("settings.canvas.preferLatency")}</span>
                <span className="canvas-slider-val">
                  {t("settings.canvas.weightPrice", { p: weightDraft ?? aiBalancePriceWeight, l: 100 - (weightDraft ?? aiBalancePriceWeight) })}
                </span>
              </div>
            </div>
          )}
          <RoutePreview />
        </div>
      </div>

      {/* ── 3. 故障处理 ── */}
      <div className="canvas-sec">
        <div className="canvas-sec-title"><span>{t("settings.canvas.faultTitle")}</span></div>
        <div className="settings-card">
          <div className="canvas-row">
            <div className="canvas-row-main">
              <div className="canvas-row-label">{t("settings.canvas.failover")}</div>
              <div className="ui-sub">{t("settings.canvas.failoverHint")}</div>
            </div>
            <Toggle
              checked={aiFailover}
              onChange={(next) => void settings.saveAiScheduling({ aiFailover: next })}
              ariaLabel={t("settings.canvas.failover")}
            />
          </div>
          <div className="canvas-row">
            <div className="canvas-row-main">
              <div className="canvas-row-label">{t("settings.canvas.autoDisable")}</div>
              <div className="ui-sub">{t("settings.canvas.autoDisableHint")}</div>
            </div>
            <Toggle
              checked={aiAutoDisableAuth}
              onChange={(next) => void settings.saveAiScheduling({ aiAutoDisableAuth: next })}
              ariaLabel={t("settings.canvas.autoDisable")}
            />
          </div>
          <div className="canvas-row">
            <div className="canvas-row-main">
              <div className="canvas-row-label">{t("settings.canvas.cooldown")}</div>
              <div className="ui-sub">{t("settings.canvas.cooldownHint")}</div>
            </div>
            <input
              className="settings-input canvas-w-md"
              value={cooldownText}
              inputMode="numeric"
              onChange={(e) => setCooldownText(e.target.value)}
              onBlur={() => {
                const n = Number.parseInt(cooldownText, 10);
                const secs = Number.isFinite(n) ? Math.min(3600, Math.max(5, n)) : 300;
                setCooldownText(String(secs));
                void settings.saveAiScheduling({ aiRateLimitCooldown: secs });
              }}
            />
            <span className="canvas-suffix">{t("settings.canvas.seconds")}</span>
          </div>
        </div>
      </div>

      {/* ── 4. 生成默认值 ── */}
      <div className="canvas-sec">
        <div className="canvas-sec-title"><span>{t("settings.canvas.defaultsTitle")}</span></div>
        <p className="ui-sub">{t("settings.canvas.defaultsNote")}</p>
        <div className="settings-card">
          <div className="canvas-row">
            <div className="canvas-row-main"><div className="canvas-row-label">{t("settings.canvas.defaultModel")}</div></div>
            <input
              className="settings-input canvas-mono canvas-w-lg"
              value={modelText}
              placeholder={t("settings.canvas.modelPlaceholder")}
              onChange={(e) => setModelText(e.target.value)}
              onBlur={() => void settings.saveAiSettings({ aiModel: modelText.trim() })}
              spellCheck={false}
            />
          </div>
          <div className="canvas-row">
            <div className="canvas-row-main">
              <div className="canvas-row-label">{t("settings.canvas.concurrency")}</div>
              <div className="ui-sub">{t("settings.canvas.concurrencyHint")}</div>
            </div>
            <input
              className="settings-input canvas-w-sm"
              value={concurrencyText}
              inputMode="numeric"
              onChange={(e) => setConcurrencyText(e.target.value)}
              onBlur={() => {
                const n = Number.parseInt(concurrencyText, 10);
                const v = Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 4;
                setConcurrencyText(String(v));
                void settings.saveAiScheduling({ aiConcurrency: v });
              }}
            />
          </div>
          <div className="canvas-row">
            <div className="canvas-row-main"><div className="canvas-row-label">{t("settings.canvas.timeout")}</div></div>
            <input
              className="settings-input canvas-w-md"
              value={timeoutText}
              inputMode="numeric"
              onChange={(e) => setTimeoutText(e.target.value)}
              onBlur={() => {
                const n = Number.parseInt(timeoutText, 10);
                const v = Number.isFinite(n) ? Math.min(600, Math.max(5, n)) : 300;
                setTimeoutText(String(v));
                void settings.saveAiSettings({ aiTimeout: v });
              }}
            />
            <span className="canvas-suffix">{t("settings.canvas.seconds")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
