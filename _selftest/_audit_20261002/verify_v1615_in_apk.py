#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v1.6.15 开包校验：确认 6 处修复真正打进 APK 资产（不是只在源码里）。
证据口径与项目铁律一致：判「改没生效」看代码构建标记，不看时间戳/文件名。
"""
import zipfile, sys, io

APK = sys.argv[1] if len(sys.argv) > 1 else "apk-dist/Xiaoting-v1.6.15-release.apk"

z = zipfile.ZipFile(APK)
names = z.namelist()
asset_js = [n for n in names if n.startswith("assets/public/js/") and n.endswith(".js")]
print("APK:", APK)
print("assets/public/js/*.js 数量:", len(asset_js))
print("电容插件注册文件:", [n for n in names if "capacitor.plugins.json" in n])


def find(pattern, label):
    hits = [n for n in asset_js if pattern in n]
    if not hits:
        print(f"[{label}] ?? 未找到 {pattern}")
        return None
    return hits[0]


def read(path):
    return z.read(path).decode("utf-8", "replace")


checks = []


def ck(name, ok, detail=""):
    checks.append((name, ok, detail))
    print(("  OK  " if ok else "  FAIL") + f" {name}" + (f"  {detail}" if detail else ""))


print("\n--- v1.6.15 修复进包校验 ---")

# 1) notify.js 数据源改读 state.timelines/cards
p = find("notify", "notify.js")
s = read(p) if p else ""
ck("notify.js 读真实存在的 state.timelines/cards",
   "s.timelines && s.timelines.length" in s,
   f"{p}")
ck("notify.js 不再读不存在的 user.timeline", "u.timeline ||" not in s)

# 2) app.js 冷启动补挂 + 协议正文同源
p = find("app", "app.js")
s = read(p) if p else ""
ck("app.js 冷启动按 notify_on 补挂 notify.sync", "notify_on === true) notify.sync(true)" in s, f"{p}")
ck("changelog 页含协议正文（privacyBlockHtml 复用）",
   "function privacyBlockHtml" in s and "用户协议 / 隐私政策" in s)
ck("版本占位为 1.6.15", "'1.6.15'" in s)

# 3) update.js 跳过 /api/ 候选（原生以外）
p = find("update", "update.js")
s = read(p) if p else ""
ck("update.js Web 端跳过 /api/version/* 候选",
   "p.startsWith('/api/') && !isNativeApp()" in s, f"{p}")
ck("update.js LATEST_VERSION=1.6.15", "LATEST_VERSION = '1.6.15'" in s or "LATEST_VERSION='1.6.15'" in s)
ck("update.js fallback APK 指向 v1.6.15", "Xiaoting-v1.6.15-release.apk" in s)

# 4) copywriting.js wipe 文案不再谎报云端
p = find("copywriting", "copywriting.js")
s = read(p) if p else ""
# 注意：源码里那句「云端记录将同步清除」只出现在 v1.6.15 自己的注释说明里，
# 判「文案还谎不谎」必须只看 wipe.confirm 行，不能裸串匹配整文件（否则把自己注释判红）。
confirm_lines = [ln for ln in s.splitlines() if "confirm:" in ln]
ck("wipe 文案不再谎报云端（只看 confirm 行，文件里残留的只是说明性注释）",
   all("云端记录将同步清除" not in ln for ln in confirm_lines),
   f"confirm 行数={len(confirm_lines)}")
ck("wipe 文案如实说明本机存储", "本来就只存在这台设备上" in s)

# 5) state-machine 死配置已清
p = find("state-machine", "state-machine.js")
s = read(p) if p else ""
ck("state-machine 已清 autoDeleteAudio / ttsHint 死键",
   "autoDeleteAudio:" not in s and "ttsHint:" not in s)

# 6) api.js 死接口已清
p = find("api", "api.js")
s = read(p) if p else ""
ck("api.js 已清 recordUpload/cardList/cardGet",
   "recordUpload(" not in s and "cardList(" not in s and "cardGet(" not in s)
ck("api.js 保留 aiDebug（探针在用，非死代码）", "aiDebug(" in s)

# 7) 版本七处之一 + 图标动效 keyframes
p = find("motion", "motion.js")
s = read(p) if p else ""
ck("motion.js 情绪动效联动状态类", "mascot--" in s or "setState" in s)

bad = [n for n, ok, _ in checks if not ok]
print(f"\n结果: {len(checks) - len(bad)}/{len(checks)} 通过")
sys.exit(1 if bad else 0)
