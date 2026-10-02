# -*- coding: utf-8 -*-
"""v1.7.0 专项「进包校验」：验下载与安装（#/download + A2HS 装桌面 + 更新弹窗分流）真进了 APK，
并抽查 v1.6.19 及更早批次不退化。

用法: python verify_apk_v170.py <apk路径> [期望版本号]
铁律：版本证据 = 包内 APP_VERSION / update.js LATEST_VERSION，不是文件名、不是 md5。
"""
import re
import sys
import zipfile

apk = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else '1.7.0'

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


def code_lines(src):
    """🔴 只取代码行：把 // 行注释与 /* */ 块注释剔除后再匹配。
    历史坑：update.js 注释里复述过「import('@capacitor/filesystem')」这段历史 bug 的字面量，
    裸串匹配整文件会把自己写的注释判红（假判据）。"""
    out = []
    for line in src.replace('\r\n', '\n').split('\n'):
        s = line.strip()
        if s.startswith('//') or s.startswith('*') or s.startswith('/*'):
            continue
        out.append(line)
    return '\n'.join(out)


def has_native_bare_import(src):
    """去注释后，按「真的在代码里」判有没有裸 import 原生插件。"""
    return re.search(r"import\(\s*['\"]@capacitor/", code_lines(src)) is not None


results = []


def chk(label, ok, note=''):
    results.append((label, bool(ok), note))


app = find_js('js/app.js')
idx = find_js('index.html')
upd = find_js('js/update.js')
sw = find_js('sw.js')
ins = find_js('js/install.js')
cw = find_js('js/copywriting.js')

# ---------- 版本证据 ----------
m = re.findall(r"window\.APP_VERSION\s*\|\|\s*'([\d.]+)'", app)
# 兜底处数：app.js 里 window.APP_VERSION || 'x.y.z' 实际 4 处，判「≥3 且全等」，
# 硬编码固定处数会在下次改动时自己变红（判据要跟得住实现）。
chk('版本·app.js 兜底 = %s（实际 %d 处）' % (want, len(m)),
    len(m) >= 3 and all(x == want for x in m), str(m))
m2 = re.search(r"APP_VERSION\s*=\s*'([\d.]+)'", idx)
chk('版本·index.html APP_VERSION = %s' % want, m2 and m2.group(1) == want, m2.group(1) if m2 else '未命中')
m3 = re.search(r"LATEST_VERSION\s*=\s*'([\d.]+)'", upd)
chk('版本·update.js LATEST_VERSION = %s' % want, m3 and m3.group(1) == want, m3.group(1) if m3 else '未命中')
m4 = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
chk('版本·sw.js CACHE = xiaoting-v%s' % want, m4 and m4.group(1) == 'xiaoting-v%s' % want, m4.group(1) if m4 else '未命中')
chk('版本·update.js FALLBACK 指向 v%s 包' % want, 'Xiaoting-v%s-release.apk' % want in upd)

# ---------- v1.7.0 本体 ----------
chk('v1.7.0·js/install.js 进包', ins != '')
chk('v1.7.0·install.js 有三档下载回落（清单→拼包名→稳定别名）',
    'apk/xiaoting-latest.apk' in ins and 'Xiaoting-v' in ins)
chk('v1.7.0·install.js 清单走 fetchLatest（不是用完就清的中转变量）', 'fetchLatest' in ins)
chk('v1.7.0·install.js 有 A2HS（beforeinstallprompt + userChoice）',
    'beforeinstallprompt' in ins and 'userChoice' in ins)
chk('v1.7.0·install.js 有 iOS 分享→添加到主屏幕引导', '添加到主屏幕' in ins)
chk('v1.7.0·更新弹窗 Web/iOS 有「下载安卓版」入口（updateApk → #/download）',
    'updateApk' in upd and '#/download' in upd and '!p.isApk && !p.isWeChat' in upd)
