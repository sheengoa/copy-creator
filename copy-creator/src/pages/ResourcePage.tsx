import ClipboardPage from "./ClipboardPage";

/** 独立展示剪切板中的“暂存”资源。具体卡片和粘贴行为复用剪切板实现。 */
export default function ResourcePage() {
  return <ClipboardPage resourcesOnly />;
}
