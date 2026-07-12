export type PasteMode = "normal" | "terminal";
export type PasteAction = "primary" | "secondary";
export type PasteMouseTrigger = "left" | "left-shift" | "right";

export function getPrimaryPasteKind(mode: PasteMode): PasteMode {
  return mode;
}

export function getSecondaryPasteKind(mode: PasteMode): PasteMode {
  return mode === "terminal" ? "normal" : "terminal";
}

export function shouldUseTerminalPaste(
  mode: PasteMode,
  action: PasteAction,
): boolean {
  const pasteKind =
    action === "primary" ? getPrimaryPasteKind(mode) : getSecondaryPasteKind(mode);
  return pasteKind === "terminal";
}

export function getPasteActionForMouseTrigger(
  trigger: PasteMouseTrigger,
): PasteAction {
  return trigger === "left" ? "primary" : "secondary";
}

export function shouldUseTerminalPasteForMouseTrigger(
  mode: PasteMode,
  trigger: PasteMouseTrigger,
): boolean {
  return shouldUseTerminalPaste(mode, getPasteActionForMouseTrigger(trigger));
}
