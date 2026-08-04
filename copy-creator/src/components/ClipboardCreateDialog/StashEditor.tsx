import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface StashImage {
  id: string;
  dataUrl: string;
  pending?: boolean;
  sourcePath?: string;
}

export interface StashEditorHandle {
  focus: () => void;
}

interface Props {
  initialContent: string;
  initialImages: StashImage[];
  placeholder: string;
  previewAlt: string;
  closePreviewLabel: string;
  onChange: (content: string, images: StashImage[]) => void;
  onImageError: () => void;
}

interface EditorSnapshot {
  content: string;
  images: StashImage[];
  html: string;
  selection: EditorSelectionSnapshot | null;
}

interface EditorSelectionSnapshot {
  startPath: number[];
  startOffset: number;
  endPath: number[];
  endOffset: number;
}

const CARET_ANCHOR = "\u200B";
const IMAGE_PLACEHOLDER = "\uFFFC";
const HISTORY_LIMIT = 100;

const createImageMarker = (image: StashImage, index: number) => {
  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = "clipboard-create-image-marker";
  marker.contentEditable = "false";
  marker.dataset.imageId = image.id;
  if (image.pending) marker.dataset.pending = "true";
  marker.textContent = `[Image #${index + 1}]`;
  return marker;
};

const createCaretAnchor = () => document.createTextNode(CARET_ANCHOR);

const getEditorContent = (editor: HTMLDivElement) => {
  const markers = Array.from(editor.querySelectorAll<HTMLElement>("[data-image-id]"));
  const labels = markers.map((marker) => marker.textContent || "");
  markers.forEach((marker) => { marker.textContent = IMAGE_PLACEHOLDER; });
  const content = editor.innerText.replaceAll(CARET_ANCHOR, "");
  markers.forEach((marker, index) => { marker.textContent = labels[index]; });
  return content;
};

const removeImageMarker = (marker: HTMLElement) => {
  const anchor = marker.nextSibling;
  if (anchor instanceof Text && anchor.data.startsWith(CARET_ANCHOR)) {
    anchor.data = anchor.data.slice(CARET_ANCHOR.length);
    if (anchor.length === 0) anchor.remove();
  }
  marker.remove();
};

const removeOrphanCaretAnchors = (editor: HTMLDivElement) => {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) textNodes.push(current);
    current = walker.nextNode();
  }
  textNodes.forEach((node) => {
    if (!node.data.includes(CARET_ANCHOR)) return;
    const followsMarker = node.previousSibling instanceof HTMLElement
      && node.previousSibling.matches("[data-image-id]");
    const text = node.data.replaceAll(CARET_ANCHOR, "");
    node.data = followsMarker ? `${CARET_ANCHOR}${text}` : text;
    if (node.length === 0) node.remove();
  });
};

const readImage = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

