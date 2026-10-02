# -*- coding: utf-8 -*-
"""v1.7.4 进包校验：P1-1（云端探测自带超时）+ 版本证据 + 不退化抽查。

用法: python verify_apk_v174.py <apk路径> [期望版本号]
铁律：版本证据 = 包内 APP_VERSION / update.js LATEST_VERSION，不是文件名、不是 md5。
"""
import re
import sys
import zipfile

apk = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else '1.7.4'

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
    """🔴 只取代码行：剔除 // 行注释与 /* */ 块注释后再匹配。
    历史坑：注释里复述过别的字面量，裸串匹配整文件会把自己写的注释判红（假判据）。"""
    out = []
    for line in src.replace('\r\n', '\n').split('\n'):
        s = line.strip()
        if s.startswith('//') or s.startswith('*') or s.startswith('/*'):
            continue
        out.append(line)
    return '\n'.join(out)


def func_body(src, head, close=r"\n\}"):
    """🔴 精确截函数体。踩过三次的坑，一次比一次隐蔽：
       ① 字母窗口 / 定长字符窗口会把紧随其后的按钮监听算进来 ⇒ 截过头，假判据。
       ② head 已含 `()` 又拼 `[^)]*\\)` ⇒ 要求 `())` 双括号，永远不匹配（head 先归一）。
       ③ 闭合 `}` 一律认顶格 `\\n}` ⇒ 模板里整体缩进的函数截不到（一路吞到下一个顶格 }）；
          但改成允许前导缩进又会停在对象字面量的 `    }` 上（漏掉整个 catch）。
       ⇒ 折中：闭合缩进可传参。顶层函数传默认 `\\n}`；模板内嵌函数传 `\\n  }`（与 v1.7.3 判据同款）。"""
    h = re.sub(r"\(\s*\)\s*$", "", head.rstrip("("))
    m = re.search(re.escape(h) + r"\([^)]*\)\s*\{[\s\S]*?" + close, src)
    return m.group(0) if m else ''


results = []


def chk(label, ok, note=''):
    results.append((label, bool(ok), note))


app = find_js('js/app.js')
idx = find_js('index.html')
upd = find_js('js/update.js')
sw = find_js('sw.js')
asr = find_js('js/asr.js')
cfg = find_js('js/config.js')
api = find_js('js/api.js')
llm = find_js('js/llm.js')
ins = find_js('js/install.js')
mot = find_js('js/motion.js')
store = find_js('js/store.js')
prompts = find_js('js/prompts.js')

# ---------- 版本证据（判「线上那个包是哪一版」唯一可信处） ----------
m = re.findall(r"window\.APP_VERSION\s*\|\|\s*'([\d.]+)'", app)
chk('版本·app.js 兜底 = %s（实际 %d 处）' % (want, len(m)),
    len(m) >= 3 and all(x == want for x in m), str(m))
m2 = re.search(r"APP_VERSION\s*=\s*'([\d.]+)'", idx)
chk('版本·index.html APP_VERSION = %s' % want, m2 and m2.group(1) == want, m2.group(1) if m2 else '未命中')
m3 = re.search(r"LATEST_VERSION\s*=\s*'([\d.]+)'", upd)
chk('版本·update.js LATEST_VERSION = %s' % want, m3 and m3.group(1) == want, m3.group(1) if m3 else '未命中')
m4 = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
chk('版本·sw.js CACHE = xiaoting-v%s' % want, m4 and m4.group(1) == 'xiaoting-v%s' % want, m4.group(1) if m4 else '未命中')
chk('版本·update.js FALLBACK 指向 v%s 包' % want, 'Xiaoting-v%s-release.apk' % want in upd)

# ---------- v1.7.4 本体：P1-1 云端探测自带超时 ----------
chk('v1.7.4·js/asr.js 进包', asr != '')
chk('v1.7.4·js/config.js 进包', cfg != '')
chk('v1.7.4·config.js 有 probeTimeoutMs', re.search(r"probeTimeoutMs\s*:\s*6000", cfg) is not None)
chk('v1.7.4·probeTimeoutMs 远小于单次 timeoutMs（探测答的是值不值得走云端）',
    re.search(r"probeTimeoutMs\s*:\s*6000", cfg) is not None
    and re.search(r"timeoutMs\s*:\s*25000", cfg) is not None)

pb = func_body(code_lines(asr), 'export async function probeCloud(')
chk('v1.7.4·probeCloud 函数体取得到', bool(pb), '取到 %d 字符' % len(pb) if pb else '没取到')
chk('v1.7.4·probeCloud 带 AbortController（超时能真中断连接）', 'AbortController' in pb)
chk('v1.7.4·probeCloud 的 fetch 带 signal（不是靠外部兜）', 'signal: ctrl.signal' in pb)
chk('v1.7.4·probeCloud 的 fetch 带 cache: no-store', 'cache: \'no-store\'' in pb)
chk('v1.7.4·probeCloud 有 finally clearTimeout（不漏计时器）', re.search(r"finally\s*\{[\s\S]{0,80}clearTimeout", pb) is not None)
chk('v1.7.4·probeCloud 的 catch 认得 AbortError（超时≠不可达，分开写）', 'AbortError' in pb)
chk('v1.7.4·超时一律判 unavailable（落内置识别兜底，不让人等）',
    pb.count('state: \'unavailable\'') >= 1)
