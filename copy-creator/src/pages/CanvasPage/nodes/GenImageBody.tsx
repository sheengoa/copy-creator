import { useTranslation } from "react-i18next";
import { Icons } from "../../../components/Icons";
import { useCanvasStore } from "../../../stores/canvasStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { GenAuroraStage } from "./GenAuroraStage";
import { useGenRuntime } from "./genRuntimeCtx";
import { commitImageParams, formatSizeDisplay, MODEL_PRESET_BASE, sizePresetItemsFor } from "./genParams";
import { ResourceThumb } from "./media";
import { useNodeErrors } from "./nodeErrors";
import { NodeHint } from "./NodeHint";
import { ParamCombo } from "./ParamCombo";
import { genReadinessOf } from "./upstream";
import type { NodeProps } from "./types";

// 图像生成节点内容层（家族最厚的一块）：参数区（模型/尺寸/张数，生成中
// 溜走收合）→ 等待编排（流光舞台全程接管）→ 完成态（主图大图 + 横滑胶片
// 条，点小图换主图）→ 底部动作行双层换位（发起 / 生成中+取消）。
// 等待编排相位机与批量队列见 genRuntime.tsx。
export function GenImageBody({ node }: NodeProps) {
  const { t } = useTranslation();
  const nodeErrors = useNodeErrors((s) => s.errors);
  const genProgress = useCanvasStore((s) => s.genProgress);
  const nodes = useCanvasStore((s) => s.nodes);
  const connections = useCanvasStore((s) => s.connections);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const cancelGeneration = useCanvasStore((s) => s.cancelGeneration);
  const { genWait, genStarting, startGenerate } = useGenRuntime();
  const aiModel = useSettingsStore((s) => s.aiModel);
  /** 模型占位符兜底：节点未填且设置页默认模型为空时给通用示例名。 */
  const modelFallback = aiModel || "gpt-image-1";
  const meta = node.metadata;
  if (meta.kind !== "gen_image") return null;
  const missing = genReadinessOf(nodes, connections, node, t);
  // 尺寸档位（2026-11-04 按模型分流）：生效模型 = 节点值 → 设置页默认
  // 兜底；gpt-image 只给官方支持项，gemini/自定义给全比例清单。
  const sizeItems = sizePresetItemsFor(meta.params.model || modelFallback, t);
  // 等待编排：快照在册即全程接管节点体——参数收起（溜走）、
  // 流光舞台、槽位谢幕、底部动作行换位。store 条目活着优先读
  // 它（跟得紧），谢幕期读快照（条目已随最终刷新被裁）。
  const wait = genWait[node.id];
  const prog = genProgress[node.id] ?? wait;
  // 动作行换位与原型一致：busy 层亮到退场（exit）为止——融合/
  // 扩散期间仍是「生成中 n/m + 取消」，避免提前露出的重新生成
  // 按钮撞上后端双保险拒绝。
  const busyOn = !!wait && wait.phase !== "exit" && wait.phase !== "land";
  return (
    <div className="fc-node-form">
      <div className={`fc-gen-params${busyOn ? " is-loaded" : ""}`}>
        <div className="fc-load-entry-clip">
          <div className="fc-param">
            <NodeHint text={t("canvas.genModelLabel")} className="fc-param-ico-host" side>
              <span className="fc-param-ico">{Icons.chip}</span>
            </NodeHint>
            <ParamCombo
              comboKey={`gm-${node.id}-${node.updated_at}`}
              value={meta.params.model}
              items={[...new Set([modelFallback, ...MODEL_PRESET_BASE])].map((m) => ({ value: m, label: m }))}
              placeholder={modelFallback}
              toggleTitle={t("canvas.comboPresets")}
              onCommit={(model) => commitImageParams(node, { model })}
            />
          </div>
          <div className="fc-param">
            <NodeHint text={t("canvas.genSizeLabel")} className="fc-param-ico-host" side>
              <span className="fc-param-ico">{Icons.crop}</span>
            </NodeHint>
            <ParamCombo
              comboKey={`gs-${node.id}-${node.updated_at}`}
              value={meta.params.size}
              items={sizeItems}
              placeholder="auto"
              display={(v) => formatSizeDisplay(v, sizeItems)}
              toggleTitle={t("canvas.comboPresets")}
              onCommit={(size) => commitImageParams(node, { size })}
            />
            <NodeHint text={t("canvas.genCountLabel")} side>
              <div className="fc-stepper">
                <button
                  type="button"
                  className="fc-stepper-btn"
                  disabled={meta.params.count <= 1}
                  aria-label={t("canvas.genCountLabel")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => commitImageParams(node, { count: Math.max(1, meta.params.count - 1) })}
                >
                  {Icons.minus}
                </button>
                <span className="fc-stepper-val">{meta.params.count}</span>
                <button
                  type="button"
                  className="fc-stepper-btn"
                  disabled={meta.params.count >= 15}
                  aria-label={t("canvas.genCountLabel")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => commitImageParams(node, { count: Math.min(15, meta.params.count + 1) })}
                >
                  {Icons.add}
                </button>
              </div>
            </NodeHint>
          </div>
        </div>
      </div>
      {wait && wait.phase !== "land" && (
        <>
          {/* 生成等待编排（2026-11-01 定案）：执行中到谢幕全程
              只有恒定加高的流光独占——到齐的融合/绽放就在这条
              流光里完成，不示任何缩略图行；exit 流光淡出，land
              直接落成完成态（缩略图即完成态胶片条），两态直切
              无中间帧。 */}
          <GenAuroraStage
            phase={wait.phase}
            total={prog.total}
            received={prog.received}
            celebrated={wait.celebrated}
          />
        </>
      )}
      {/* 完成态产物区（2026-11-01 定稿；2026-11-02 砍掉主图点开
          大图——生成节点内只做缩略图级预览，看大图走下游预览/
          保存节点）：主图大图 + 横滑胶片条。大图即当前主图，
          只随切换换图不可点；点小图换主图；仅 1 张时胶片条隐
          藏，多张也只占一行，节点高度恒定。只在落定（land 或
          无等待编排）后现身——执行/谢幕期不预渲染，避免结果
          与流光同屏（两态直切，无中间帧）。 */}
      {(!wait || wait.phase === "land") &&
        meta.images.length > 0 &&
        (() => {
          const primary = [...meta.images]
            .map((img, i) => ({ img, i }))
            .sort((a, b) => (a.img.primary === b.img.primary ? 0 : a.img.primary ? -1 : 1))[0];
          return (
            <div className={`fc-gen-result${wait?.phase === "land" ? " is-land" : ""}`}>
              <div className="fc-gen-hero">
                <ResourceThumb path={primary.img.resource_path} className="fc-gen-hero-img" />
                {meta.images.length > 1 && (
                  <span className="fc-gen-hero-badge">{t("canvas.genPrimary")}</span>
                )}
              </div>
              {meta.images.length > 1 && (
                <div className="fc-gen-strip">
                  {meta.images.map((thumb, i) => (
                    <NodeHint
                      key={i}
                      className="fc-gen-strip-item"
                      text={thumb.primary ? t("canvas.genPrimary") : t("canvas.genSetPrimary")}
                    >
                      <button
                        type="button"
                        className={`fc-gen-strip-thumb${thumb.primary ? " primary" : ""}`}
                        onClick={() => {
                          const images = meta.images.map((img, j) => ({ ...img, primary: j === i }));
                          void updateNode(node.id, {
                            metadata: JSON.stringify({ ...meta, images }),
                          });
                        }}
                      >
                        <ResourceThumb path={thumb.resource_path} className="fc-strip-img" />
                      </button>
                    </NodeHint>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      <div className="fc-gen-foot">
        <div className={`fc-gen-layer${busyOn ? "" : " is-on"}`}>
          {meta.images.length > 0 && (
            <span className="fc-gen-summary">{t("canvas.genCountSummary", { count: meta.images.length })}</span>
          )}
          <NodeHint text={missing.length > 0 ? t("canvas.genNotReady", { items: missing.join("、") }) : ""}>
            {/* 完成态重生成 = 定稿样式：中性胶囊 + 蓝色刷新图标，
                与「生成」的实心 accent 区分开——一个是发起，一个是再来一次。 */}
            <button
              className={`fc-node-btn${meta.status === "done" ? " ghost fc-gen-regen" : " accent"}`}
              disabled={genStarting || missing.length > 0}
              onClick={() => void startGenerate(node)}
            >
              {meta.status === "done" && <span className="fc-gen-regen-ico">{Icons.refresh}</span>}
              {meta.status === "done" ? t("canvas.regenerate") : t("canvas.genButton")}
            </button>
          </NodeHint>
        </div>
        {prog && (
          <div className={`fc-gen-layer${busyOn ? " is-on" : ""}`}>
            <span className="fc-gen-summary" aria-live="polite">
              {t("canvas.generating")} {prog.received + prog.errors}/{prog.total}
            </span>
            <button
              className="fc-node-btn ghost fc-gen-cancel"
              onClick={() => void cancelGeneration(prog.requestId)}
            >
              {t("canvas.cancelGen")}
            </button>
          </div>
        )}
      </div>
      {nodeErrors[node.id] && <div className="fc-gen-warn">{nodeErrors[node.id]}</div>}
      {meta.status === "error" && meta.error && (
        <div className={`fc-gen-warn${meta.error.startsWith("已取消") ? " is-muted" : ""}`}>{meta.error}</div>
      )}
    </div>
  );
}
