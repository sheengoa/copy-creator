import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  useProjectStore,
  type ProjectSearchItem,
} from "../../stores/projectStore";
import { Icons } from "../../components/Icons";

function searchKindKey(kind: ProjectSearchItem["kind"]): string {
  return `project.search.kind.${kind}`;
}

/** 工程视图的跨实体搜索结果：剧/集直接跳转，库实体跳到对应面板。
 *  由资源页工具行在工程视图下渲染（与文件视图共用同一个搜索框）。 */
export default function ProjectSearchResults({ onJumped }: { onJumped: () => void }) {
  const { t } = useTranslation();
  const { searchResults, searchLoading, selectShow, selectEpisode, openLibraryPanel } =
    useProjectStore(
      useShallow((state) => ({
        searchResults: state.searchResults,
        searchLoading: state.searchLoading,
        selectShow: state.selectShow,
        selectEpisode: state.selectEpisode,
        openLibraryPanel: state.openLibraryPanel,
      })),
    );

  if (searchLoading && searchResults.length === 0) {
    return (
      <div className="project-search-results">
        <div className="project-search-empty">{t("project.loading")}</div>
      </div>
    );
  }
  if (searchResults.length === 0) return null;

  const handleJump = (item: ProjectSearchItem) => {
    if (item.kind === "show") {
      void selectShow(item.id);
    } else if (item.kind === "episode") {
      if (item.show_id) void selectShow(item.show_id).then(() => void selectEpisode(item.id));
    } else if (item.kind === "prompt") {
      openLibraryPanel("prompts");
    } else {
      // 搜索结果的实体名单数映射到面板种类（characters/locations/props）。
      const panelKind =
        item.kind === "character" ? "characters" : item.kind === "location" ? "locations" : "props";
      openLibraryPanel(panelKind);
    }
    onJumped();
  };

  return (
    <div className="project-search-results">
      {searchResults.slice(0, 12).map((item) => (
        <button
          key={`${item.kind}-${item.id}`}
          type="button"
          className="project-search-item"
          onClick={() => handleJump(item)}
        >
          <span className="project-search-kind">{t(searchKindKey(item.kind))}</span>
          <span className="project-search-title">{item.title}</span>
          {item.kind === "prompt" && item.content && (
            <span className="project-search-sub">{item.content}</span>
          )}
          <span className="project-title-spacer" />
          {Icons.arrowRight}
        </button>
      ))}
    </div>
  );
}
