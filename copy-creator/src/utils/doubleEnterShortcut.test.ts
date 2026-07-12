import { describe, expect, it } from "vitest";
import { resolveDoubleEnterSave } from "./doubleEnterShortcut";

describe("clipboard create double-enter shortcut", () => {
  it("keeps the first Enter as a newline and records its time", () => {
    expect(resolveDoubleEnterSave({
      key: "Enter",
      hasContent: true,
      lastEnterAt: 0,
      now: 1000,
    })).toEqual({
      shouldSave: false,
      shouldPreventDefault: false,
      nextLastEnterAt: 1000,
    });
  });

  it("saves on the second quick plain Enter", () => {
    expect(resolveDoubleEnterSave({
      key: "Enter",
      hasContent: true,
      lastEnterAt: 1000,
      now: 1350,
    })).toEqual({
      shouldSave: true,
      shouldPreventDefault: true,
      nextLastEnterAt: 0,
    });
  });

  it("does not save when the second Enter is too slow", () => {
    expect(resolveDoubleEnterSave({
      key: "Enter",
      hasContent: true,
      lastEnterAt: 1000,
      now: 1700,
    })).toEqual({
      shouldSave: false,
      shouldPreventDefault: false,
      nextLastEnterAt: 1700,
    });
  });

  it("ignores modified or composing Enter presses", () => {
    expect(resolveDoubleEnterSave({
      key: "Enter",
      hasContent: true,
      lastEnterAt: 1000,
      now: 1200,
      shiftKey: true,
    }).shouldSave).toBe(false);

    expect(resolveDoubleEnterSave({
      key: "Enter",
      hasContent: true,
      lastEnterAt: 1000,
      now: 1200,
      isComposing: true,
    }).shouldSave).toBe(false);
  });

  it("does not save empty content", () => {
    expect(resolveDoubleEnterSave({
      key: "Enter",
      hasContent: false,
      lastEnterAt: 1000,
      now: 1200,
    })).toEqual({
      shouldSave: false,
      shouldPreventDefault: false,
      nextLastEnterAt: 0,
    });
  });
});
