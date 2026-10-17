#!/usr/bin/env python3
"""Copy Creator — 径向窗口输入区域诊断(取证用)。

背景:Linux 常驻模型下,径向菜单窗口隐藏后仍映射在屏幕上,"隐形"依赖
X11 input shape 清空(点击穿透)。若该机制在任何时序下失效,屏幕上会
出现一块看不见但拦截点击的区域——用户感知为"桌面某些区域无法点击"。

用法(怀疑出现隐形拦截区时立即运行):
    python3 scripts/radial-input-doctor.py

输出:copy-creator 全部映射中的顶层窗口、几何位置、input shape 矩形,
并对"input shape 非空的隐形窗口"(拦截嫌疑)给出醒目标注。输出可直接
贴给开发者,配合 ~/.local/share/com.copycreator.app/logs/ 下同时刻日志
交叉定位。仅支持 X11 会话;纯脚本只读,不修改任何状态。
"""
import os
import subprocess
import sys


def xwininfo_tree():
    try:
        out = subprocess.run(
            ["xwininfo", "-root", "-tree"], capture_output=True, text=True, timeout=10
        ).stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        sys.exit("xwininfo 不可用(需要 x11-utils)")
    return out


def window_ids_from_tree(tree_out):
    """从 xwininfo -tree 输出提取顶层窗口 (id, 行文本)。
    注意:WM_CLASS(("copy-creator" "Copy-creator"))只出现在 -tree 输出,
    xwininfo -id 的输出没有,必须在此处一并提取。"""
    ids = []
    for line in tree_out.splitlines():
        stripped = line.strip()
        if not stripped.startswith("0x"):
            continue
        wid = int(stripped.split()[0], 16)
        depth = (len(line) - len(line.lstrip())) // 2
        ids.append((depth, wid, stripped))
    # 只取缩进最浅层(顶层窗口)
    if not ids:
        return []
    top_depth = min(d for d, _, _ in ids)
    return [(wid, text) for d, wid, text in ids if d == top_depth]


def window_info(wid):
    out = subprocess.run(
        ["xwininfo", "-id", str(wid)], capture_output=True, text=True, timeout=10
    ).stdout
    info = {}
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("Width:"):
            info["width"] = int(line.split()[-1])
        elif line.startswith("Height:"):
            info["height"] = int(line.split()[-1])
        elif line.startswith("Absolute upper-left X:"):
            info["x"] = int(line.split()[-1])
        elif line.startswith("Absolute upper-left Y:"):
            info["y"] = int(line.split()[-1])
        elif line.startswith("Map State:"):
            info["map"] = line.split()[-1]
        elif line.startswith("Depth:"):
            info["depth"] = int(line.split()[-1])
    return info


def input_shape_rects(wid):
    """读 X11 Shape 扩展的 input shape 矩形列表。返回 None 表示扩展不可用。"""
    try:
        from Xlib import display
        from Xlib.ext import shape
    except ImportError:
        return None
    d = display.Display()
    w = d.create_resource_object("window", wid)
    resp = shape.get_rectangles(w, shape.SK.Input)
    return [(r.x, r.y, r.width, r.height) for r in resp.rectangles]


def main():
    if os.environ.get("XDG_SESSION_TYPE") != "x11":
        print(f"提示: 当前会话为 {os.environ.get('XDG_SESSION_TYPE')},"
              "本脚本仅对 X11 会话有意义")

    tree = xwininfo_tree()
    top_ids = window_ids_from_tree(tree)
    if not top_ids:
        sys.exit("未找到任何顶层窗口")

    intercept_found = False
    seen_app_window = False
    for wid, tree_line in top_ids:
        # WM_CLASS 识别来自 -tree 行;1x1/10x10 的 GTK/DBus 辅助窗口跳过。
        if '"copy-creator"' not in tree_line:
            continue
        info = window_info(wid)
        if info.get("map") != "IsViewable":
            continue
        if info.get("width", 0) <= 50 or info.get("height", 0) <= 50:
            continue
        seen_app_window = True
        rects = input_shape_rects(wid)
        if rects is None:
            print("需要 python-xlib(pip install python3-xlib)才能读 input shape")
            sys.exit(1)
        label = f"0x{wid:x} {info['width']}x{info['height']}+{info['x']}+{info['y']}"
        if not rects:
            print(f"[穿透正常] {label}  input shape = 空(点击全部穿透)")
            continue
        intercept_found = True
        print(f"[拦截区] {label}(若此刻径向菜单正显示在屏幕上,这属于菜单"
              "本身,正常;菜单已隐藏时则为缺陷现场)")
        for x, y, w, h in rects:
            print(f"    拦截区: 相对窗口 ({x},{y}) {w}x{h}"
                  f"  → 屏幕 ({info['x'] + x},{info['y'] + y}) {w}x{h}")

    if not seen_app_window:
        print("未发现映射中的 copy-creator 可见窗口(应用未运行或全部隐藏)")
        return
    if intercept_found:
        print("\n结论:存在 input shape 非空的 copy-creator 窗口。若屏幕上没有"
              "可见的径向菜单,即复现'隐形拦截区'缺陷——请原样保留本输出,"
              "并同时收集同时刻应用日志:~/.local/share/com.copycreator.app/logs/")
    else:
        print("\n结论:当前无 input shape 非空的 copy-creator 窗口,看不到拦截区。"
              "下次出现'某些区域点不动'时立即运行本脚本取证。")


if __name__ == "__main__":
    main()
