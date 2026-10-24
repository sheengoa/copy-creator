import { describe, expect, it } from "vitest";
import { textVersionSourceKey, type ResourceTextVersion } from "./textVersions";

function version(source: ResourceTextVersion["source"]): ResourceTextVersion {
  return {
    id: "rtv-1",
    recordId: "rec-1",
    byteSize: 12,
    source,
    createdAt: "2026-10-23T10:00:00+08:00",
  };
}

describe("textVersionSourceKey", () => {
  it("maps every source to a distinct i18n key", () => {
    const keys = (["init", "edit", "external", "restore"] as const).map(textVersionSourceKey);
    expect(new Set(keys).size).toBe(4);
    expect(textVersionSourceKey("edit")).toBe("resources.verSourceEdit");
    expect(textVersionSourceKey("init")).toBe("resources.verSourceInit");
    expect(textVersionSourceKey("external")).toBe("resources.verSourceExternal");
    expect(textVersionSourceKey("restore")).toBe("resources.verSourceRestore");
  });

  it("falls back to the edit label for unknown sources", () => {
    expect(textVersionSourceKey("unknown" as ResourceTextVersion["source"])).toBe(
      "resources.verSourceEdit",
    );
  });
});

describe("ResourceTextVersion shape", () => {
  it("carries byte size and source for list rendering", () => {
    const entry = version("external");
    expect(entry.byteSize).toBe(12);
    expect(entry.source).toBe("external");
  });
});
