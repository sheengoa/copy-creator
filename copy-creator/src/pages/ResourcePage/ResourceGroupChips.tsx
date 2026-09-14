import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { Icons } from "../../components/Icons";
import { ChipDragOverlay } from "../../components/ChipDragOverlay";
import type { ResourceFolder } from "../../types";
import { findResourceFolder, flattenResourceFoldersVisible, formatResourceFolderPath, isResourceFolderPath } from "../../domain/groups";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useChipStripReorder } from "../../hooks/useChipStripReorder";
import { useHorizontalWheelScroll } from "../../hooks/useHorizontalWheelScroll";

interface ResourceGroupChipsProps {
  groups: ResourceFolder[];
  selectedGroup: string | null;
  onSelectGroup: (name: string | null) => void;
  onReorderGroups: (orderedPaths: string[]) => void;
  onManageGroups: () => void;
}

function SortableGroupChip({
  group,
  label,
  isActive,
  onSelect,
  onOpenMenu,
}: {
  group: ResourceFolder;
  label: string;
  isActive: boolean;
  onSelect: (path: string) => void;
  onOpenMenu: (path: string, anchor: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.path });
  const hasChildren = (group.children ?? []).length > 0;

  return hasChildren ? (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition || "transform 200ms ease",
      } as React.CSSProperties}
      className={`resource-group-control${isActive ? " active" : ""}${isDragging ? " is-dragging" : ""}`}
    >
      <button
        type="button"
        className="resource-group-chip-main"
        onClick={() => onSelect(group.path)}
        title={label}
        {...attributes}
        {...listeners}
      >
        <span>{label}</span>
      </button>
      <button
        type="button"
        className="resource-group-chevron"
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(group.path, event.currentTarget);
        }}
        aria-label={t("resources.openSubfolders")}
        aria-haspopup="menu"
        title={t("resources.openSubfolders")}
      >
        {Icons.chevronDown}
      </button>
    </div>
  ) : (
    <button
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition || "transform 200ms ease",
      } as React.CSSProperties}
      className={`resource-group-chip${isActive ? " active" : ""}${isDragging ? " is-dragging" : ""}`}
      onClick={() => onSelect(group.path)}
      title={label}
      {...attributes}
      {...listeners}
    >
      <span>{label}</span>
    </button>
  );
}

