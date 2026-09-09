import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { Icons } from "../../components/Icons";
import type { ResourceFolder } from "../../types";
import {
  findResourceFolder,
  flattenResourceFolders,
  formatResourceFolderPath,
  isResourceFolderPath,
} from "./resourceUtils";

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
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // 与剪切板区、快捷输入区一致：指针悬浮在分组栏上滚动滑轮即可横向滚动。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        element.scrollLeft += event.deltaY;
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    schedulePositionUpdate();

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [closeMenu, menuPath, updateMenuPosition]);

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = groups.findIndex((group) => group.path === active.id);
    const newIndex = groups.findIndex((group) => group.path === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorderGroups(arrayMove(groups, oldIndex, newIndex).map((group) => group.path));
  }, [groups, onReorderGroups]);

  const menuFolder = useMemo(
    () => (menuPath ? findResourceFolder(groups, menuPath) : null),
    [groups, menuPath],
  );
  const menuItems = useMemo(
    () => menuFolder
      ? [
        { folder: menuFolder, depth: 0 },
        ...flattenResourceFolders(menuFolder.children ?? [], 1),
      ]
      : [],
    [menuFolder],
  );
  const activeGroup = activeDragId ? groups.find((group) => group.path === activeDragId) : null;

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
          <DragOverlay dropAnimation={null}>
            {activeGroup ? (
              <div className="resource-group-chip active drag-overlay-chip">
                {activeGroup.name}
              </div>
            ) : null}
          </DragOverlay>
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
          {menuItems.map(({ folder, depth }) => (
            <button
              key={folder.path}
              type="button"
              className={`resource-group-menu-item${depth > 0 ? " nested" : ""}${selectedGroup === folder.path ? " selected" : ""}`}
              role="menuitem"
              aria-current={selectedGroup === folder.path ? "page" : undefined}
              title={folder.path}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() => handleSelect(folder.path)}
            >
              {Icons.resources}
              <span>{depth === 0 ? t("resources.allFiles") : folder.name}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </section>
  );
}
