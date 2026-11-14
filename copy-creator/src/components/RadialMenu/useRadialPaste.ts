// 径向菜单粘贴子系统：单条/多条合并粘贴、整组粘贴与收藏切换。
// 自 index.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）；resetState
// 与 resourceGroupRef 由 index 注入（粘贴前收起菜单、整组粘贴作用当前
// 分组），粘贴路由事实标准是 clipboardStore.runPaste / phraseStore 的
// 各 paste 动作，本模块只做选区归类与编排。

import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardStore } from "../../stores/clipboardStore";
import { usePhraseStore, ALL_PHRASES_GROUP_ID } from "../../stores/phraseStore";
import { resolveAbsoluteResourcePath } from "../../domain/mediaUrl";
import { readTextFileContent } from "../../domain/mediaAssets";
import { inferResourceMediaKind } from "../../domain/mediaKind";
import {
  classifyMultiPastePhrase,
  classifyMultiPasteRecord,
  getResourcePath,
  isFileBackedTextResource,
  isResourceRecord,
} from "../../domain/records";
import type { ClipboardRecord, Phrase } from "../../types";
import { flog } from "./radialShared";

export function useRadialPaste({
  resetState,
  resourceGroupRef,
}: {
  resetState: (preserveClickSuppression?: boolean) => void;
  resourceGroupRef: { current: string | null };
}) {
  const handleItemPaste = useCallback(async (itemIds: string | string[], terminal = false) => {
    // 先收起菜单再触发粘贴：后端的焦点沉降等待与窗口隐藏并行，
    // 点击到粘贴落地的延迟显著降低（原来串行等待粘贴命令返回后才隐藏）。
    resetState();
    void invoke("hide_radial_menu");
    const ids = Array.isArray(itemIds) ? itemIds : [itemIds];

    if (ids.length > 1) {
      const clipboard = useClipboardStore.getState();
      const phraseStore = usePhraseStore.getState();
      const recordsById = new Map(clipboard.records.map((record) => [record.id, record]));
      const phrasesById = new Map(phraseStore.phrases.map((phrase) => [phrase.id, phrase]));
      const records = ids
        .map((id) => recordsById.get(id))
        .filter((record): record is ClipboardRecord => Boolean(record));
      const phrases = ids
        .map((id) => phrasesById.get(id))
        .filter((phrase): phrase is Phrase => Boolean(phrase));

      // 逐条按域层归类（保持选择顺序）：文本类稍后读内容合并，文件类
      // 收集路径。任一条目在 store 中找不到（已删除/未加载）或不可归并
      // （图文暂存）时整体退回逐条粘贴兜底。
      let classifiable = true;
      const textEntries: Array<{ origin: "record" | "phrase"; id: string }> = [];
      const filePaths: string[] = [];
      for (const id of ids) {
        const record = recordsById.get(id);
        if (record) {
          if (classifyMultiPasteRecord(record) === "text") {
            textEntries.push({ origin: "record", id });
          } else {
            filePaths.push(getResourcePath(record));
          }
          continue;
        }
        const phrase = phrasesById.get(id);
        if (phrase) {
          if (classifyMultiPastePhrase(phrase) === "text") {
            textEntries.push({ origin: "phrase", id });
          } else {
            filePaths.push(phrase.content);
          }
          continue;
        }
        classifiable = false;
        break;
      }

      // 文本部分按选择顺序取全文：文件承载的文本资源读文件内容（读取
      // 失败时整体退兜底），其余用记录全文；快捷输入短语用其正文。
      const assembleTextParts = async (): Promise<string[] | null> => {
        const parts: string[] = [];
        for (const entry of textEntries) {
          try {
            if (entry.origin === "record") {
              const record = recordsById.get(entry.id);
              if (!record) return null;
              parts.push(isFileBackedTextResource(record)
                ? await readTextFileContent(getResourcePath(record))
                : await clipboard.getRecordContent(record));
            } else {
              const phrase = phrasesById.get(entry.id);
              if (!phrase) return null;
              parts.push(phrase.content);
            }
          } catch (error) {
            console.error("Failed to read text content for multi-paste:", error);
            return null;
          }
        }
        return parts;
      };

      if (classifiable) {
        try {
          if (filePaths.length === 0) {
            // 纯文本合并。短语专属入口才会展开占位符：混入剪切板记录时
            // 内容必须原样粘贴（占位符可能就是记录正文的一部分），统一
            // 走 paste_text；纯短语选择保持 paste_phrase_text 语义。
            const parts = await assembleTextParts();
            if (parts === null) throw new Error("selected text items unavailable");
            const phraseOnly = textEntries.every((entry) => entry.origin === "phrase");
            if (phraseOnly) {
              await invoke("paste_phrase_text", { text: parts.join("\n"), terminal });
            } else {
              await invoke(terminal ? "paste_text_terminal" : "paste_text", {
                text: parts.join("\n"),
              });
            }
          } else {
            const resolvedPaths = await Promise.all(filePaths.map(resolveAbsoluteResourcePath));
            if (textEntries.length === 0) {
              await invoke("paste_files", { paths: resolvedPaths });
            } else {
              const parts = await assembleTextParts();
              if (parts === null) throw new Error("selected text items unavailable");
              // 混合选区串行两贴：目标应用只认领剪切板中的一种格式，
              // 先落地文件列表再落地合并文本，任何目标里两者都能出来。
              await invoke("paste_files_then_text", {
                paths: resolvedPaths,
                text: parts.join("\n"),
              });
            }
          }
          if (records.length > 0) {
            void invoke("touch_clipboard_usage", { ids: records.map((record) => record.id) }).catch((error) => {
              console.error("Failed to update selected clipboard usage:", error);
            });
          }
          if (phrases.length > 0) {
            void Promise.all(phrases.map((phrase) => invoke("touch_phrase_usage", { id: phrase.id })))
              .then(() => phraseStore.loadPhrases(
                phraseStore.selectedGroupId ?? ALL_PHRASES_GROUP_ID,
              ))
              .catch((error) => {
                console.error("Failed to update selected phrase usage:", error);
              });
          }
          return;
        } catch (error) {
          console.error("Failed to paste selected radial items:", error);
        }
      }
    }

    for (const [index, itemId] of ids.entries()) {
      if (index > 0) await new Promise((resolve) => window.setTimeout(resolve, 1500));
      const clipboard = useClipboardStore.getState();
      const record = clipboard.records.find((r) => r.id === itemId);
      if (record) {
        const copied = await (terminal
          ? clipboard.pasteRecordTerminal(record)
          : clipboard.pasteRecord(record));
        // 菜单已按设计隐藏，无法就地反馈；失败必须留痕（否则用户拿旧内容误贴）。
        if (!copied) flog(`paste-failed record=${itemId} terminal=${terminal}`);
      } else {
        const phraseStore = usePhraseStore.getState();
        const phrase = phraseStore.phrases.find((p) => p.id === itemId);
        if (phrase) {
          await (terminal
            ? phraseStore.pastePhraseTerminal(phrase)
            : phraseStore.pastePhrase(phrase));
        }
      }
    }
  }, [resetState]);

  // 整组粘贴（方案 A）：分组内全部为文本时合并为一段文本粘贴，
  // 否则把分组内全部文件按文件列表一次写入剪切板再模拟 Ctrl+V。
  // groupPath 为 null 时作用于当前选中的分组。
  const handlePasteGroup = useCallback(async (groupPath: string | null) => {
    const store = useClipboardStore.getState();
    const allRecords = await store.loadAllRecords(
      "resources",
      groupPath ?? resourceGroupRef.current,
      { silent: true },
    );
    const records = (allRecords ?? []).filter((record) => isResourceRecord(record));
    flog(`paste-group path=${groupPath ?? resourceGroupRef.current} records=${records.length}`);
    if (records.length > 0) {
      const allText = records.every((record) => inferResourceMediaKind(record) === "text");
      try {
        // 文件承载的文本资源（如自动发现的 .txt）的 content 是文件路径，
        // 合并前需读取文件真实内容；任一读取失败则整组回退为文件列表粘贴。
        const parts: string[] = [];
        let allTextContentReady = allText;
        if (allText) {
          for (const record of records) {
            if (isFileBackedTextResource(record)) {
              try {
                parts.push(
                  await readTextFileContent(getResourcePath(record)),
                );
              } catch (error) {
                console.error("Failed to read text resource for group paste:", error);
                allTextContentReady = false;
                break;
              }
            } else {
              parts.push(await store.getRecordContent(record));
            }
          }
        }
        if (allTextContentReady) {
          await invoke("paste_text", { text: parts.join("\n") });
        } else {
          const paths = records
            .map((record) => record.resource_path)
            .filter((path): path is string => Boolean(path));
          if (paths.length === 0) throw new Error("分组内没有可粘贴的文件");
          await invoke("paste_files", { paths });
        }
        // 整组粘贴成功后全组计入「最近使用」，与单条粘贴的记录口径一致。
        void invoke("touch_clipboard_usage", {
          ids: records.map((record) => record.id),
        }).catch((error) => {
          console.error("Failed to record group usage:", error);
        });
      } catch (error) {
        console.error("Failed to paste resource group:", error);
      }
    }
    resetState();
    void invoke("hide_radial_menu");
  }, [resetState, resourceGroupRef]);

  // 收藏/取消收藏（与主窗口共用 store action）：本地即时打标 + 落库后重载，
  // pinned DESC 浮顶由共享查询自然生效。
  const toggleRecordPinned = useCallback((id: string, pinned: boolean) => {
    void useClipboardStore.getState().setRecordsPinned([id], !pinned);
  }, []);

  return { handleItemPaste, handlePasteGroup, toggleRecordPinned };
}
