import { describe, expect, it } from "vitest";
import {
  annotationsForChunk,
  buildAnnotatedSegments,
  validateAnnotations,
  type ResourceAnnotation,
} from "./annotations";

function ann(
  id: string,
  start: number,
  length: number,
  kind: ResourceAnnotation["kind"],
  anchorText = "x",
): ResourceAnnotation {
  return { id, recordId: "rec", start, length, kind, anchorText, createdAt: "" };
}

describe("validateAnnotations", () => {
  it("flags annotations whose anchor text no longer matches the content", () => {
    const text = "铃响七次，你就该想起自己是谁。";
    const [ok, drifted] = validateAnnotations(text, [
      ann("a", 0, 4, "hl-y", "铃响七次"),
      ann("b", 5, 3, "bold", "早已偏离"),
    ]);
    expect(ok.stale).toBe(false);
    expect(drifted.stale).toBe(true);
  });

  it("marks out-of-bounds annotations as stale", () => {
    const [oob] = validateAnnotations("短文", [ann("a", 10, 4, "bold", "短文")]);
    expect(oob.stale).toBe(true);
  });
});

describe("buildAnnotatedSegments", () => {
  it("returns a single plain segment without annotations", () => {
    expect(buildAnnotatedSegments("普通文本", [])).toEqual([
      { text: "普通文本", kinds: [] },
    ]);
  });

  it("splits overlapping annotations into atomic segments that reassemble losslessly", () => {
    const text = "山雾还未散尽，铃响七次，想起自己。";
    const segments = buildAnnotatedSegments(text, [
      ann("a", 0, 6, "hl-y"),
      ann("b", 6, 4, "hl-g", ""),
      ann("c", 7, 3, "bold"),
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    const kindsAt = (i: number) => segments[i].kinds;
    expect(kindsAt(0)).toEqual(["hl-y"]);
    // 第二段（铃 + 想起之间）同时被绿与加粗覆盖 → 两种类型聚合。
    expect(kindsAt(2).sort()).toEqual(["bold", "hl-g"]);
    expect(segments.every((s) => s.text.length > 0)).toBe(true);
  });

  it("ignores stale annotations when rendering", () => {
    const [drifted] = validateAnnotations("正文", [ann("a", 0, 2, "hl-y", "别的")]);
    expect(buildAnnotatedSegments("正文", [drifted])).toEqual([
      { text: "正文", kinds: [] },
    ]);
  });

  it("clamps annotations that extend beyond the text bounds", () => {
    const segments = buildAnnotatedSegments("短文", [ann("a", 1, 999, "bold")]);
    expect(segments.map((s) => s.text).join("")).toBe("短文");
    expect(segments[1].kinds).toEqual(["bold"]);
  });
});

describe("annotationsForChunk", () => {
  it("shifts and clips global annotations into the chunk coordinate space", () => {
    const list = [
      ann("a", 0, 100, "hl-y"),
      ann("b", 90, 20, "bold"),
      ann("c", 150, 10, "underline"),
    ];
    // 块 [50, 150)：a 尾部裁到 50、b 跨块平移到 40 起、c 完全在块外。
    const shifted = annotationsForChunk(list, 50, 100);
    expect(shifted).toHaveLength(2);
    expect(shifted[0]).toMatchObject({ id: "a", start: 0, length: 50 });
    expect(shifted[1]).toMatchObject({ id: "b", start: 40, length: 20 });
  });

  it("skips stale annotations", () => {
    const [stale] = validateAnnotations("别的正文", [ann("a", 0, 5, "hl-y")]);
    expect(annotationsForChunk([stale], 0, 100)).toHaveLength(0);
  });
});
