import { Fragment, useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveDoubleEnterSave } from "../../utils/doubleEnterShortcut";
import i18n from "../../i18n";
import StashEditor, { type StashEditorHandle, type StashImage } from "./StashEditor";
import { WindowResizeHandles } from "../WindowResizeHandles";
import { usePersistWindowSize } from "../../hooks/usePersistWindowSize";
import type { ClipboardStorageMode, ResourceFolder } from "../../types";
import { isResourceRecord } from "../../utils/clipboardRecord";

interface StashRecord {
  id: string;
  type: "text" | "link" | "image" | "file";
  content: string;
  content_truncated?: boolean;
  group_name?: string;
  has_images?: boolean;
  storage_mode?: ClipboardStorageMode;
  resource_path?: string;
  resource_group?: string | null;
}

export default function ClipboardCreateDialog() {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [images, setImages] = useState<StashImage[]>([]);
  const [editorVersion, setEditorVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [stashRecords, setStashRecords] = useState<StashRecord[]>([]);
  const [storageMode, setStorageMode] = useState<ClipboardStorageMode>("database");
  const [resourceGroupName, setResourceGroupName] = useState("");
  const [resourceGroups, setResourceGroups] = useState<ResourceFolder[]>([]);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [loadingRecordId, setLoadingRecordId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<StashEditorHandle>(null);
  const lastEnterAtRef = useRef(0);
  const cancelResizeSave = usePersistWindowSize("clipboard_create_width", "clipboard_create_height");

  const resetDraft = useCallback((nextContent = "", nextImages: StashImage[] = []) => {
    setContent(nextContent);
    setImages(nextImages);
    setEditorVersion((version) => version + 1);
    lastEnterAtRef.current = 0;
  }, []);

  // 剪贴板入口列出普通剪贴板记录（临时标记已废弃并迁移），资源入口列出资源记录。
  const loadStashRecords = useCallback(async (
    mode: ClipboardStorageMode,
    showLoading = false,
    groupName = "",
  ) => {
    if (showLoading) setLoadingRecords(true);
    try {
      const isResource = mode === "resource";
      const records = await invoke<StashRecord[]>("get_clipboard_records", {
        limit: 120,
        offset: 0,
        category: isResource ? "resources" : "all",
        ...(isResource ? { resourceGroup: groupName } : {}),
      });
      setStashRecords(records.filter((record) =>
        (isResource ? isResourceRecord(record) : !isResourceRecord(record))
        && (record.type === "text" || record.type === "link")
      ));
    } catch (e) {
      console.error("Failed to load stash records:", e);
      setError(i18n.t("resources.loadError"));
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  // 目标分组列表（后端首个节点为未分组），失败时保底仅剩「未分组」可选。
  const loadResourceGroups = useCallback(async () => {
    try {
      const groups = await invoke<ResourceFolder[]>("get_resource_groups");
      setResourceGroups(groups);
    } catch (e) {
      console.error("Failed to load resource groups:", e);
    }
  }, []);

  // 拍平分组树为缩进行；未分组（path 为空）由后端固定放在首位。
  const groupRows = useMemo(() => {
    const rows: Array<{ path: string; label: string; count: number; depth: number }> = [];
    const walk = (folders: ResourceFolder[], depth: number) => {
      for (const folder of folders) {
        rows.push({
          path: folder.path,
          label: folder.name === "" ? t("resources.ungrouped") : folder.name,
          count: folder.count,
          depth,
        });
        if ((folder.children ?? []).length > 0) walk(folder.children ?? [], depth + 1);
      }
    };
    walk(resourceGroups, 0);
    return rows;
  }, [resourceGroups, t]);

  // 初始化：主题 + 语言 + 事件监听
  useEffect(() => {
    invoke<string>("get_setting", { key: "theme" }).then((theme) => {
      if (theme === "dark" || theme === "light") {
        document.documentElement.setAttribute("data-theme", theme);
      }
    });
    invoke<string>("get_setting", { key: "language" })
      .then((language) => {
        if (language) i18n.changeLanguage(language);
      })
      .catch(() => {});

    let unlistenTheme: UnlistenFn | undefined;
    listen<{ theme: string }>("theme-changed", (e) => {
      document.documentElement.setAttribute("data-theme", e.payload.theme);
    }).then((fn) => { unlistenTheme = fn; });

    let unlistenLang: UnlistenFn | undefined;
    listen<{ language: string }>("language-changed", (e) => {
      if (e.payload.language) i18n.changeLanguage(e.payload.language);
    }).then((fn) => { unlistenLang = fn; });

    // 监听后端 clipboard-create-show 事件（快捷键触发时）
    let unlistenShow: UnlistenFn | undefined;
    listen<{
      theme: string;
      storage_mode?: ClipboardStorageMode | null;
      group_name?: string | null;
    }>("clipboard-create-show", (e) => {
      cancelResizeSave();
      document.documentElement.setAttribute("data-theme", e.payload.theme);
      resetDraft();
      setEditingId(null);
      const mode: ClipboardStorageMode = e.payload.storage_mode === "resource" ? "resource" : "database";
      setStorageMode(mode);
      setResourceGroupName(mode === "resource" ? e.payload.group_name || "" : "");
      setError(null);
      setDropdownOpen(false);
      setGroupMenuOpen(false);
      loadStashRecords(mode, false, mode === "resource" ? e.payload.group_name || "" : "");
      void loadResourceGroups();
      setTimeout(() => editorRef.current?.focus(), 50);
    }).then((fn) => { unlistenShow = fn; });

    loadStashRecords("database", true);
    void loadResourceGroups();

    return () => {
      if (unlistenTheme) unlistenTheme();
      if (unlistenLang) unlistenLang();
      if (unlistenShow) unlistenShow();
    };
  }, [cancelResizeSave, loadResourceGroups, loadStashRecords, resetDraft]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let cancelled = false;
    let unlistenClose: UnlistenFn | undefined;
    appWindow.onCloseRequested((event) => {
      event.preventDefault();
      void appWindow.hide();
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenClose = unlisten;
      }
    });

    return () => {
      cancelled = true;
      if (unlistenClose) unlistenClose();
    };
  }, []);

  const hideWindow = useCallback(() => {
    getCurrentWindow().hide();
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || saving || images.some((image) => image.pending)) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("save_stash_record", {
        id: editingId,
        content: trimmed,
        images: images.map((image) => image.sourcePath || image.dataUrl),
        storageMode,
        ...(storageMode === "resource" ? { groupName: resourceGroupName } : {}),
      });
      resetDraft();
      setEditingId(null);
      hideWindow();
    } catch (e) {
      console.error("Failed to save clipboard record:", e);
      setError(t("resources.saveError"));
    } finally {
      setSaving(false);
    }
  }, [content, editingId, images, resourceGroupName, saving, storageMode, hideWindow, resetDraft, t]);

  const handleSelectRecord = useCallback(async (record: StashRecord) => {
    if (loadingRecordId) return;
    setDropdownOpen(false);
    setGroupMenuOpen(false);
    setLoadingRecordId(record.id);
    setError(null);
    try {
      const [fullContent, imagePaths] = await Promise.all([
        record.content_truncated || record.has_images
          ? invoke<string>("get_clipboard_record_content", { id: record.id })
          : Promise.resolve(record.content),
        invoke<string[]>("get_stash_record_images", { id: record.id }),
      ]);
      const imageData = await Promise.all(imagePaths.map(async (path, index) => ({
        id: `${record.id}-${index}`,
        dataUrl: `data:image/png;base64,${await invoke<string>("get_image_base64", { path })}`,
        sourcePath: path,
      })));
      setEditingId(record.id);
      setStorageMode(record.storage_mode === "resource" ? "resource" : "database");
      setResourceGroupName(record.storage_mode === "resource" ? record.resource_group || "" : "");
      resetDraft(fullContent, imageData);
      setTimeout(() => editorRef.current?.focus(), 0);
    } catch (e) {
      console.error("Failed to load clipboard record content:", e);
      setError(t("resources.loadContentError"));
    } finally {
      setLoadingRecordId(null);
    }
  }, [loadingRecordId, resetDraft, t]);

  const handleGroupSelect = useCallback((path: string) => {
    setResourceGroupName(path);
    setGroupMenuOpen(false);
  }, []);

  const handleExitEdit = useCallback(() => {
    setEditingId(null);
    resetDraft();
    setError(null);
    setTimeout(() => editorRef.current?.focus(), 0);
  }, [resetDraft]);

  // 切换保存位置：保留已输入内容，退出编辑态并按新模式刷新“已有”列表。
  const handleDestChange = useCallback((mode: ClipboardStorageMode) => {
    if (mode === storageMode) return;
    setStorageMode(mode);
    setEditingId(null);
    setDropdownOpen(false);
    setGroupMenuOpen(false);
    setError(null);
    loadStashRecords(mode, false, mode === "resource" ? resourceGroupName : "");
  }, [loadStashRecords, resourceGroupName, storageMode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      lastEnterAtRef.current = 0;
      if (dropdownOpen) {
        setDropdownOpen(false);
        return;
      }
      if (groupMenuOpen) {
        setGroupMenuOpen(false);
        return;
      }
      hideWindow();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      lastEnterAtRef.current = 0;
      handleSave();
      return;
    }
    const editor = document.querySelector(".clipboard-create-editor");
    if (!(e.target instanceof Node) || !editor?.contains(e.target)) {
      lastEnterAtRef.current = 0;
      return;
    }

    const shortcut = resolveDoubleEnterSave({
      key: e.key,
      hasContent: Boolean(content.trim()),
      lastEnterAt: lastEnterAtRef.current,
      now: e.timeStamp,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
    });
    lastEnterAtRef.current = shortcut.nextLastEnterAt;

    if (shortcut.shouldPreventDefault) {
      e.preventDefault();
    }
    if (shortcut.shouldSave) {
      handleSave();
    }
  }, [content, dropdownOpen, groupMenuOpen, hideWindow, handleSave]);

  const selectedStashRecord = stashRecords.find((record) => record.id === editingId);
  const isResource = storageMode === "resource";

  return (
    <div className="clipboard-create-dialog" onKeyDown={handleKeyDown}>
      <div className="clipboard-create-header" data-tauri-drag-region>
        <span className="clipboard-create-title">
          {editingId ? t("resources.edit") : t("clipboard.create")}
        </span>
        <button
          type="button"
          className="clipboard-create-close-btn"
          onClick={hideWindow}
          title={t("common.cancel")}
          aria-label={t("common.cancel")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div onFocus={() => { setDropdownOpen(false); setGroupMenuOpen(false); }} className="clipboard-create-editor-wrap">
        <StashEditor
          key={editorVersion}
          ref={editorRef}
          initialContent={content}
          initialImages={images}
          placeholder={isResource ? t("resources.createPlaceholder") : t("resources.createPlaceholderClipboard")}
          previewAlt={t("resources.imagePreview")}
          closePreviewLabel={t("resources.closeImagePreview")}
          onChange={(nextContent, nextImages) => {
            setContent(nextContent);
            setImages(nextImages);
          }}
          onImageError={() => setError(t("resources.readImageError"))}
        />
      </div>
      {error && <div className="clipboard-create-error" role="alert">{error}</div>}
      <div className="clipboard-create-action-bar">
        <div className="clipboard-create-bar-left">
          <div className="clipboard-create-dest-seg" role="group" aria-label={t("resources.storageLocation")}>
            <button
              type="button"
              className={`clipboard-create-dest-seg-item${storageMode === "database" ? " on" : ""}`}
              aria-pressed={storageMode === "database"}
              onClick={() => handleDestChange("database")}
            >
              {t("resources.destinationClipboard")}
            </button>
            <button
              type="button"
              className={`clipboard-create-dest-seg-item${storageMode === "resource" ? " on" : ""}`}
              aria-pressed={storageMode === "resource"}
              onClick={() => handleDestChange("resource")}
            >
              {t("resources.destinationResource")}
            </button>
          </div>
          {isResource && (
            <div className={`clipboard-create-stash-picker clipboard-create-group-picker${groupMenuOpen ? " open" : ""}`}>
              <button
                type="button"
                className="clipboard-create-chip-trigger"
                onClick={() => setGroupMenuOpen((open) => !open)}
                aria-expanded={groupMenuOpen}
                aria-haspopup="listbox"
                title={t("resources.targetGroup")}
              >
                <svg className="clipboard-create-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span className="clipboard-create-chip-content">
                  {resourceGroupName ? resourceGroupName.split("/").join(" / ") : t("resources.ungrouped")}
                </span>
                <svg className="clipboard-create-stash-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {groupMenuOpen && (
                <div className="clipboard-create-stash-menu clipboard-create-group-menu" role="listbox" aria-label={t("resources.targetGroup")}>
                  {groupRows.map((row) => (
                    <Fragment key={row.path || "ungrouped"}>
                      <button
                        type="button"
                        className={`clipboard-create-stash-option${resourceGroupName === row.path ? " selected" : ""}`}
                        onClick={() => handleGroupSelect(row.path)}
                        role="option"
                        aria-selected={resourceGroupName === row.path}
                        title={row.label}
                      >
                        <span
                          className="clipboard-create-stash-option-content"
                          style={row.depth > 0 ? { paddingLeft: row.depth * 14 } : undefined}
                        >
                          {row.label}
                        </span>
                        <span className="clipboard-create-group-count">{row.count > 0 ? row.count : ""}</span>
                        {resourceGroupName === row.path && <span className="clipboard-create-stash-check">✓</span>}
                      </button>
                      {row.path === "" && <div className="clipboard-create-group-menu-sep" />}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className={`clipboard-create-stash-picker${dropdownOpen ? " open" : ""}`}>
            <button
              type="button"
              className="clipboard-create-chip-trigger"
              onClick={() => setDropdownOpen((open) => !open)}
              disabled={loadingRecords || stashRecords.length === 0 || loadingRecordId !== null}
              aria-expanded={dropdownOpen}
              aria-haspopup="listbox"
            >
              <svg className="clipboard-create-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
              {editingId && (
                <span className="clipboard-create-chip-tag">{t("resources.editingTag")}</span>
              )}
              <span className={`clipboard-create-chip-content${selectedStashRecord ? "" : " placeholder"}${editingId ? " editing" : ""}`}>
                {selectedStashRecord
                  ? selectedStashRecord.content
                  : loadingRecords
                    ? t("common.loading")
                    : stashRecords.length === 0
                      ? isResource
                        ? t("resources.noExisting")
                        : t("resources.noExistingClipboard")
                      : `${isResource ? t("resources.existing") : t("resources.existingClipboard")} · ${isResource ? t("resources.selectExisting") : t("resources.selectExistingClipboard")}`}
              </span>
              <svg className="clipboard-create-stash-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {editingId && (
              <button
                type="button"
                className="clipboard-create-chip-exit"
                title={isResource ? t("resources.exitEdit") : t("resources.exitEditClipboard")}
                aria-label={isResource ? t("resources.exitEdit") : t("resources.exitEditClipboard")}
                onClick={handleExitEdit}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            {dropdownOpen && stashRecords.length > 0 && (
              <div className="clipboard-create-stash-menu" role="listbox">
                {stashRecords.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    className={`clipboard-create-stash-option${editingId === record.id ? " selected" : ""}`}
                    onClick={() => handleSelectRecord(record)}
                    disabled={loadingRecordId !== null}
                    role="option"
                    aria-selected={editingId === record.id}
                    title={record.content}
                  >
                    <span className="clipboard-create-stash-option-content">{record.content}</span>
                    {editingId === record.id && <span className="clipboard-create-stash-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="clipboard-create-actions">
          <button className="dialog-btn secondary" onClick={hideWindow}>
            {t("common.cancel")}
          </button>
          <button
            className="dialog-btn save"
            onClick={handleSave}
            disabled={!content.trim() || saving || loadingRecordId !== null || images.some((image) => image.pending)}
          >
            {saving
              ? t("common.saving")
              : editingId
                ? t("resources.update")
                : t("common.save")}
          </button>
        </div>
      </div>
      <WindowResizeHandles />
    </div>
  );
}
