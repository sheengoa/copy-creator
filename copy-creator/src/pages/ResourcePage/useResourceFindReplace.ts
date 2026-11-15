// 详情页查找替换子系统（编辑模式，Ctrl+F 开关）：匹配定位、
// 查找条 fixed 定位跟随（按内容区 stage 实时视口位置钉右上角）、
// 逐个/全部替换与索引游标推进。
// 自 ResourceDetailPage.tsx 拆出（2026-11-14，架构守卫规则 27 行数上限）。
// 编辑态（contentEditing/contentDraft/setContentDraft/setContentSaveError）、
// stage 与正文编辑器 ref、页面级滚动容器定位器经 params 注入。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { findMatchPositions } from "../../utils/findReplace";

export function useResourceFindReplace({
  contentEditing,
  contentDraft,
  setContentDraft,
  setContentSaveError,
  stageRef,
  contentEditorRef,
  findPageScroller,
}: {
  contentEditing: boolean;
  contentDraft: string;
  setContentDraft: (draft: string) => void;
  setContentSaveError: (error: string | null) => void;
  stageRef: RefObject<HTMLElement | null>;
  contentEditorRef: RefObject<HTMLTextAreaElement | null>;
  findPageScroller: () => HTMLElement | null;
}) {
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findReplaceText, setFindReplaceText] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  // 查找条 fixed 定位：按内容区（stage）的实时视口位置钉在其右上角，
  // 随页面滚动/窗口缩放持续跟随（信息面板与窗口头不被遮挡）。
  const [findBarPos, setFindBarPos] = useState({ top: 120, right: 24 });
  const findMatches = useMemo(
    () => (contentEditing ? findMatchPositions(contentDraft, findQuery, findCaseSensitive) : []),
    [contentEditing, contentDraft, findQuery, findCaseSensitive],
  );

  useEffect(() => {
    if (!findOpen || !contentEditing) return;
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const rect = stage.getBoundingClientRect();
      setFindBarPos((prev) => {
        const next = {
          top: Math.max(rect.top + 20, 76),
          right: Math.max(window.innerWidth - rect.right + 28, 14),
        };
        return prev.top === next.top && prev.right === next.right ? prev : next;
      });
    };
    update();
    const scroller = findPageScroller();
    scroller?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      scroller?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [findOpen, contentEditing, findPageScroller, stageRef]);

  // 选中指定匹配并滚到可视区：textarea 自动增高、无内部滚动，页面级
  // 滚动容器按匹配所在行手工定位——浏览器对 focus 的默认呈现不保证
  // 滚到选区（用户实测「下一个匹配」不跳转）。
  const focusFindMatch = useCallback((start: number, end: number) => {
    const textarea = contentEditorRef.current;
    if (!textarea) return;
    textarea.setSelectionRange(start, end);
    textarea.focus();
    const scroller = findPageScroller();
    if (!scroller) return;
    const style = window.getComputedStyle(textarea);
    const lineHeight =
      Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 20;
    const line = (contentDraft.slice(0, start).match(/\n/g) ?? []).length;
    const textareaRect = textarea.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const target =
      textareaRect.top - scrollerRect.top + scroller.scrollTop + line * lineHeight + 8;
    scroller.scrollTop = Math.max(0, target - scroller.clientHeight / 3);
  }, [contentDraft, findPageScroller, contentEditorRef]);

  const goToFindMatch = useCallback((index: number) => {
    if (findMatches.length === 0) return;
    const wrapped = ((index % findMatches.length) + findMatches.length) % findMatches.length;
    setFindIndex(wrapped);
    const start = findMatches[wrapped];
    focusFindMatch(start, start + findQuery.length);
  }, [findMatches, findQuery, focusFindMatch]);

  // 查询/大小写变化只更新计数与索引：textarea 无法在不移动光标的
  // 前提下高亮匹配，若此处抢焦点选区，会把用户正在查找输入框打的字
  // 截进正文（曾实测「打着字光标突然跳走」）。定位只发生在显式导航。
  const handleFindQueryChange = useCallback((query: string) => {
    setFindQuery(query);
    setFindIndex(0);
  }, []);

  const handleFindCaseSensitiveChange = useCallback((nextCaseSensitive: boolean) => {
    setFindCaseSensitive(nextCaseSensitive);
    setFindIndex(0);
  }, []);

  const handleFindReplaceCurrent = useCallback(() => {
    if (findMatches.length === 0 || findQuery === "") return;
    const index = Math.min(findIndex, findMatches.length - 1);
    const start = findMatches[index];
    const nextDraft =
      contentDraft.slice(0, start) + findReplaceText + contentDraft.slice(start + findQuery.length);
    setContentDraft(nextDraft);
    setContentSaveError(null);
    const positions = findMatchPositions(nextDraft, findQuery, findCaseSensitive);
    const shifted = positions.findIndex((position) => position >= start + findReplaceText.length);
    const target = shifted === -1 ? 0 : shifted;
    setFindIndex(target);
    if (positions.length > 0) focusFindMatch(positions[target], positions[target] + findQuery.length);
  }, [contentDraft, findMatches, findIndex, findQuery, findReplaceText, findCaseSensitive, focusFindMatch, setContentDraft, setContentSaveError]);

  const handleFindReplaceAll = useCallback(() => {
    if (findMatches.length === 0 || findQuery === "") return;
    let result = "";
    let cursor = 0;
    for (const position of findMatches) {
      result += contentDraft.slice(cursor, position) + findReplaceText;
      cursor = position + findQuery.length;
    }
    result += contentDraft.slice(cursor);
    setContentDraft(result);
    setContentSaveError(null);
    setFindIndex(0);
    contentEditorRef.current?.focus();
  }, [contentDraft, findMatches, findQuery, findReplaceText, contentEditorRef, setContentDraft, setContentSaveError]);

  return {
    findOpen,
    setFindOpen,
    findQuery,
    findReplaceText,
    setFindReplaceText,
    findCaseSensitive,
    findIndex,
    findBarPos,
    findMatches,
    goToFindMatch,
    handleFindQueryChange,
    handleFindCaseSensitiveChange,
    handleFindReplaceCurrent,
    handleFindReplaceAll,
  };
}
