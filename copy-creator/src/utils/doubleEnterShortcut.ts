const DOUBLE_ENTER_SAVE_INTERVAL_MS = 500;

interface DoubleEnterSaveInput {
  key: string;
  hasContent: boolean;
  lastEnterAt: number;
  now: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

interface DoubleEnterSaveResult {
  shouldSave: boolean;
  shouldPreventDefault: boolean;
  nextLastEnterAt: number;
}

export function resolveDoubleEnterSave({
  key,
  hasContent,
  lastEnterAt,
  now,
  ctrlKey = false,
  metaKey = false,
  altKey = false,
  shiftKey = false,
  isComposing = false,
}: DoubleEnterSaveInput): DoubleEnterSaveResult {
  if (key !== "Enter" || ctrlKey || metaKey || altKey || shiftKey || isComposing) {
    return {
      shouldSave: false,
      shouldPreventDefault: false,
      nextLastEnterAt: 0,
    };
  }

  if (!hasContent) {
    return {
      shouldSave: false,
      shouldPreventDefault: false,
      nextLastEnterAt: 0,
    };
  }

  if (lastEnterAt > 0 && now - lastEnterAt <= DOUBLE_ENTER_SAVE_INTERVAL_MS) {
    return {
      shouldSave: true,
      shouldPreventDefault: true,
      nextLastEnterAt: 0,
    };
  }

  return {
    shouldSave: false,
    shouldPreventDefault: false,
    nextLastEnterAt: now,
  };
}
