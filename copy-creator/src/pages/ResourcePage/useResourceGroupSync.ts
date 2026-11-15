// 资源分组与库同步子系统：分组列表加载、库修订号基线、
// resource-groups-changed 事件监听与 10s 对账轮询兜底、
// 窗口恢复显示重载、资源库路径的加载与切换。
// 自 ResourcePage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 浏览态（resourceGroup 当前分组）、列表重载（loadRecords）、
// 回收站角标刷新（refreshTrashCount）、库路径切换后的选中复位
// （setStoreResourceGroup）与主列表共享，经 params 注入。

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { RefObject } from "react";
import type { ResourceFolder } from "../../types";
import type { ClipType } from "../../stores/clipboardStore";
import { useRefreshOnShow } from "../../hooks/useRefreshOnShow";
import { invokeNativeDialog } from "../../utils/nativeDialogGuard";

export function useResourceGroupSync({
  resourceGroup,
  loadRecords,
  refreshTrashCount,
  setStoreResourceGroup,
  resourceListRef,
}: {
  resourceGroup: string | null;
  loadRecords: (
    append?: boolean,
    categoryOverride?: ClipType,
    resourceGroup?: string | null,
  ) => Promise<void>;
  refreshTrashCount: () => void;
  setStoreResourceGroup: (group: string | null) => void;
  resourceListRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const [resourceGroups, setResourceGroups] = useState<ResourceFolder[]>([]);
  const [resourceGroupsLoading, setResourceGroupsLoading] = useState(true);
  const [resourceGroupsError, setResourceGroupsError] = useState<string | null>(null);
  const [resourceLibraryPath, setResourceLibraryPath] = useState("");
  const [resourceLibraryPathLoading, setResourceLibraryPathLoading] = useState(true);
  const [resourceLibraryPathChanging, setResourceLibraryPathChanging] = useState(false);
  const [resourceLibraryPathError, setResourceLibraryPathError] = useState<string | null>(null);

  // 分组数据对应的库修订号基准：轮询以此判断数据是否落后。启动对账是
  // 后台线程，前端挂载加载分组时对账可能尚未完成——对账完成的事件存在
  // WebView 丢弃竞态（resource-groups-changed 是单次事件），修订号比对
  // 是唯一可靠信号；基准必须在每次分组数据落定后锚定，否则首轮轮询把
  // 对账后的新修订号当基线，之后永远判定「未落后」，列表停留旧数据。
  const libraryRevisionRef = useRef(-1);
  const loadResourceGroups = useCallback(async () => {
    setResourceGroupsLoading(true);
    try {
      const groups = await invoke<ResourceFolder[]>("list_resource_groups");
      setResourceGroups(groups);
      setResourceGroupsError(null);
      try {
        libraryRevisionRef.current = await invoke<number>("get_resource_library_revision");
      } catch {
        // 修订号拉取失败不影响分组数据本身，轮询沿用旧基线。
      }
      return groups;
    } catch (error) {
      console.error("Failed to load resource groups:", error);
      setResourceGroupsError(t("resources.groupLoadError"));
      return null;
    } finally {
      setResourceGroupsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadResourceGroups();
  }, [loadResourceGroups]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen("resource-groups-changed", () => {
      void loadResourceGroups();
      void loadRecords(false, "resources", resourceGroup);
      refreshTrashCount();
    }).then((nextUnlisten) => {
      if (cancelled) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [loadRecords, loadResourceGroups, resourceGroup, refreshTrashCount]);

  // 兜底自愈：resource-groups-changed 是单次事件，被 WebView 丢弃或延迟
  // 时列表会停留旧数据且没有任何重试（实测出现过一次覆盖保存后列表长时
  // 间不刷新）。挂载期间每 10s 拉取库修订号比对，发现落后即重载分组与
  // 记录——事件为主路径，轮询只做对账补漏；窗口隐藏到托盘时定时器被
  // WebView 节流，恢复显示另有 useRefreshOnShow 全量重载。
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 面板隐藏（display:none）时对账无意义：offsetParent 为 null 的
      // display:none 子树直接跳过，恢复显示由 useRefreshOnShow 全量重载兜底。
      if (resourceListRef.current?.offsetParent === null) return;
      void invoke<number>("get_resource_library_revision")
        .then((revision) => {
          const seen = libraryRevisionRef.current;
          if (seen === -1) {
            libraryRevisionRef.current = revision;
            return;
          }
          if (revision === seen) return;
          libraryRevisionRef.current = revision;
          void loadResourceGroups();
          void loadRecords(false, "resources", resourceGroup);
        })
        .catch(() => {});
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadRecords, loadResourceGroups, resourceGroup, resourceListRef]);

  // 主窗口从隐藏恢复显示时重载分组与记录：兜底隐藏期间丢失/被节流的刷新。
  useRefreshOnShow(useCallback(() => {
    void loadResourceGroups();
    void loadRecords(false, "resources", resourceGroup);
  }, [loadRecords, loadResourceGroups, resourceGroup]));

  useEffect(() => {
    let cancelled = false;
    setResourceLibraryPathLoading(true);
    invoke<string>("get_resource_library_path")
      .then((path) => {
        if (cancelled) return;
        setResourceLibraryPath(path);
        setResourceLibraryPathError(null);
      })
      .catch(() => {
        if (!cancelled) setResourceLibraryPathError(t("resources.libraryPathError"));
      })
      .finally(() => {
        if (!cancelled) setResourceLibraryPathLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleChangeResourceLibraryPath = useCallback(async () => {
    if (resourceLibraryPathChanging) return;
    setResourceLibraryPathChanging(true);
    setResourceLibraryPathError(null);
    try {
      const selectedPath = await invokeNativeDialog<string>("select_resource_library_folder");
      if (!selectedPath) return;
      const savedPath = await invoke<string>("set_resource_library_path", {
        path: selectedPath,
      });
      setResourceLibraryPath(savedPath);
      setStoreResourceGroup(null);
      await loadResourceGroups();
      await loadRecords(false, "resources", null);
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("cancelled") && !message.includes("canceled")) {
        console.error("Failed to change resource library path:", error);
        setResourceLibraryPathError(t("resources.libraryPathChangeError"));
      }
    } finally {
      setResourceLibraryPathChanging(false);
    }
  }, [loadRecords, loadResourceGroups, resourceLibraryPathChanging, setStoreResourceGroup, t]);

  return {
    resourceGroups,
    setResourceGroups,
    resourceGroupsLoading,
    resourceGroupsError,
    setResourceGroupsError,
    loadResourceGroups,
    resourceLibraryPath,
    resourceLibraryPathLoading,
    resourceLibraryPathChanging,
    resourceLibraryPathError,
    handleChangeResourceLibraryPath,
  };
}