const placeCaretAtEnd = (editor: HTMLDivElement) => {
  const applySelection = () => {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let lastTextNode: Text | null = null;
    let current = walker.nextNode();
    while (current) {
      if (current instanceof Text && current.length > 0) lastTextNode = current;
      current = walker.nextNode();
    }
    if (lastTextNode) {
      range.setStart(lastTextNode, lastTextNode.length);
    } else {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  editor.focus();
  applySelection();
  requestAnimationFrame(applySelection);
};

const placeCaretInAnchor = (editor: HTMLDivElement, anchor: Text) => {
  const applySelection = () => {
    if (!anchor.isConnected) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.setStart(anchor, anchor.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  editor.focus();
  applySelection();
  requestAnimationFrame(applySelection);
};

const getLastContentRect = (editor: HTMLDivElement) => {
  const range = document.createRange();
  range.selectNodeContents(editor);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (rects.length > 0) return rects[rects.length - 1];
  return editor.querySelector<HTMLElement>("[data-image-id]:last-of-type")?.getBoundingClientRect() || null;
};

const cloneImages = (images: StashImage[]) => images.map((image) => ({ ...image }));

const imagesEqual = (left: StashImage[], right: StashImage[]) => (
  left.length === right.length
  && left.every((image, index) => (
    image.id === right[index].id
    && image.dataUrl === right[index].dataUrl
    && image.pending === right[index].pending
    && image.sourcePath === right[index].sourcePath
  ))
);

const getNodePath = (editor: HTMLDivElement, node: Node) => {
  const path: number[] = [];
  let current: Node | null = node;
  while (current && current !== editor) {
    const parent: ParentNode | null = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current) as number);
    current = parent as Node;
  }
  return current === editor ? path : null;
};

const getNodeAtPath = (editor: HTMLDivElement, path: number[]) => {
  let current: Node = editor;
  for (const index of path) {
    const child = current.childNodes[index];
    if (!child) return null;
    current = child;
  }
  return current;
};

const captureEditorSelection = (editor: HTMLDivElement): EditorSelectionSnapshot | null => {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const startPath = getNodePath(editor, range.startContainer);
  const endPath = getNodePath(editor, range.endContainer);
  if (!startPath || !endPath) return null;
  return {
    startPath,
    startOffset: range.startOffset,
    endPath,
    endOffset: range.endOffset,
  };
};

const restoreEditorSelection = (
  editor: HTMLDivElement,
  snapshot: EditorSelectionSnapshot | null,
) => {
  if (!snapshot) return false;
  const startNode = getNodeAtPath(editor, snapshot.startPath);
  const endNode = getNodeAtPath(editor, snapshot.endPath);
  if (!startNode || !endNode) return false;
  const startLimit = startNode instanceof Text ? startNode.length : startNode.childNodes.length;
  const endLimit = endNode instanceof Text ? endNode.length : endNode.childNodes.length;
  if (snapshot.startOffset > startLimit || snapshot.endOffset > endLimit) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.setStart(startNode, snapshot.startOffset);
  range.setEnd(endNode, snapshot.endOffset);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

const createSnapshot = (
  editor: HTMLDivElement,
  content: string,
  images: StashImage[],
): EditorSnapshot => ({
  content,
  images: cloneImages(images),
  html: editor.innerHTML,
  selection: captureEditorSelection(editor),
});

const findAdjacentImageMarker = (range: Range, key: "Backspace" | "Delete") => {
  if (!range.collapsed) return null;
  const container = range.startContainer;
  const moveSibling = (node: ChildNode | null) => (key === "Backspace" ? node?.previousSibling : node?.nextSibling) || null;
  let candidate: ChildNode | null;

  if (container instanceof Text) {
    const isAfterAnchor = key === "Backspace"
      && container.data.startsWith(CARET_ANCHOR)
      && range.startOffset === CARET_ANCHOR.length;
    const atBoundary = key === "Backspace"
      ? range.startOffset === 0 || isAfterAnchor
      : range.startOffset === container.length;
    if (!atBoundary) return null;
    candidate = moveSibling(container);
  } else {
    candidate = key === "Backspace"
      ? container.childNodes[range.startOffset - 1] || null
      : container.childNodes[range.startOffset] || null;
  }

  while (candidate instanceof Text && candidate.length === 0) {
    candidate = moveSibling(candidate);
  }
  return candidate instanceof HTMLElement && candidate.matches("[data-image-id]")
    ? candidate
    : null;
};

const StashEditor = forwardRef<StashEditorHandle, Props>(function StashEditor({
  initialContent,
  initialImages,
  placeholder,
  previewAlt,
  closePreviewLabel,
  onChange,
  onImageError,
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const initialContentRef = useRef(initialContent);
  const initialImagesRef = useRef(initialImages);
  const imagesRef = useRef(initialImages);
  const onChangeRef = useRef(onChange);
  const historyRef = useRef<EditorSnapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const suppressHistoryRef = useRef(false);
  const inputBatchRef = useRef(false);
  const inputBatchTimerRef = useRef<number | null>(null);
  const previewSelectionRef = useRef<EditorSelectionSnapshot | null>(null);
  const [previewImage, setPreviewImage] = useState<StashImage | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => () => {
    if (inputBatchTimerRef.current !== null) {
      window.clearTimeout(inputBatchTimerRef.current);
    }
  }, []);

  const renderPersistedContent = useCallback((content: string, images: StashImage[]) => {
    const editor = editorRef.current;
    if (!editor) return;
    imagesRef.current = cloneImages(images);
    editor.replaceChildren();

    const usesObjectPlaceholders = content.includes(IMAGE_PLACEHOLDER);
    let remaining = content;
    const missingImages: Array<{ image: StashImage; index: number }> = [];
    imagesRef.current.forEach((image, index) => {
      const token = usesObjectPlaceholders ? IMAGE_PLACEHOLDER : `[Image #${index + 1}]`;
      const position = remaining.indexOf(token);
      if (position === -1) {
        missingImages.push({ image, index });
        return;
      }
      editor.append(document.createTextNode(remaining.slice(0, position)));
      editor.append(createImageMarker(image, index));
      editor.append(createCaretAnchor());
      remaining = remaining.slice(position + token.length);
    });
    editor.append(document.createTextNode(remaining));
    missingImages.forEach(({ image, index }) => {
      editor.append(createImageMarker(image, index));
      editor.append(createCaretAnchor());
    });
  }, []);

  const restoreSnapshot = useCallback((snapshot: EditorSnapshot) => {
    const editor = editorRef.current;
    if (!editor) return;
    imagesRef.current = cloneImages(snapshot.images);
    editor.innerHTML = snapshot.html;
    editor.focus();
    if (!restoreEditorSelection(editor, snapshot.selection)) placeCaretAtEnd(editor);
  }, []);

  const pushHistorySnapshot = useCallback((content: string, images: StashImage[]) => {
    if (suppressHistoryRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const nextSnapshot = createSnapshot(editor, content, images);
    const currentSnapshot = historyRef.current[historyIndexRef.current];
    if (
      currentSnapshot
      && currentSnapshot.content === nextSnapshot.content
      && imagesEqual(currentSnapshot.images, nextSnapshot.images)
    ) {
      historyRef.current[historyIndexRef.current] = nextSnapshot;
      return;
    }
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    historyRef.current.push(nextSnapshot);
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    historyIndexRef.current = historyRef.current.length - 1;
  }, []);

  const syncEditor = useCallback((recordHistory = true) => {
    const editor = editorRef.current;
    if (!editor) return;
    const imageMap = new Map(imagesRef.current.map((image) => [image.id, image]));
    const markers = Array.from(editor.querySelectorAll<HTMLElement>("[data-image-id]"));
    let imageIndex = 0;
    const orderedImages = markers.flatMap((marker) => {
      const image = imageMap.get(marker.dataset.imageId || "");
      if (!image) {
        removeImageMarker(marker);
        return [];
      }
      imageIndex += 1;
      const token = `[Image #${imageIndex}]`;
      if (marker.textContent !== token) marker.textContent = token;
      return [image];
    });
    imagesRef.current = orderedImages;
    const content = getEditorContent(editor);
    if (recordHistory) pushHistorySnapshot(content, orderedImages);
    onChangeRef.current(content, orderedImages);
  }, [pushHistorySnapshot]);

  const finishInputBatch = useCallback(() => {
    if (inputBatchTimerRef.current !== null) {
      window.clearTimeout(inputBatchTimerRef.current);
      inputBatchTimerRef.current = null;
    }
    if (!inputBatchRef.current) return;
    inputBatchRef.current = false;
    syncEditor();
  }, [syncEditor]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const seededContent = initialContentRef.current;
    const seededImages = initialImagesRef.current;
    renderPersistedContent(seededContent, seededImages);
    placeCaretAtEnd(editor);
    const content = getEditorContent(editor);
    historyRef.current = [createSnapshot(editor, content, imagesRef.current)];
    historyIndexRef.current = 0;
    onChangeRef.current(content, cloneImages(imagesRef.current));
  }, [renderPersistedContent]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (editorRef.current) placeCaretAtEnd(editorRef.current);
    },
  }), []);

  useEffect(() => {
    if (previewImage) previewRef.current?.focus();
  }, [previewImage]);

  const closePreview = useCallback(() => {
    setPreviewImage(null);
    const restoreFocus = () => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      if (!restoreEditorSelection(editor, previewSelectionRef.current)) placeCaretAtEnd(editor);
    };
    restoreFocus();
    requestAnimationFrame(restoreFocus);
  }, []);

  const insertNodes = useCallback((nodes: Node[], range?: Range) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    const insertionRange = range || (selection?.rangeCount ? selection.getRangeAt(0) : undefined);
    const targetRange = insertionRange instanceof Range ? insertionRange : document.createRange();
    if (!(insertionRange instanceof Range)) {
      targetRange.selectNodeContents(editor);
      targetRange.collapse(false);
    }
    targetRange.deleteContents();
    nodes.forEach((node) => {
      targetRange.insertNode(node);
      targetRange.setStartAfter(node);
      targetRange.collapse(true);
    });
    selection?.removeAllRanges();
    selection?.addRange(targetRange);
    syncEditor();
  }, [syncEditor]);

  const insertPendingImages = useCallback((count: number, range?: Range) => {
    const added = Array.from({ length: count }, (_, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      dataUrl: "",
      pending: true,
    }));
    const nextImages = [...imagesRef.current, ...added];
    imagesRef.current = nextImages;
    const anchors: Text[] = [];
    const nodes = added.flatMap((image) => {
      const anchor = createCaretAnchor();
      anchors.push(anchor);
      return [createImageMarker(image, nextImages.indexOf(image)), anchor];
    });
    insertNodes(nodes, range);
    const editor = editorRef.current;
    const lastAnchor = anchors[anchors.length - 1];
    if (editor && lastAnchor) {
      placeCaretInAnchor(editor, lastAnchor);
      syncEditor();
    }
    return added;
  }, [insertNodes, syncEditor]);

  const resolvePendingImages = useCallback((pendingImages: StashImage[], dataUrls: string[]) => {
    const resolved = new Map(pendingImages.map((image, index) => [image.id, dataUrls[index]]));
    imagesRef.current = imagesRef.current.map((image) => {
      const dataUrl = resolved.get(image.id);
      return dataUrl === undefined ? image : { ...image, dataUrl, pending: false };
    });
    pendingImages.forEach((image) => {
      editorRef.current
        ?.querySelector<HTMLElement>(`[data-image-id="${CSS.escape(image.id)}"]`)
        ?.removeAttribute("data-pending");
    });
    syncEditor(false);
    historyRef.current = historyRef.current.map((snapshot) => {
      const nextImages = snapshot.images.map((image) => {
        const dataUrl = resolved.get(image.id);
        return dataUrl === undefined ? image : { ...image, dataUrl, pending: false };
      });
      if (imagesEqual(snapshot.images, nextImages)) return snapshot;
      const container = document.createElement("div");
      container.innerHTML = snapshot.html;
      pendingImages.forEach((image) => {
        container
          .querySelector<HTMLElement>(`[data-image-id="${CSS.escape(image.id)}"]`)
          ?.removeAttribute("data-pending");
      });
      return { ...snapshot, images: nextImages, html: container.innerHTML };
    });
  }, [syncEditor]);

  const removePendingImages = useCallback((pendingImages: StashImage[]) => {
    const ids = new Set(pendingImages.map((image) => image.id));
    imagesRef.current = imagesRef.current.filter((image) => !ids.has(image.id));
    pendingImages.forEach((image) => {
      const marker = editorRef.current
        ?.querySelector<HTMLElement>(`[data-image-id="${CSS.escape(image.id)}"]`);
      if (marker) removeImageMarker(marker);
    });
    syncEditor();
    const editor = editorRef.current;
    if (editor) {
      historyRef.current = [createSnapshot(editor, getEditorContent(editor), imagesRef.current)];
      historyIndexRef.current = 0;
    }
  }, [syncEditor]);

  const handlePaste = useCallback(async (event: React.ClipboardEvent<HTMLDivElement>) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .flatMap((item) => item.getAsFile() ? [item.getAsFile()!] : []);
    event.preventDefault();
    finishInputBatch();

    const selection = window.getSelection();
    const savedRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    const text = event.clipboardData.getData("text/plain");
    if (imageFiles.length === 0 && text) {
      insertNodes([document.createTextNode(text)], savedRange);
      return;
    }

    const pendingImages = insertPendingImages(Math.max(imageFiles.length, 1), savedRange);
    try {
      if (imageFiles.length > 0) {
        resolvePendingImages(pendingImages, await Promise.all(imageFiles.map(readImage)));
        return;
      }

      const base64 = await invoke<string>("read_clipboard_image_base64");
      resolvePendingImages(pendingImages, [`data:image/png;base64,${base64}`]);
    } catch (error) {
      removePendingImages(pendingImages);
      console.error("Failed to read pasted image:", error);
      onImageError();
    }
  }, [finishInputBatch, insertNodes, insertPendingImages, onImageError, removePendingImages, resolvePendingImages]);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    finishInputBatch();
    const marker = (event.target as HTMLElement).closest<HTMLElement>("[data-image-id]");
    const editor = editorRef.current;
    if (marker) {
      const image = imagesRef.current.find((item) => item.id === marker.dataset.imageId);
      if (image?.dataUrl) {
        event.preventDefault();
        previewSelectionRef.current = editor ? captureEditorSelection(editor) : null;
        setPreviewImage(image);
      }
      return;
    }

    if (!editor) return;
    const lastRect = getLastContentRect(editor);
    if (!lastRect) return;
    const isOnLastLineAfterContent = event.clientY >= lastRect.top
      && event.clientY <= lastRect.bottom
      && event.clientX >= lastRect.right;
    const isBelowContent = event.clientY > lastRect.bottom;
    if (!isOnLastLineAfterContent && !isBelowContent) return;
    event.preventDefault();
    placeCaretAtEnd(editor);
  }, [finishInputBatch]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z";
    const isRedo = ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "z")
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y");
    if (isUndo || isRedo) {
      event.preventDefault();
      finishInputBatch();
      const nextIndex = isUndo ? historyIndexRef.current - 1 : historyIndexRef.current + 1;
      const snapshot = historyRef.current[nextIndex];
      if (!snapshot) return;
      suppressHistoryRef.current = true;
      historyIndexRef.current = nextIndex;
      restoreSnapshot(snapshot);
      onChangeRef.current(snapshot.content, cloneImages(snapshot.images));
      suppressHistoryRef.current = false;
      return;
    }
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const editor = editorRef.current;
    if (!range.collapsed && editor) {
      const containsImage = Array.from(editor.querySelectorAll<HTMLElement>("[data-image-id]"))
        .some((item) => range.intersectsNode(item));
      if (!containsImage) return;
      event.preventDefault();
      finishInputBatch();
      range.deleteContents();
      range.collapse(true);
      removeOrphanCaretAnchors(editor);
      if (range.startContainer.isConnected) {
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        placeCaretAtEnd(editor);
      }
      syncEditor();
      return;
    }
    const marker = findAdjacentImageMarker(range, event.key);
    const parent = marker?.parentNode;
    if (!marker || !parent || !editor?.contains(marker)) return;

    event.preventDefault();
    finishInputBatch();
    const offset = Array.prototype.indexOf.call(parent.childNodes, marker) as number;
    removeImageMarker(marker);
    range.setStart(parent, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    syncEditor();
  }, [finishInputBatch, restoreSnapshot, syncEditor]);

  const handleBeforeInput = useCallback(() => {
    if (inputBatchRef.current || suppressHistoryRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    pushHistorySnapshot(getEditorContent(editor), imagesRef.current);
    inputBatchRef.current = true;
  }, [pushHistorySnapshot]);

  const handleInput = useCallback(() => {
    syncEditor(false);
    if (inputBatchTimerRef.current !== null) {
      window.clearTimeout(inputBatchTimerRef.current);
    }
    inputBatchTimerRef.current = window.setTimeout(finishInputBatch, 350);
  }, [finishInputBatch, syncEditor]);

  return (
    <>
      <div
        ref={editorRef}
        className="clipboard-create-editor"
        contentEditable
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        suppressContentEditableWarning
        onBeforeInput={handleBeforeInput}
        onInput={handleInput}
        onPaste={handlePaste}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
      />
      {previewImage ? (
        <div
          ref={previewRef}
          className="clipboard-create-image-preview"
          role="dialog"
          aria-modal="true"
          aria-label={previewAlt}
          tabIndex={-1}
          onClick={closePreview}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closePreview();
            }
          }}
        >
          <button
            type="button"
            className="clipboard-create-preview-close"
            onClick={(event) => {
              event.stopPropagation();
              closePreview();
            }}
            aria-label={closePreviewLabel}
          >
            ×
          </button>
          <img
            src={previewImage.dataUrl}
            alt={previewAlt}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
});

export default StashEditor;
