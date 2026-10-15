import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import type { ClipboardRecord } from "../../types";

export interface TraceRelinkResult {
  id: string;
  resource_path: string;
  resource_relative_path: string | null;
  content: string;
  group_name: string;
  resource_folder: string | null;
}

type TraceStep = "searching" | "unique" | "multi" | "manual" | "picked" | "done" | "error";

interface ResourceTraceDialogProps {
  open: boolean;
  /** 追溯目标：缺失的资源记录（对话框自持流程，成功后经 onRelinked 回传）。 */
  record: ClipboardRecord | null;
  /** 资源库根路径：判断所选文件是否在库外（库外需复制入库）。 */
  libraryPath: string;
  /** 用户取消（done/关闭/返回均会触发）；重链成功先回调 onRelinked 再 onClose。 */
  onClose: () => void;
  onRelinked: (result: TraceRelinkResult) => void;
}

/** 判断所选文件是否位于资源库内（路径前缀比对，大小写不敏感以兼容 Windows）。 */
function isInsideLibrary(path: string, libraryPath: string): boolean {
  if (!libraryPath) return true;
  const normalize = (value: string) => value.replace(/[\\/]+$/, "");
  return normalize(path)
    .toLowerCase()
    .startsWith(normalize(libraryPath).toLowerCase());
}

function fileNameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

/**
 * 缺失文件的追溯对话框：先在库内自动查同名文件（唯一→直接关联；
 * 多个→候选挑选；零个→系统选择器手动指定），库外文件复制入库后再
 * 关联（保持「内容即文件」的库自包含）。成功后缺失标志由后端清零，
 * 列表经 resource-groups-changed 刷新，详情记录由页面按结果修补。
 */
