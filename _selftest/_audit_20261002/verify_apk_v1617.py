# -*- coding: utf-8 -*-
"""v1.6.17 专项「进包校验」：从 APK 里读 assets/public/**，验证 G1~G8 八项改动真的进了包。

用法: python verify_apk_v1617.py <apk路径> [期望版本号]
铁律：版本证据 = 包内 APP_VERSION / update.js LATEST_VERSION，不是文件名、不是 md5。
"""
import io
import re
import sys
import zipfile

apk = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else '1.6.17'

z = zipfile.ZipFile(apk)
names = z.namelist()


def read(p):
    try:
        return z.read(p).decode('utf-8', 'replace')
    except KeyError:
        return ''


def find_js(base):
    """APK 里前端资产在 assets/public/ 下（也可能直接 assets/）。"""
    for prefix in ('assets/public/', 'public/', ''):
        if prefix + base in names:
            return read(prefix + base)
    return ''


def has(text, needle):
    return needle in text


results = []
def chk(label, ok, note=''):
    results.append((label, bool(ok), note))

# ---- 版本证据 ----
app_js = find_js('js/app.js')
idx = find_js('index.html')
upd = find_js('js/update.js')
sw = find_js('sw.js')

m = re.findall(r"window\.APP_VERSION\s*\|\|\s*'([\d.]+)'", app_js)
chk('版本·app.js 兜底 = %s（×3）' % want, len(m) == 3 and all(x == want for x in m), str(m))
m2 = re.search(r"APP_VERSION\s*=\s*'([\d.]+)'", idx)
chk('版本·index.html APP_VERSION = %s' % want, m2 and m2.group(1) == want, m2.group(1) if m2 else '未命中')
m3 = re.search(r"LATEST_VERSION\s*=\s*'([\d.]+)'", upd)
chk('版本·update.js LATEST_VERSION = %s' % want, m3 and m3.group(1) == want, m3.group(1) if m3 else '未命中')
m4 = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
chk('版本·sw.js CACHE = xiaoting-v%s' % want, m4 and m4.group(1) == 'xiaoting-v%s' % want, m4.group(1) if m4 else '未命中')
chk('版本·update.js FALLBACK 指向 v%s 包' % want, 'Xiaoting-v%s-release.apk' % want in upd)

# ---- G1/G2 新手引导第 5 屏 + 偏好 ----
chk('G1·第 5 屏存在（screen5）', 'screen5' in app_js)
chk('G1·偏好勾选项渲染（prefsHtml / data-pref）', 'data-pref' in app_js and 'prefsHtml' in app_js)
chk('G1·偏好真的落到设置（applyWelcomePrefs → setSetting）',
    'applyWelcomePrefs' in app_js and "setSetting('memory_on'" in app_js)
chk('G1·设置页「重看新手引导」入口', 'meReplayOnboarding' in app_js)
chk('G1·防连点叠层 guard', "querySelector('.welcome-overlay')" in app_js)

# ---- G3 卡片可删 / 可收藏 / 可归档 ----
sto = find_js('js/store.js')
chk('G3·store.deleteCard 进包', 'deleteCard' in sto)
chk('G3·store.toggleCardFlag 进包', 'toggleCardFlag' in sto)
chk('G3·toggle 只认 fav|archived', "'fav'" in sto and "'archived'" in sto)
chk('G3·列表三档筛选（cardFilter）', 'cardFilter' in app_js)
chk('G3·详情页删除按钮绑定', 'data-card-del' in app_js or 'dDel' in app_js)

# ---- G4 情绪防抖 ----
mot = find_js('js/motion.js')
chk('G4·稳定窗常量 2500ms 进包', re.search(r'EMOTION_STABLE_MS\s*=\s*2500', mot) is not None)
chk('G4·flush 同步落地通道', re.search(r'function\s+flush|flush\s*[:=]', mot) is not None or 'flush' in mot)
chk('G4·getStability 可观测', 'getStability' in mot)
chk('G4·兜底最长等待（6s 防无限推迟）', re.search(r'(STABLE_MAX_WAIT_MS|MAX_WAIT)', mot) is not None)
chk('G4·danger 走 immediate/lock 不受窗约束', 'lock_motion' in mot)

# ---- G5 重新开始倾诉 ----
chk('G5·「重新开始倾诉」按钮', 'newSession' in app_js)
chk('G5·走 store.startSession()', 'startSession' in app_js)

# ---- G6 离线置灰 ----
chk('G6·setAiGate 进包', 'setAiGate' in app_js)
chk('G6·ai-gated 标记', 'data-ai-gated' in app_js or 'ai-gated' in app_js)
chk('G6·记录 aiWasDisabled（恢复网络不抹掉流程禁用）', 'aiWasDisabled' in app_js)

# ---- G7 说教黑名单 / 白名单 / 守门 ----
pro = find_js('js/prompts.js')
chk('G7·兜底句进包', '我感受到你的难受，我在这里陪着你。' in pro)
chk('G7·黑名单扩到 >=48 条',
    (lambda n: n is not None and n >= 48)(re.search(r'FORBIDDEN_PHRASES\s*=\s*\[([\s\S]*?)\]', pro) and
                                          len(re.findall(r"'[^']+'|\"[^\"]+\"", re.search(r'FORBIDDEN_PHRASES\s*=\s*\[([\s\S]*?)\]', pro).group(1)))))
for w in ('想开一点', '看开点', '你应该放下', '你要乐观', '别想太多'):
    chk('G7·黑名单含「%s」' % w, w in pro)
chk('G7·替换表与黑名单一一对应（SERMON_REPL）', 'SERMON_REPL' in pro)
chk('G7·长词优先单正则（SERMON_RE.sort by length）', re.search(r'SERMON_RE\s*=[\s\S]{0,200}?sort\(', pro) is not None)
chk('G7·sanitizeSermon 进包', 'sanitizeSermon' in pro)
chk('G7·整句兜底阈值 SERMON_RATIO', re.search(r'SERMON_RATIO\s*=\s*0?\.\d+', pro) is not None)
chk('G7·SYSTEM 注入共情白名单', '共情白名单' in pro or '白名单' in pro)
chk('G7·SYSTEM 注入禁止句式', '禁止句式' in pro or '禁止' in pro)
chk('G7·守门挂 appendConvo + 只守 AI',
    'sanitizeSermon' in sto and re.search(r"role\s*===\s*'ai'", sto) is not None)

# ---- G8 记忆默认关闭 ----
sm = find_js('js/state-machine.js')
chk('G8·memory_on 默认 false（不再静默写长期记忆）',
    re.search(r'memory_on\s*:\s*false', sm) is not None)

# ---- v1.6.16 老修复不退化 ----
notify = find_js('js/notify.js')
chk('回归·notify 不裸 import 原生插件', "import('@capacitor/" not in notify and 'import("@capacitor/' not in notify)
chk('回归·notify 从 Capacitor.Plugins 取', 'Capacitor' in notify and 'Plugins' in notify)
chk('回归·preferredHour 用 new Date(t)', 'new Date(t)' in notify)

print('APK:', apk)
print('包内前端资产 js 数:', len([n for n in names if re.match(r'assets/public/js/.*\.js$', n) or re.match(r'public/js/.*\.js$', n)]))
print('--- v1.6.17 G1~G8 进包校验 ---')
bad = 0
for label, ok, note in results:
    if not ok:
        bad += 1
    print('  %-4s %s%s' % ('OK' if ok else 'FAIL', label, ('   ' + note) if (note and not ok) else ''))
print('\n结果: %d/%d 通过' % (len(results) - bad, len(results)))
sys.exit(1 if bad else 0)