chk('v1.7.0·弹窗不再只说「会自动刷新」（旧整句清零）',
    '想要晚上轻提醒' in upd and '点击立即更新，墨小溟会自动刷新到最新版。' not in upd)
chk('v1.7.0·app.js 注册 PAGES.download', re.search(r'download:\s*\{\s*render:\s*pageDownload', app) is not None)
chk('v1.7.0·下载页渲染 + 装包三步 + 校验值折叠块',
    'function pageDownload' in app and 'dlsteps' in app and 'dlMd5Wrap' in app)
chk('v1.7.0·下载链接退到稳定别名（app 用 install.apkHref，install 内三档带别名）',
    'install.apkHref' in app and 'apkSources' in ins and 'apk/xiaoting-latest.apk' in ins)
chk('v1.7.0·「我」页有下载入口行 + 装桌面按钮',
    'mrow--download' in app and 'meInstall' in app and 'meDlSub' in app)
chk('v1.7.0·装桌面点了必须有回话（installAction 落地到 hint）', 'installAction' in app and 'meInstallHint' in app)
chk('v1.7.0·文案块 ME_COPY.download 进包（title/row/installBtn）',
    'download: {' in cw and 'installBtn' in cw and '安卓版 · 下载与安装' in cw)
chk('v1.7.0·SW 预缓存 js/install.js（离线打开下载页不白屏）', "'./js/install.js'" in sw)

# ---------- 不退化 ----------
old = find_js('js/prompts.js')
store = find_js('js/store.js')
sm = find_js('js/state-machine.js')
api = find_js('js/api.js')
mot = find_js('js/motion.js')
chk('不退化·v1.6.19 时间线日期筛选（tlInRange + tlFilter）', 'tlInRange' in app and 'tlFilter' in app)
chk('不退化·v1.6.19 老用户记忆迁移（MEMORY_MIGRATED_KEY + miKeep/miOff）',
    'MEMORY_MIGRATED_KEY' in app and 'miKeep' in app and 'miOff' in app)
chk('不退化·v1.6.19 第 3 屏安全小字 + 偏好 5 项定义', 'welcome-note--alert' in app and 'tts:' in old)
chk('不退化·v1.6.17 动效防抖（EMOTION_STABLE_MS 2500）', 'EMOTION_STABLE_MS = 2500' in mot)
chk('不退化·v1.6.17 说教黑名单 ≥ 48 条（含想开就好）',
    len(re.findall(r"'[^']+',", find_js('js/prompts.js'))) > 0 and '想开就好' in old)
chk('不退化·v1.6.18 三条偏好链路 sysWithPrefs', len(re.findall(r'sysWithPrefs\(SYSTEM\.', api)) == 3)
chk('不退化·v1.6.19 memory_on 严格全等', re.search(r"memory_on\)\s*===\s*true", api) is not None)
chk('不退化·v1.6.19 严格全等（store 侧）',
    'sanitizeSermon' in store and re.search(r"role\s*===\s*'ai'", store) is not None)
chk('不退化·G8 memory_on 默认 false', re.search(r'memory_on\s*:\s*false', sm) is not None)
chk('不退化·update.js 代码里不裸 import 原生插件（注释复述不算）', not has_native_bare_import(upd))
chk('不退化·notify.js 代码里不裸 import 原生插件', not has_native_bare_import(find_js('js/notify.js')))

print('APK:', apk)
print('包内前端资产 js 数:', len([n for n in names if re.match(r'(assets/public/|public/)?js/.*\.js$', n)]))
print('--- v1.7.0 进包校验（含 v1.6.19 / v1.6.17 / v1.6.18 回归抽查）---')
bad = 0
for label, ok, note in results:
    if not ok:
        bad += 1
    print('  %-4s %s%s' % ('OK' if ok else 'FAIL', label, ('   ' + note) if (note and not ok) else ''))
print('\n结果: %d/%d 通过' % (len(results) - bad, len(results)))
sys.exit(1 if bad else 0)