export default function ResourceGroupChips({
  groups,
  selectedGroup,
  onSelectGroup,
  onReorderGroups,
  onManageGroups,
}: ResourceGroupChipsProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  // 子分组折叠状态：浮层内存活，重开浮层与页面级重扫都保持。
  const [collapsedPaths, setCollapsedPaths] = useState<string[]>([]);

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsedPaths((current) => (
      current.includes(path)
        ? current.filter((path2) => path2 !== path)
        : [...current, path]
    ));
  }, []);

  useHorizontalWheelScroll(scrollRef);

  const closeMenu = useCallback(() => {
    setMenuPath(null);
    setMenuPosition(null);
  }, []);

  const updateMenuPosition = useCallback(() => {
    const anchor = menuAnchorRef.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    const menuWidth = menuRect?.width ?? 220;
    const menuHeight = menuRect?.height ?? 0;
    const viewportPadding = 8;
    const left = Math.max(
      viewportPadding,
      Math.min(anchorRect.left, window.innerWidth - menuWidth - viewportPadding),
    );
    const canOpenAbove = anchorRect.top - menuHeight - 6 >= viewportPadding;
    const top = canOpenAbove && anchorRect.bottom + menuHeight + 6 > window.innerHeight
      ? anchorRect.top - menuHeight - 6
      : anchorRect.bottom + 6;
    setMenuPosition({ left, top });
  }, []);

  const menuFolder = useMemo(
    () => (menuPath ? findResourceFolder(groups, menuPath) : null),
    [groups, menuPath],
  );
  // 折叠展平：根行（全部文件）不参与折叠，其下各行可收起后代。
  const menuItems = useMemo(
    () => menuFolder
      ? [
        { folder: menuFolder, depth: 0 },
        ...flattenResourceFoldersVisible(menuFolder.children ?? [], new Set(collapsedPaths), 1),
      ]
      : [],
    [menuFolder, collapsedPaths],
  );

  useEffect(() => {
    if (!menuPath) return;

    let frame: number | null = null;
    const schedulePositionUpdate = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateMenuPosition();
      });
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (menuAnchorRef.current?.contains(target)) return;
      closeMenu();
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
  }, [closeMenu, menuPath, menuItems.length, updateMenuPosition]);
  useEscapeKey((event) => {
    event.preventDefault();
    closeMenu();
  }, menuPath !== null);

  const handleSelect = useCallback((path: string) => {
    closeMenu();
    onSelectGroup(path);
  }, [closeMenu, onSelectGroup]);

  const handleOpenMenu = useCallback((path: string, anchor: HTMLButtonElement) => {
    if (menuPath === path) {
      closeMenu();
      return;
    }
    menuAnchorRef.current = anchor;
    setMenuPosition(null);
    setMenuPath(path);
  }, [closeMenu, menuPath]);

  const {
    activeItem: activeGroup,
    sensors,
    handleDragStart,
    handleDragCancel,
    handleDragEnd,
  } = useChipStripReorder(groups, (group) => group.path, onReorderGroups);

  return (
    <section className="resource-group-section" aria-label={t("resources.groups")}>
      <div className="resource-group-scroll" ref={scrollRef}>
        <button
          type="button"
          className={`resource-group-chip${selectedGroup === null ? " active" : ""}`}
          onClick={() => onSelectGroup(null)}
        >
          <span>{t("resources.allGroups")}</span>
        </button>
        <button
          type="button"
          className={`resource-group-chip${selectedGroup === "" ? " active" : ""}`}
          onClick={() => onSelectGroup("")}
        >
          <span>{t("resources.ungrouped")}</span>
        </button>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={groups.map((group) => group.path)}
            strategy={horizontalListSortingStrategy}
          >
            {groups.map((group) => {
              const isActive = selectedGroup !== null
                && isResourceFolderPath(selectedGroup, group.path);
              // 含子分组的 chip 选中其子级时，主 chip 显示当前浏览的完整路径。
              const label = selectedGroup !== null && isResourceFolderPath(selectedGroup, group.path)
                ? formatResourceFolderPath(selectedGroup)
                : group.name;
              return (
                <SortableGroupChip
                  key={group.path}
                  group={group}
                  label={label}
                  isActive={isActive}
                  onSelect={handleSelect}
                  onOpenMenu={handleOpenMenu}
                />
              );
            })}
          </SortableContext>
          {activeGroup ? <ChipDragOverlay label={activeGroup.name} className="resource-group-chip" /> : null}
        </DndContext>
      </div>
      <div className="resource-group-actions">
        <button
          type="button"
          className="resource-group-action"
          onClick={onManageGroups}
          aria-label={t("resources.manageGroups")}
          title={t("resources.manageGroups")}
        >
          {Icons.edit}
        </button>
      </div>
      {menuPath && menuFolder && createPortal(
        <div
          ref={menuRef}
          className="resource-group-dropdown"
          role="menu"
          aria-label={t("resources.openSubfolders")}
          style={{
            left: menuPosition?.left ?? 0,
            top: menuPosition?.top ?? 0,
            visibility: menuPosition ? "visible" : "hidden",
          }}
        >
          {menuItems.map(({ folder, depth }, index) => {
            const hasChildren = index > 0 && (folder.children ?? []).length > 0;
            const collapsed = collapsedPaths.includes(folder.path);
            return (
              <div
                key={folder.path}
                className="resource-group-menu-entry"
                style={{ paddingLeft: `${8 + depth * 14}px` }}
              >
                <button
                  type="button"
                  className={`resource-group-twist${collapsed ? " collapsed" : ""}`}
                  disabled={!hasChildren}
                  tabIndex={hasChildren ? 0 : -1}
                  aria-label={
                    hasChildren
                      ? (collapsed ? t("resources.expandGroup") : t("resources.collapseGroup"))
                      : undefined
                  }
                  onClick={() => hasChildren && toggleCollapsed(folder.path)}
                >
                  {hasChildren ? Icons.chevronDown : null}
                </button>
                <button
                  type="button"
                  className={`resource-group-menu-item${depth > 0 ? " nested" : ""}${selectedGroup === folder.path ? " selected" : ""}`}
                  role="menuitem"
                  aria-current={selectedGroup === folder.path ? "page" : undefined}
                  title={folder.path}
                  onClick={() => handleSelect(folder.path)}
                >
                  {Icons.resources}
                  <span>{depth === 0 ? t("resources.allFiles") : folder.name}</span>
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </section>
  );
}
