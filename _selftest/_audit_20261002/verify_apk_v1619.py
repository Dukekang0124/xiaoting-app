# -*- coding: utf-8 -*-
"""v1.6.19 专项「进包校验」：验外部修复包（P1×2 + P2×4 + 配套 3.3）真进了 APK，
并抽查 v1.6.17/v1.6.18 两批不退化。

用法: python verify_apk_v1619.py <apk路径> [期望版本号]
铁律：版本证据 = 包内 APP_VERSION / update.js LATEST_VERSION，不是文件名、不是 md5。
"""
import re
import sys
import zipfile

apk = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else '1.6.19'

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


app = find_js('js/app.js')
idx = find_js('index.html')
upd = find_js('js/update.js')
sw = find_js('sw.js')
sto = find_js('js/store.js')
pro = find_js('js/prompts.js')
api = find_js('js/api.js')
sm = find_js('js/state-machine.js')
mot = find_js('js/motion.js')

# ---------- 版本证据 ----------
m = re.findall(r"window\.APP_VERSION\s*\|\|\s*'([\d.]+)'", app)
chk('版本·app.js 兜底 = %s（×3）' % want, len(m) == 3 and all(x == want for x in m), str(m))
m2 = re.search(r"APP_VERSION\s*=\s*'([\d.]+)'", idx)
chk('版本·index.html APP_VERSION = %s' % want, m2 and m2.group(1) == want, m2.group(1) if m2 else '未命中')
m3 = re.search(r"LATEST_VERSION\s*=\s*'([\d.]+)'", upd)
chk('版本·update.js LATEST_VERSION = %s' % want, m3 and m3.group(1) == want, m3.group(1) if m3 else '未命中')
m4 = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
chk('版本·sw.js CACHE = xiaoting-v%s' % want, m4 and m4.group(1) == 'xiaoting-v%s' % want, m4.group(1) if m4 else '未命中')
chk('版本·update.js FALLBACK 指向 v%s 包' % want, 'Xiaoting-v%s-release.apk' % want in upd)

# ---------- P1-1 时间线按日期筛选 ----------
chk('P1-1·筛选栏 + 起止日期控件进包',
    'tl-filter' in app and 'id="tlStart"' in app and 'id="tlEnd"' in app)
chk('P1-1·四个快捷档都在（today/week/month/reset）',
    all(('data-tl-preset="%s"' % k) in app for k in ('today', 'week', 'month', 'reset')))
chk('P1-1·本地区间过滤 + 模块级筛选状态',
    'function tlInRange' in app and "let tlFilter = { start: '', end: '' };" in app)
chk('P1-1·筛选空态用方案文案', '这个时间段还没有情绪记录，你可以开始倾诉啦' in app)
chk('P1-1·timelines 路由挂了 bind（不挂 = 控件点不动）',
    re.search(r'timelines:\s*\{ render: pageTimelines, bind: bindTimelines', app) is not None)

# ---------- P1-2 老用户迁移 + 严格判据 ----------
chk('P1-2·一次性迁移标记 + 流程 + 弹窗都在',
    'MEMORY_MIGRATED_KEY' in app and 'function maybeMemoryMigration' in app and 'function showMemoryMigrationDialog' in app)
chk('P1-2·迁移在 boot 里被调用', 'maybeMemoryMigration()' in app)
chk('P1-2·弹窗两个按钮', 'miKeep' in app and 'miOff' in app)
chk('P1-2·开启时写确认时间戳', 'memory_confirmed_at' in app)
chk('P1-2·memory_on 判据全仓严格 === true（旧 !== false 清零）',
    re.search(r'memory_on\)\s*!==\s*false', app) is None
    and re.search(r'memory_on\)\s*!==\s*false', api) is None
    and re.search(r'memory_on\)\s*===\s*true', api) is not None)

# ---------- P2-1 补词 ----------
chk('P2-1·黑名单含「想开就好」「想开就好了」',
    "'想开就好'" in pro and "'想开就好了'" in pro)
