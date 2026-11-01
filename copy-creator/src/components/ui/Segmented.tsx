interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** 无可见标题时的无障碍名称 */
  ariaLabel?: string;
}

// 设置页分段控件基准：灰槽 + 白卡浮起（--seg-* token，亮暗自动适配）。
// 纯标签式多选一用它；每项需要带描述时用行式选项列表（见 README）。
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div className="ui-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={`ui-seg-item${option.value === value ? " active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