cb = func_body(code_lines(asr), 'export async function cloudRecognize')
if not cb:
    for h in ('export async function recognize', 'export async function transcribe'):
        cb = func_body(code_lines(asr), h)
        if cb:
            break
# 🔴 调用方在 app.js（asr.js 里 probeCloud 只有定义处一处）。判「修复落在真链路上」
#    = app.js 那两处 await 还在 + 它们不再各自挂自己兜底（兜底已内进 probeCloud）。
app_code = code_lines(app)
chk('v1.7.4·app.js 仍 await asr.probeCloud()（修复落在真链路上，不是孤立的死函数）',
    len(re.findall(r"asr\.probeCloud\(\)", app_code)) >= 1,
    '命中 %d 处' % len(re.findall(r"asr\.probeCloud\(\)", app_code)))
chk('v1.7.4·asr.js 内部不再重复包超时（超时只在 probeCloud 一处，不靠外层兜）',
    'Promise.race' not in func_body(code_lines(asr), 'export async function probeCloud('))

# ---------- 不退化 ----------
chk('不退化·v1.7.3·llm.js 有 probe()（「重新检测通道」真探而非只清缓存）',
    'export async function probe()' in llm)
chk('不退化·v1.7.3·api.js 有 aiProbe() 透传', 'async aiProbe()' in api and 'llmProbe' in api)
fill_body = func_body(code_lines(app), 'async function fillAiChannel()', r"\n  \}")
chk('不退化·v1.7.3·app.js 首屏只取不探测（fillAiChannel 里调 aiStatus 不调 aiProbe）',
    bool(fill_body) and 'api.aiStatus()' in fill_body and 'aiProbe()' not in fill_body,
    'fillAiChannel 函数体=%s aiStatus=%s aiProbe=%s' % (
        ('%d 字符' % len(fill_body)) if fill_body else '没取到',
        'api.aiStatus()' in fill_body, 'aiProbe()' in fill_body))
chk('不退化·v1.7.3·设置页有 #aiChannelText 与 #aiChannelRetest',
    'id="aiChannelText"' in app and 'id="aiChannelRetest"' in app)
chk('不退化·v1.7.3·app.js 探测有 15s 超时兜底（按钮卡住会放回来）',
    'Promise.race' in code_lines(app) and 'setTimeout(() => r(null), 15000)' in code_lines(app))
chk('不退化·v1.7.4·app.js 诊断行每次重新取当前节点（不写旧节点）',
    re.search(r"function paintAiChannel\(s\)\s*\{[\s\S]{0,200}?getElementById\('aiChannelText'\)", code_lines(app)) is not None)
chk('不退化·v1.7.0·js/install.js 进包（三档下载回落 + 稳定别名）',
    ins != '' and 'apk/xiaoting-latest.apk' in ins and 'fetchLatest' in ins)
chk('不退化·v1.7.0·SW 预缓存 js/install.js', "'./js/install.js'" in sw)
chk('不退化·v1.6.19 时间线日期筛选（tlInRange + tlFilter）', 'tlInRange' in app and 'tlFilter' in app)
chk('不退化·v1.6.19 老用户记忆迁移（MEMORY_MIGRATED_KEY + miKeep/miOff）',
    'MEMORY_MIGRATED_KEY' in app and 'miKeep' in app and 'miOff' in app)
chk('不退化·v1.6.17 动效防抖（EMOTION_STABLE_MS 2500）', 'EMOTION_STABLE_MS = 2500' in mot)
chk('不退化·v1.6.19 memory_on 严格全等（api 侧）', re.search(r"memory_on\)\s*===\s*true", api) is not None)
chk('不退化·update.js 代码里不裸 import 原生插件（注释复述不算）',
    not re.search(r"import\(\s*['\"]@capacitor/", code_lines(upd)))
chk('不退化·asr.js 代码里不裸 import 原生插件',
    not re.search(r"import\(\s*['\"]@capacitor/", code_lines(asr)))
chk('不退化·文案库在（说教黑名单 想开就好）', '想开就好' in prompts)
chk('不退化·store 侧严格全等（sanitizeSermon）', 'sanitizeSermon' in store and re.search(r"role\s*===\s*'ai'", store) is not None)

print('APK:', apk)
print('包内前端资产 js 数:', len([n for n in names if re.match(r'(assets/public/|public/)?js/.*\.js$', n)]))
print('--- v1.7.4 进包校验（P1-1 探测超时 + 版本证据 + 不退化抽查）---')
bad = 0
for label, ok, note in results:
    if not ok:
        bad += 1
    print('  %-4s %s%s' % ('OK' if ok else 'FAIL', label, ('   ' + note) if (note and not ok) else ''))
print('\n结果: %d/%d 通过' % (len(results) - bad, len(results)))
sys.exit(1 if bad else 0)
