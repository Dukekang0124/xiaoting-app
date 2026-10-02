#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""开包校验：确认「已进 www 的修复」真的打进了 APK 资产（不是只改在源码）。

证据口径与项目铁律一致：判「改没生效」看代码构建标记，不看时间戳/文件名。
用法：python verify_apk_fixes.py <apk路径> <版本号，如 1.6.16>
判据按版本自动生成；跨版本通用的修复项恒检。
"""
import re
import sys
import zipfile

apk = sys.argv[1] if len(sys.argv) > 1 else "apk-dist/Xiaoting-v1.6.16-release.apk"
VER = sys.argv[2] if len(sys.argv) > 2 else "1.6.16"

z = zipfile.ZipFile(apk)
asset_js = [n for n in z.namelist() if n.startswith("assets/public/js/") and n.endswith(".js")]
print("APK:", apk, "| 版本判据:", VER)
print("assets/public/js/*.js 数量:", len(asset_js))
print("电容插件注册文件:", [n for n in z.namelist() if "capacitor.plugins.json" in n])


def find(name):
    hits = [n for n in asset_js if name in n]
    return hits[0] if hits else None


def read(p):
    return z.read(p).decode("utf-8", "replace") if p else ""


checks = []


def ck(name, ok, detail=""):
    checks.append((name, ok, detail))
    print(("  OK  " if ok else "  FAIL") + f" {name}" + (f"  {detail}" if detail else ""))


print(f"\n--- v{VER} 修复进包校验 ---")

# ===== 跨版本通用：轻提醒「假不支持」根治（v1.6.16） =====
p = find("notify")
s = read(p)
ck("notify·不裸 import 原生插件（无构建 WebView 解析不了裸说明符）",
   not re.search(r"""import\(\s*['"]@capacitor/""", s), f"{p}")
ck("notify·从 Capacitor 插件表取插件（同步读取、不缓存，适配 bridge 晚就绪）",
   "window.Capacitor.Plugins" in s)
ck("notify·preferredHour 用 new Date(t) 吃 ISO 字符串（不再 Number() 变 NaN）",
   re.search(r"new Date\(t\)", s) is not None)
ck("notify·时段数据源读真实存在的 state.timelines/cards（不再读不存在的 user.*）",
   "s.timelines && s.timelines.length" in s and "u.timeline ||" not in s)
ck("notify·对外暴露 unsupportedReason（让 UI 能按原因说话）", "unsupportedReason" in s)

p = find("app")
s = read(p)
ck("app.js 冷启动按 notify_on 补挂 notify.sync（不能只在开关 change 里调一次）",
   "notify_on === true) notify.sync(true)" in s)
ck("app.js UI 按 unsupportedReason 分流文案（装了 App 不再被提示「需安装 App」）",
   "unsupportedReason() === 'plugin_missing'" in s and "轻提醒插件没能装载" in s)
ck("changelog 页含协议正文（privacyBlockHtml 复用）",
   "function privacyBlockHtml" in s and "用户协议 / 隐私政策" in s)

p = find("update")
s = read(p)
ck("update.js Web 端跳过 /api/version/* 候选（公开站纯静态无后端，必 404）",
   "p.startsWith('/api/') && !isNativeApp()" in s)

p = find("copywriting")
s = read(p)
confirm_lines = [ln for ln in s.splitlines() if "confirm:" in ln]
ck("wipe 文案不再谎报云端（只看 confirm 行；文件里残留的是说明性注释）",
   all("云端记录将同步清除" not in ln for ln in confirm_lines),
   f"confirm 行数={len(confirm_lines)}")
ck("wipe 文案如实说明本机存储", "本来就只存在这台设备上" in s)

p = find("state-machine")
ck("state-machine 已清 autoDeleteAudio / ttsHint 死键",
   "autoDeleteAudio:" not in read(p) and "ttsHint:" not in read(p))

p = find("api")
s = read(p)
ck("api.js 已清 recordUpload/cardList/cardGet",
   "recordUpload(" not in s and "cardList(" not in s and "cardGet(" not in s)
ck("api.js 保留 aiDebug（探针在用，非死代码）", "aiDebug(" in s)

# ===== 版本判据（随参数走）=====
p = find("app")
s = read(p)
ck(f"app.js 版本占位 = {VER}", f"'{VER}'" in s, f"{p}")
p = find("update")
s = read(p)
ck(f"update.js LATEST_VERSION = {VER}", f"LATEST_VERSION = '{VER}'" in s)
ck(f"update.js fallback APK 指向 Xiaoting-v{VER}-release.apk",
   f"Xiaoting-v{VER}-release.apk" in s)

bad = [n for n, ok, _ in checks if not ok]
print(f"\n结果: {len(checks) - len(bad)}/{len(checks)} 通过")
sys.exit(1 if bad else 0)
