import { describe, expect, it } from "vitest";
import {
  getPasteActionForMouseTrigger,
  getPrimaryPasteKind,
  getSecondaryPasteKind,
  shouldUseTerminalPaste,
  shouldUseTerminalPasteForMouseTrigger,
} from "./pasteMode";

describe("paste mode routing", () => {
  it("uses normal paste for primary click by default", () => {
    expect(getPrimaryPasteKind("normal")).toBe("normal");
    expect(shouldUseTerminalPaste("normal", "primary")).toBe(false);
  });

  it("uses terminal paste for primary click when configured", () => {
    expect(getPrimaryPasteKind("terminal")).toBe("terminal");
    expect(shouldUseTerminalPaste("terminal", "primary")).toBe(true);
  });

  it("uses the opposite mode for secondary actions", () => {
    expect(getSecondaryPasteKind("normal")).toBe("terminal");
    expect(getSecondaryPasteKind("terminal")).toBe("normal");
    expect(shouldUseTerminalPaste("normal", "secondary")).toBe(true);
    expect(shouldUseTerminalPaste("terminal", "secondary")).toBe(false);
  });

  it("maps mouse triggers to the expected paste action", () => {
    expect(getPasteActionForMouseTrigger("left")).toBe("primary");
    expect(getPasteActionForMouseTrigger("left-shift")).toBe("secondary");
    expect(getPasteActionForMouseTrigger("right")).toBe("secondary");
  });

  it("routes mouse triggers through the configured left-click mode", () => {
    expect(shouldUseTerminalPasteForMouseTrigger("terminal", "left")).toBe(true);
    expect(shouldUseTerminalPasteForMouseTrigger("terminal", "right")).toBe(false);
    expect(shouldUseTerminalPasteForMouseTrigger("normal", "left")).toBe(false);
    expect(shouldUseTerminalPasteForMouseTrigger("normal", "right")).toBe(true);
  });
});
