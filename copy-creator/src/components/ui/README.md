# UI 控件基准

设置窗口（含画布分类）所有交互控件的统一基准，2026-11 收敛定稿。**新功能实现控件时必须复用本目录组件与 `styles/ui.css` 的 `ui-*` 类，禁止再手写第二套开关/分段/按钮/滑杆**——由 `src/testing/architectureGuard.test.ts` 的守卫规则锁定。

视觉规格以 2026-11-01 用户确认的控件基准稿为准（开关 = 通用页 40×24 样式，下拉框 = 剪切板页 IosSelect，分段 = 通用页灰槽白卡）。

## 组件清单

| 控件 | 组件 | 样式 | 要点 |
|---|---|---|---|
| 开关 | `Toggle` | `.ui-switch`（ui.css） | 40×24；亮色开态 #333、暗色开态白；`role="switch"`；在可点击行内嵌套时用 `onClick` 阻断冒泡 |
| 下拉框 | `IosSelect` | `.ios-select-*`（components.css） | 触发器 h30 + 弹出面板（选中淡蓝 + 对勾）；支持 `className`（窄宽度）与 `disabled`；样式为既有跨页共享实现，保持原位 |
| 分段 | `Segmented` | `.ui-seg`（ui.css） | 灰槽 + 白卡浮起；全部选项统一正文字体；泛型 `<T extends string>` |
| 悬停提示 | `InfoTip` | `.ui-info-tip`（ui.css） | 行尾 ⓘ，原生 title；设置页静态说明必须用它（架构守卫规则 22），不得新增可见 hint 元素 |
| 软灰按钮 | — | `.ui-btn` | h28，次要动作（测试、录制、更换文件夹、重置） |
| 凸起主按钮 | — | `.ui-btn-primary` | h30，表单内主操作；SaveBar 通宽保存用 `settings-save-btn`（settings.css，专属形态） |
| 危险按钮 | — | `.ui-btn-danger` | 红字幽灵，删除类动作 |
| 滑杆 | — | `.ui-slider` | 轨道 r999 + thumb 18 白 + 按压缩放 1.12；宽度默认 100%，由容器约束 |
| 说明行 | — | `.ui-sub` | 10.5px secondary，控件/字段下的可见说明 |
| 错误文字 | — | `.ui-error` | 10.5px danger，表单错误反馈 |

## 输入框

`settings-input` / `settings-textarea`（settings.css）是输入类基准：h32 / 圆角 8 / `--card-border` + `--input-bg`，全设置页已统一，不在此重复定义。

## 选项列表（带描述）

每项需要带描述的多选一（如调度策略的手动/延迟/价格/综合）使用 `.canvas-strategy` 行结构（settings.css：radio 圆点自绘 + 选中灰行 + 深色圆点填充，与开关开态同语言），属于基准控件之一；纯标签式多选一（2-4 个短选项）一律用 `Segmented`。

## 语义色

控件色值一律引用 token（base.css）：`--accent` / `--danger` / `--success` / `--warning` 及其浅底衍生 `--success-bg` / `--warning-bg` / `--warning-border`，加既有表面/文字 token，禁止在控件里硬编码 hex。

**蓝色的角色边界（2026-11 与用户对齐）**：accent 蓝只作交互反馈色——悬停、聚焦、测速中、下拉展开与选中项；静态界面与选中态一律黑白灰（选中=白卡/灰行+深色填充，与开关开态同语言）。协议身份标签（OpenAI 蓝 / Gemini 橙）与延迟徽标等语义标识色除外。

## 历史映射（2026-11 统一，旧类已退役）

- `toggle-switch` / `canvas-switch` / 备份页裸 checkbox → `Toggle`
- `settings-lang-toggle` / `lang-toggle-btn`、`canvas-pills` / `canvas-pill` → `Segmented`
- `settings-btn-soft` / `settings-storage-btn` / `shortcut-record-btn` / `radial-scale-reset` → `.ui-btn`
- `settings-btn-raised` → `.ui-btn-primary`
- `settings-btn-danger` → `.ui-btn-danger`
- `radial-scale-slider` / `canvas-slider` → `.ui-slider`
- `canvas-row-sub` / `canvas-sec-note` / `canvas-st-desc` → `.ui-sub`
- `settings-shortcut-error` / `canvas-form-error` → `.ui-error`
- `settings/InfoTip.tsx` → `ui/InfoTip.tsx`（类名 `settings-info-tip` → `ui-info-tip`）
- `components/IosSelect.tsx` → `ui/IosSelect.tsx`（类名与样式不变）