chk('P2-1·替换表一一对应', re.search(r'想开就好:\s*\'', pro) is not None and re.search(r'想开就好了:\s*\'', pro) is not None)

# ---------- P2-2 第 3 屏 ----------
chk('P2-2·第 3 屏保留原边界声明',
    '我不是心理医生' in pro)
chk('P2-2·第 3 屏追加方案指定安全小字',
    '⚠️ 墨小溟是情绪陪伴倾听者，不是心理医生，无法替代专业心理诊疗' in pro)
chk('P2-2·第 3 屏补安静陪伴模式用法 + 渲染 extra/note',
    'extra:' in pro and '安静陪伴模式' in pro and 's.extra ?' in app and 's.note ?' in app)

# ---------- P2-3 按钮文案 ----------
chk('P2-3·按钮文案 = 下一步 / 跳过全部（旧文案清零）',
    re.search(r"next:\s*'下一步'", pro) is not None and re.search(r"skip:\s*'跳过全部'", pro) is not None
    and "'下一屏'" not in pro and "'先跳过'" not in pro)

# ---------- P2-4 偏好 5 项定义 + 按需渲染 ----------
chk('P2-4·偏好保留完整 5 项定义',
    all(re.search(r'%s:\s*\{' % k, pro) is not None for k in ('memory', 'short', 'noSermon', 'quiet', 'tts')))
chk('P2-4·前端按 available 渲染，TTS 暂不渲染',
    'v.available === true' in app and re.search(r'tts:\s*\{[\s\S]{0,160}available:\s*false', pro) is not None)

# ---------- 配套 3.3 离线文案 ----------
chk('3.3·离线提示用方案文案',
    '当前网络不可用，你可以查看过往情绪记录，联网后继续倾诉' in idx)

# ---------- 不退化抽查（v1.6.17 / v1.6.18） ----------
chk('不退化·G4 稳定窗 2500ms', re.search(r'EMOTION_STABLE_MS\s*=\s*2500', mot) is not None)
chk('不退化·G7 兜底句 + 长词优先正则',
    '我感受到你的难受，我在这里陪着你。' in pro and re.search(r'SERMON_RE\s*=[\s\S]{0,200}?sort\(', pro) is not None)
chk('不退化·G7 守门挂 appendConvo 且只守 AI',
    'sanitizeSermon' in sto and re.search(r"role\s*===\s*'ai'", sto) is not None)
chk('不退化·G8 memory_on 默认 false', re.search(r'memory_on\s*:\s*false', sm) is not None)
chk('不退化·G2 回复短一点三条链路', len(re.findall(r'sysWithPrefs\(SYSTEM\.', api)) == 3)
chk('不退化·G3 deleteCard / toggleCardFlag',
    'export function deleteCard' in sto and 'export function toggleCardFlag' in sto)
chk('不退化·G1 第 5 屏 / 重看入口 / 防连点', 'screen5' in app and 'meReplayOnboarding' in app)
chk('不退化·G5 重新开始倾诉', 'newSession' in app and 'startSession' in app)
chk('不退化·G6 断网置灰 + aiWasDisabled', 'setAiGate' in app and 'aiWasDisabled' in app)
chk('不退化·notify 不裸 import 原生插件', "import('@capacitor/" not in find_js('js/notify.js'))

print('APK:', apk)
print('包内前端资产 js 数:', len([n for n in names if re.match(r'(assets/public/|public/)?js/.*\.js$', n)]))
print('--- v1.6.19 进包校验（含 v1.6.17/18 回归抽查）---')
bad = 0
for label, ok, note in results:
    if not ok:
        bad += 1
    print('  %-4s %s%s' % ('OK' if ok else 'FAIL', label, ('   ' + note) if (note and not ok) else ''))
print('\n结果: %d/%d 通过' % (len(results) - bad, len(results)))
sys.exit(1 if bad else 0)
