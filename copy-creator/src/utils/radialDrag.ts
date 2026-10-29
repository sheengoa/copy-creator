export type RadialDragKind = "files" | "none";
export type RadialDragSource = "clipboard" | "phrase" | "group" | "selection";

export function getClipboardRadialDragKind(
  type: string,
  hasImages = false,
): RadialDragKind {
  return type === "image" || type === "file" || hasImages ? "files" : "none";
}

export function getPhraseRadialDragKind(inputType: "text" | "file"): RadialDragKind {
  return inputType === "file" ? "files" : "none";
}
