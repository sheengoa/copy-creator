// 原生文件对话框在途守卫：GTK/Win32 文件对话框是独立原生窗口，弹出的
// 瞬间主窗口会失焦。失焦自动隐藏开启时，若不豁免这段在途期，导出备份/
// 迁移存储等流程会在对话框背后把主窗口藏掉。
// 用法：统一经 invokeNativeDialog 打开对话框，Promise 落定（含失败/
// 取消）后自动解除。同一时刻允许嵌套（理论上只有一层）。
import { invoke } from "@tauri-apps/api/core";

let depth = 0;

export const nativeDialogBegin = (): void => {
  depth += 1;
};

export const nativeDialogEnd = (): void => {
  depth = Math.max(0, depth - 1);
};

export const isNativeDialogActive = (): boolean => depth > 0;

/** 打开原生目录/文件对话框的统一入口：自动维护在途守卫。 */
export const invokeNativeDialog = async <T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  nativeDialogBegin();
  try {
    return await invoke<T>(cmd, args);
  } finally {
    nativeDialogEnd();
  }
};
