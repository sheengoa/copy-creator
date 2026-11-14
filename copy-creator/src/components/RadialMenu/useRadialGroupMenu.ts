// 径向菜单资源分组下拉：子分组折叠展平、下拉定位（锚点矩形 + 视口
// 收拢）与外点/几何变化关闭。自 index.tsx 拆出（2026-11-14，架构守卫
// 规则 27 行数上限）；分组数据、下拉开合状态与两个挂载 ref 由 index
// 注入（下拉与工具行/径向条目共用同一分组实况）。

import { useCallback, useEffect, useMemo } from "react";
import { findResourceFolder, flattenResourceFoldersVisible } from "../../domain/groups";
import type { ResourceFolder } from "../../types";

export function useRadialGroupMenu({
  resourceGroups,
  resourceGroupMenuPath,
  collapsedGroupPaths,
  setCollapsedGroupPaths,
  setResourceGroupMenuPath,
  setResourceGroupMenuPosition,
  resourceGroupMenuRef,
  resourceGroupMenuAnchorRef,
}: {
  resourceGroups: ResourceFolder[];
  resourceGroupMenuPath: string | null;
  collapsedGroupPaths: string[];
  setCollapsedGroupPaths: (update: (current: string[]) => string[]) => void;
  setResourceGroupMenuPath: (path: string | null) => void;
  setResourceGroupMenuPosition: (position: { left: number; top: number } | null) => void;
  resourceGroupMenuRef: { current: HTMLDivElement | null };
  resourceGroupMenuAnchorRef: { current: HTMLButtonElement | null };
}) {
  const resourceFolderGroups = resourceGroups.filter((group) => group.name !== "");
  const resourceGroupMenuFolder = resourceGroupMenuPath
    ? findResourceFolder(resourceFolderGroups, resourceGroupMenuPath)
    : null;
  // 折叠展平：根行（全部文件）不参与折叠，其下各行可收起后代。
  const collapsedGroupSet = useMemo(() => new Set(collapsedGroupPaths), [collapsedGroupPaths]);
  const resourceGroupMenuItems = resourceGroupMenuFolder
    ? [
        { folder: resourceGroupMenuFolder, depth: 0 },
        ...flattenResourceFoldersVisible(resourceGroupMenuFolder.children ?? [], collapsedGroupSet, 1),
      ]
    : [];

  const toggleResourceGroupCollapsed = useCallback((path: string) => {
    setCollapsedGroupPaths((current) => (
      current.includes(path)
        ? current.filter((path2) => path2 !== path)
        : [...current, path]
    ));
  }, [setCollapsedGroupPaths]);

  const closeResourceGroupMenu = useCallback(() => {
    setResourceGroupMenuPath(null);
    setResourceGroupMenuPosition(null);
  }, [setResourceGroupMenuPath, setResourceGroupMenuPosition]);

  const updateResourceGroupMenuPosition = useCallback(() => {
    const anchor = resourceGroupMenuAnchorRef.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = resourceGroupMenuRef.current?.getBoundingClientRect();
    const menuWidth = menuRect?.width ?? 220;
    const menuHeight = menuRect?.height ?? 0;
    const viewportPadding = 8;
    const left = Math.max(
      viewportPadding,
      Math.min(anchorRect.left, window.innerWidth - menuWidth - viewportPadding),
    );
    const top = anchorRect.bottom + 6 + menuHeight <= window.innerHeight - viewportPadding
      ? anchorRect.bottom + 6
      : Math.max(viewportPadding, anchorRect.top - menuHeight - 6);
    setResourceGroupMenuPosition({ left, top });
  }, [resourceGroupMenuAnchorRef, resourceGroupMenuRef, setResourceGroupMenuPosition]);

  useEffect(() => {
    if (!resourceGroupMenuPath) return;

    let frame: number | null = null;
    const schedulePositionUpdate = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateResourceGroupMenuPosition();
      });
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (resourceGroupMenuRef.current?.contains(target)) return;
      if (resourceGroupMenuAnchorRef.current?.contains(target)) return;
      closeResourceGroupMenu();
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    schedulePositionUpdate();

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [closeResourceGroupMenu, resourceGroupMenuItems.length, resourceGroupMenuPath, resourceGroupMenuAnchorRef, resourceGroupMenuRef, updateResourceGroupMenuPosition]);

  return {
    resourceFolderGroups,
    resourceGroupMenuFolder,
    resourceGroupMenuItems,
    toggleResourceGroupCollapsed,
    closeResourceGroupMenu,
    updateResourceGroupMenuPosition,
  };
}
