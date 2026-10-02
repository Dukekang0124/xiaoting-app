# -*- coding: utf-8 -*-
"""v1.6.18 专项「进包校验」：验「偏好开关写了必须有人读」这次修复真进了 APK，
同时抽查 v1.6.17 那批（G1~G8）没被这次改动破坏。

用法: python verify_apk_v1618.py <apk路径> [期望版本号]
铁律：版本证据 = 包内 APP_VERSION / update.js LATEST_VERSION，不是文件名、不是 md5。
"""
import re
import sys
import zipfile

apk = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else '1.6.18'

z = zipfile.ZipFile(apk)
names = z.namelist()


def read(p):
    try:
        return z.read(p).decode('utf-8', 'replace')
    except KeyError:
        return ''


def find_js(base):
    for prefix in ('assets/public/', 'public/', ''):
        if prefix + base in names:
            return read(prefix + base)
    return ''


results = []


def chk(label, ok, note=''):
    results.append((label, bool(ok), note))


app_js = find_js('js/app.js')
idx = find_js('index.html')
upd = find_js('js/update.js')
sw = find_js('sw.js')
sto = find_js('js/store.js')
pro = find_js('js/prompts.js')
api = find_js('js/api.js')
sm = find_js('js/state-machine.js')
mot = find_js('js/motion.js')

# ---------- 版本证据 ----------
m = re.findall(r"window\.APP_VERSION\s*\|\|\s*'([\d.]+)'", app_js)
chk('版本·app.js 兜底 = %s（×3）' % want, len(m) == 3 and all(x == want for x in m), str(m))
m2 = re.search(r"APP_VERSION\s*=\s*'([\d.]+)'", idx)
chk('版本·index.html APP_VERSION = %s' % want, m2 and m2.group(1) == want, m2.group(1) if m2 else '未命中')
m3 = re.search(r"LATEST_VERSION\s*=\s*'([\d.]+)'", upd)
chk('版本·update.js LATEST_VERSION = %s' % want, m3 and m3.group(1) == want, m3.group(1) if m3 else '未命中')
m4 = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
chk('版本·sw.js CACHE = xiaoting-v%s' % want, m4 and m4.group(1) == 'xiaoting-v%s' % want, m4.group(1) if m4 else '未命中')
chk('版本·update.js FALLBACK 指向 v%s 包' % want, 'Xiaoting-v%s-release.apk' % want in upd)

# ---------- v1.6.18：偏好开关「写了必须有人读」 ----------
chk('G2·「回复短一点」三条链路都过 sysWithPrefs（main/followup/card）',
    len(re.findall(r'sysWithPrefs\(SYSTEM\.', api)) == 3, str(len(re.findall(r'sysWithPrefs\(SYSTEM\.', api))))
chk('G2·api.js 真读 user.settings.reply_short === true', 'settings.reply_short === true' in api)
chk('G2·SHORT_REPLY_HINT 常量进包', 'SHORT_REPLY_HINT' in pro)
chk('G2·withPrefsHint 只认 short===true（不许悄悄改提示）',
    re.search(r"export function withPrefsHint[\s\S]{0,300}?prefs\.short !== true", pro) is not None)
chk('G2·长度约束文案在包内（两句话以内）', '两句话以内' in pro)
chk('G2·quiet_pref 死配置已清（只判代码形态；说明性注释允许留存）',
    re.search(r"setSetting\(['\"]quiet_pref['\"]", app_js) is None)
chk('G2·不再把 picked.quiet 写成 setQuietMode（假开关取消）',
    re.search(r'setQuietMode\(!!picked', app_js) is None)
pref_block = re.search(r'const PREF_ITEMS = \[[\s\S]*?\]\.filter', app_js)
pb = pref_block.group(0) if pref_block else ''
chk('G2·引导勾选框只剩 memory / short 两项',
    "'memory'" in pb and "'short'" in pb and "'quiet'" not in pb and "'noSermon'" not in pb, pb[:80])
chk('G2·没有长期开关的两条改成说明条（prefsNotes → .welcome-note）',
    'prefsNotes' in app_js and 'welcome-note' in app_js)
chk('G2·设置页有「回复短一点」开关并绑定 setSetting',
    'id="setReplyShort"' in app_js and re.search(r"setReplyShort'\)[\s\S]{0,140}setSetting\('reply_short'", app_js) is not None)

# ---------- v1.6.17 关键锚点抽查（这次改动不许破坏它们） ----------
chk('不退化·G4 稳定窗 2500ms 仍在', re.search(r'EMOTION_STABLE_MS\s*=\s*2500', mot) is not None)
chk('不退化·G7 兜底句仍在', '我感受到你的难受，我在这里陪着你。' in pro)
chk('不退化·G7 长词优先正则仍在', re.search(r'SERMON_RE\s*=[\s\S]{0,200}?sort\(', pro) is not None)
chk('不退化·G7 守门仍挂 appendConvo 且只守 AI',
    'sanitizeSermon' in sto and re.search(r"role\s*===\s*'ai'", sto) is not None)
chk('不退化·G8 memory_on 默认 false', re.search(r'memory_on\s*:\s*false', sm) is not None)
chk('不退化·G3 deleteCard / toggleCardFlag 仍在',
    'export function deleteCard' in sto and 'export function toggleCardFlag' in sto)
chk('不退化·G1 第 5 屏 / 重看入口仍在', 'screen5' in app_js and 'meReplayOnboarding' in app_js)
chk('不退化·G5 重新开始倾诉仍在', 'newSession' in app_js and 'startSession' in app_js)
chk('不退化·G6 断网置灰仍在', 'setAiGate' in app_js and 'aiWasDisabled' in app_js)
chk('不退化·notify 仍不裸 import 原生插件',
    "import('@capacitor/" not in find_js('js/notify.js'))

print('APK:', apk)
print('包内前端资产 js 数:', len([n for n in names if re.match(r'(assets/public/|public/)?js/.*\.js$', n)]))
print('--- v1.6.18 进包校验（含 v1.6.17 回归抽查）---')
bad = 0
for label, ok, note in results:
    if not ok:
        bad += 1
    print('  %-4s %s%s' % ('OK' if ok else 'FAIL', label, ('   ' + note) if (note and not ok) else ''))
print('\n结果: %d/%d 通过' % (len(results) - bad, len(results)))
sys.exit(1 if bad else 0)
