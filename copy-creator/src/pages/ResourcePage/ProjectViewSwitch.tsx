import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../../stores/projectStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icons } from "../../components/Icons";

/** 资源页顶部的视图切换栏：文件视图 / 工程视图分段控件 + 剧选择器。
 *  文件视图是原有形态；工程视图进入剧集工作台。
 *  children（文件视图的分组条）渲染在切换按钮右侧同一行，节省一行
 *  纵向空间；为空/false（工程视图）时回落 spacer，布局与此前一致。 */
export default function ProjectViewSwitch({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const { view, setView, shows, currentShowId, selectShow, createShow, renameShow, deleteShow, refresh } =
    useProjectStore(
      useShallow((state) => ({
        view: state.view,
        setView: state.setView,
        shows: state.shows,
        currentShowId: state.currentShowId,
        selectShow: state.selectShow,
        createShow: state.createShow,
        renameShow: state.renameShow,
        deleteShow: state.deleteShow,
        refresh: state.refresh,
      })),
    );

  const [menuOpen, setMenuOpen] = useState(false);
  const [newShowOpen, setNewShowOpen] = useState(false);
  const [newShowName, setNewShowName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleteShowConfirm, setDeleteShowConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (newShowOpen) {
      setNewShowName("");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [newShowOpen]);

  useEffect(() => {
    // 每次切入工程视图都全量刷新（refresh 保住当前选中）：文件视图期间
    // 库内文件可能被增删/改名/恢复，素材档案的缺失标记与路径同步依赖
    // 新鲜的 overview，不能只靠 project-changed 事件（库文件操作不发它）。
    if (view === "project") {
      void refresh();
    }
  }, [view, refresh]);

  const currentShow = shows.find((show) => show.id === currentShowId) ?? null;

  useEffect(() => {
    if (renameOpen && currentShow) {
      setRenameName(currentShow.name);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [renameOpen, currentShow]);

  const handleCreateShow = async () => {
    const name = newShowName.trim();
    if (!name) return;
    const created = await createShow(name);
    if (created) {
      setNewShowOpen(false);
      await selectShow(created.id);
    }
  };

  const handleRenameShow = async () => {
    const name = renameName.trim();
    if (!name || !currentShow || name === currentShow.name) {
      setRenameOpen(false);
      return;
    }
    await renameShow(currentShow.id, name);
    setRenameOpen(false);
  };

  return (
    <div className="project-viewbar">
      <div className="project-switch" role="tablist" aria-label={t("project.view.switchLabel")}>
        <button
          type="button"
          role="tab"
          aria-selected={view === "file"}
          className={view === "file" ? "active" : ""}
          onClick={() => setView("file")}
        >
          {t("project.view.file")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "project"}
          className={view === "project" ? "active" : ""}
          onClick={() => setView("project")}
        >
          {t("project.view.project")}
        </button>
      </div>
      {/* children 为 false（工程视图）时也要有 spacer 把剧选择器推到行尾；
          ?? 不会回落 false，这里必须用 ||。 */}
      {children || <span className="project-viewbar-spacer" />}
      {view === "project" && (
        <div className="project-show-pick-wrap" ref={menuRef}>
          <button
            type="button"
            className="project-show-pick"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="project-show-pick-icon">{Icons.clapperboard}</span>
            <span className="project-show-pick-name">
              {currentShow?.name ?? t("project.show.pickPlaceholder")}
            </span>
            <span className="project-show-pick-caret">{Icons.chevronDown}</span>
          </button>
          {menuOpen && (
            <div className="project-menu" role="menu">
              {shows.map((show) => (
                <button
                  key={show.id}
                  type="button"
                  role="menuitem"
                  className={`project-menu-item${show.id === currentShowId ? " current" : ""}`}
                  onClick={() => {
                    setMenuOpen(false);
                    if (show.id !== currentShowId) void selectShow(show.id);
                  }}
                >
                  <span className="project-menu-item-icon">
                    {show.id === currentShowId ? Icons.check : Icons.clapperboard}
                  </span>
                  {show.name}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                className="project-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  setNewShowOpen(true);
                }}
              >
                <span className="project-menu-item-icon">{Icons.add}</span>
                {t("project.show.new")}
              </button>
              {currentShow && (
                <button
                  type="button"
                  role="menuitem"
                  className="project-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setRenameOpen(true);
                  }}
                >
                  <span className="project-menu-item-icon">{Icons.edit}</span>
                  {t("project.show.rename")}
                </button>
              )}
              {currentShow && (
                <button
                  type="button"
                  role="menuitem"
                  className="project-menu-item project-menu-danger"
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteShowConfirm(true);
                  }}
                >
                  <span className="project-menu-item-icon">{Icons.delete}</span>
                  {t("project.show.delete", { name: currentShow.name })}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {newShowOpen && (
        <div
          className="project-dialog-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNewShowOpen(false);
          }}
        >
          <div className="project-dialog">
            <div className="project-dialog-head">
              <h4>{t("project.show.new")}</h4>
              <button
                type="button"
                className="project-dialog-close"
                onClick={() => setNewShowOpen(false)}
                aria-label={t("common.cancel")}
              >
                {Icons.close}
              </button>
            </div>
            <div className="project-dialog-body">
              <label className="project-dialog-label" htmlFor="project-new-show-name">
                {t("project.show.nameLabel")}
              </label>
              <input
                id="project-new-show-name"
                ref={inputRef}
                className="project-dialog-input"
                value={newShowName}
                placeholder={t("project.show.namePlaceholder")}
                onChange={(event) => setNewShowName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCreateShow();
                  if (event.key === "Escape") setNewShowOpen(false);
                }}
              />
            </div>
            <div className="project-dialog-foot">
              <button
                type="button"
                className="project-dialog-btn"
                onClick={() => setNewShowOpen(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="project-dialog-btn primary"
                disabled={!newShowName.trim()}
                onClick={() => void handleCreateShow()}
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {renameOpen && (
        <div
          className="project-dialog-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRenameOpen(false);
          }}
        >
          <div className="project-dialog">
            <div className="project-dialog-head">
              <h4>{t("project.show.rename")}</h4>
              <button
                type="button"
                className="project-dialog-close"
                onClick={() => setRenameOpen(false)}
                aria-label={t("common.cancel")}
              >
                {Icons.close}
              </button>
            </div>
            <div className="project-dialog-body">
              <label className="project-dialog-label" htmlFor="project-rename-show-name">
                {t("project.show.nameLabel")}
              </label>
              <input
                id="project-rename-show-name"
                ref={inputRef}
                className="project-dialog-input"
                value={renameName}
                placeholder={t("project.show.namePlaceholder")}
                onChange={(event) => setRenameName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleRenameShow();
                  if (event.key === "Escape") setRenameOpen(false);
                }}
              />
            </div>
            <div className="project-dialog-foot">
              <button
                type="button"
                className="project-dialog-btn"
                onClick={() => setRenameOpen(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="project-dialog-btn primary"
                disabled={!renameName.trim()}
                onClick={() => void handleRenameShow()}
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteShowConfirm && currentShow && (
        <ConfirmDialog
          message={t("project.show.deleteConfirm", { name: currentShow.name })}
          onConfirm={() => {
            setDeleteShowConfirm(false);
            void deleteShow(currentShow.id);
          }}
          onCancel={() => setDeleteShowConfirm(false)}
        />
      )}
    </div>
  );
}