export default function ResourceTraceDialog({
  open,
  record,
  libraryPath,
  onClose,
  onRelinked,
}: ResourceTraceDialogProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<TraceStep>("searching");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(null);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [relinkedName, setRelinkedName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const startSearch = useCallback(async (recordId: string) => {
    const seq = ++requestSeqRef.current;
    setStep("searching");
    setCandidates([]);
    setSelectedCandidate(null);
    setPickedPath(null);
    setErrorMessage(null);
    try {
      const found = await invoke<string[]>("find_resource_trace_candidates", { id: recordId });
      if (seq !== requestSeqRef.current) return;
      setCandidates(found);
      setStep(found.length === 1 ? "unique" : found.length > 1 ? "multi" : "manual");
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      setErrorMessage(String(error));
      setStep("error");
    }
  }, []);

  useEffect(() => {
    if (open && record) {
      void startSearch(record.id);
    }
  }, [open, record, startSearch]);

  if (!open || !record) return null;

  const recordName = record.resource_path
    ? fileNameOf(record.resource_path)
    : record.content;
  const recordFolder = record.resource_folder;

  const pickFile = async () => {
    setBusy(true);
    try {
      const result = await invoke<{ path: string }>("select_resource_trace_file");
      setPickedPath(result.path);
      setStep("picked");
    } catch {
      // 用户取消选择：留在手动步骤。
    } finally {
      setBusy(false);
    }
  };

  const relinkTarget = step === "picked" ? pickedPath : selectedCandidate ?? candidates[0] ?? null;
  const relink = async () => {
    if (!relinkTarget) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const result = await invoke<TraceRelinkResult>("trace_relink_resource", {
        id: record.id,
        targetPath: relinkTarget,
      });
      setRelinkedName(fileNameOf(result.resource_path));
      setStep("done");
      onRelinked(result);
    } catch (error) {
      setErrorMessage(String(error));
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  const targetName = relinkTarget ? fileNameOf(relinkTarget) : "";
  const outsideLibrary = relinkTarget ? !isInsideLibrary(relinkTarget, libraryPath) : false;
  const renamed = Boolean(relinkTarget) && targetName !== recordName;
  const recordAt = t("resources.traceRecordAt", {
    name: recordName,
    path: recordFolder
      ? `${recordFolder}/${recordName}`
      : recordName,
  });

  return (
    <div className="dialog-overlay" onClick={busy ? undefined : onClose}>
      <div className="dialog-content resource-trace-dialog" onClick={(event) => event.stopPropagation()}>
        <h3 className="dialog-title">{t("resources.traceTitle")}</h3>
        <p className="resource-trace-record-sub">{recordAt}</p>

        {step === "searching" && (
          <div className="resource-trace-searching" aria-busy="true">
            <span className="resource-trace-spinner" aria-hidden="true" />
            <span>{t("resources.traceSearching")}</span>
          </div>
        )}

        {step === "unique" && (
          <>
            <div className="dialog-callout ok" role="status">
              {Icons.check}
              <span>{t("resources.traceUniqueFound")}</span>
            </div>
            <div className="resource-trace-field">
              <span>{t("resources.traceMatchedAt")}</span>
              <code>{candidates[0]}</code>
            </div>
            <div className="dialog-actions">
              <button type="button" className="dialog-btn secondary" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="dialog-btn primary"
                disabled={busy}
                onClick={() => void relink()}
              >
                {t("resources.traceRelink")}
              </button>
            </div>
          </>
        )}

        {step === "multi" && (
          <>
            <div className="dialog-callout warn">
              <span className="resource-trace-warn-mark" aria-hidden="true">!</span>
              <span>{t("resources.traceMultiFound")}</span>
            </div>
            <div className="resource-trace-candidates" role="radiogroup" aria-label={t("resources.traceTitle")}>
              {candidates.map((candidate) => (
                <label key={candidate} className="resource-trace-candidate">
                  <input
                    type="radio"
                    name="resource-trace-candidate"
                    checked={selectedCandidate === candidate}
                    onChange={() => setSelectedCandidate(candidate)}
                  />
                  <span className="resource-trace-candidate-path">{candidate}</span>
                </label>
              ))}
            </div>
            <div className="dialog-actions">
              <button type="button" className="dialog-btn secondary" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="dialog-btn primary"
                disabled={busy || !selectedCandidate}
                onClick={() => void relink()}
              >
                {t("resources.traceRelink")}
              </button>
            </div>
          </>
        )}

        {step === "manual" && (
          <>
            <div className="dialog-callout warn">
              <span className="resource-trace-warn-mark" aria-hidden="true">!</span>
              <span>{t("resources.traceNoneFound")}</span>
            </div>
            <div className="dialog-actions">
              <button type="button" className="dialog-btn secondary" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="dialog-btn save"
                disabled={busy}
                onClick={() => void pickFile()}
              >
                {t("resources.tracePickFile")}
              </button>
            </div>
          </>
        )}

        {step === "picked" && pickedPath && (
          <>
            <div className="resource-trace-field">
              <span>{t("resources.tracePickedFile")}</span>
              <code>{pickedPath}</code>
            </div>
            {outsideLibrary && (
              <div className="dialog-callout warn">
                <span className="resource-trace-warn-mark" aria-hidden="true">!</span>
                <span>
                  {t("resources.traceCopyIntoLibrary", {
                    group: recordFolder || t("resources.ungrouped"),
                  })}
                </span>
              </div>
            )}
            {!outsideLibrary && renamed && (
              <div className="dialog-callout warn">
                <span className="resource-trace-warn-mark" aria-hidden="true">!</span>
                <span>{t("resources.traceRenameNote", { name: targetName })}</span>
              </div>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-btn secondary"
                disabled={busy}
                onClick={() => setStep("manual")}
              >
                {t("resources.traceBack")}
              </button>
              <button
                type="button"
                className="dialog-btn primary"
                disabled={busy}
                onClick={() => void relink()}
              >
                {outsideLibrary ? t("resources.traceCopyRelink") : t("resources.traceRelink")}
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <div className="dialog-callout ok" role="status">
              {Icons.check}
              <span>{t("resources.traceRelinked", { name: relinkedName })}</span>
            </div>
            <div className="dialog-actions">
              <button type="button" className="dialog-btn primary" onClick={onClose}>
                {t("resources.traceDone")}
              </button>
            </div>
          </>
        )}

        {step === "error" && (
          <>
            <div className="dialog-callout error" role="alert">
              <span className="resource-trace-warn-mark" aria-hidden="true">!</span>
              <span>{errorMessage ?? t("resources.traceFailed")}</span>
            </div>
            <div className="dialog-actions">
              <button type="button" className="dialog-btn secondary" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="dialog-btn primary"
                disabled={busy}
                onClick={() => record && void startSearch(record.id)}
              >
                {t("common.retry")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
