# -*- coding: utf-8 -*-
"""v1.7.6 进包校验：四档模型链（前端侧）+ 按模型参数 + v1.7.5 全部修复不退化 + 版本证据。

用法: python verify_apk_v175.py <apk路径> [期望版本号]
铁律：版本证据 = 包内 APP_VERSION / update.js LATEST_VERSION，不是文件名、不是 md5。
判据素养：静态判据一律走 func_body / code_lines，别拿裸字符串去整文件里撞
（注释里复述过的字面量会把判据自己撞红，v1.7.4 那三版都栽过）。
"""
import re
import sys
import zipfile

apk = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else '1.7.5'

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
    """🔴 只取代码行：剔除 // 与 /* */ 块注释后再匹配。"""
    out = []
    for line in src.replace('\r\n', '\n').split('\n'):
        s = line.strip()
        if s.startswith('//') or s.startswith('*') or s.startswith('/*'):
            continue
        out.append(line)
    return '\n'.join(out)


def block(src, head):
    """取 `export const X = {` 到它自己那一行 `};` 为止的对象字面量块。🔴 判据必须切片，
    不能扫整文件 —— config.js 里 CLOUD_ASR 本来就该有 endpoint/health，整文件扫会假红。"""
    i = src.find(head)
    if i < 0:
        return ''
    j = src.find('\n};', i)
    return src[i:j] if j > 0 else src[i:]


def func_body(src, head, close=r"\n\}"):
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
sm = find_js('js/state-machine.js')
cw = find_js('js/copywriting.js')
cfgjs = find_js('moxiaoming_motion_sound_config.json')

# ---------- 版本证据 ----------
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

# ---------- v1.7.6 本体：四档优先序 + 按模型参数（服务端不进包，所以只判前端侧） ----------
llm_code = code_lines(llm)
tiers_blk = block(llm_code, 'const TIERS = {')


def arr_of(key, src):
    m = re.search(key + r"\s*:\s*\[([^\]]*)\]", src)
    return [s.strip().strip("'\"") for s in m.group(1).split(',')] if m else []


f_tier = arr_of('fast', tiers_blk)
s_tier = arr_of('strong', tiers_blk)
chk('v1.7.6·前端 fast 档首位 = glm-5.3-flash', f_tier[:1] == ['glm-5.3-flash'], str(f_tier))
chk('v1.7.6·前端 strong 档首位 = glm-5.3-flash', s_tier[:1] == ['glm-5.3-flash'], str(s_tier))
chk('v1.7.6·两档都按「GLM-5.3-Flash → deepseek-v4-flash」起头',
    f_tier[1:2] == ['deepseek-v4-flash'] and s_tier[1:2] == ['deepseek-v4-flash'], str(s_tier))
chk('v1.7.6·已下线的 glm-5.0 不在任何档位里（本地实测网关已 400）', 'glm-5.0' not in tiers_blk)
chk('v1.7.6·MODEL_PARAMS 给 glm-5.3-flash 配了 reasoning_effort=low（不配则主分析空正文）',
    re.search(r"MODEL_PARAMS\s*=\s*\{[\s\S]*?glm-5\.3-flash[\s\S]*?reasoning_effort\s*:\s*'low'", llm_code) is not None)
chk('v1.7.6·参数真接进请求体（打代码形态，不是配置写着好看）',
    re.search(r"Object\.assign\(\s*req\s*,\s*MODEL_PARAMS\[model\]", llm_code) is not None)
chk('v1.7.6·有「模型不认该参数」的逃生门（useParams:false 重试一次）',
    'useParams: false' in llm_code)
chk('v1.7.6·callTimeoutMs 抬到 20000（第一档实测主分析 5-11s，15s 只剩不到 1.4 倍余量）',
    re.search(r"callTimeoutMs:\s*20000", code_lines(cfg)) is not None)
chk('v1.7.6·服务端配置不进 APK（静态资产白名单）',
    not any(x.endswith('llm.config.json') or x.endswith('model.keys.json') for x in names))

# 🔴 红线：这次新增了三个直连厂商的通道，密钥一旦漏进包就是公开泄露
# 🔴 判「有没有泄漏」用**形态**而不是具体串：具体串依赖我手里的副本（key 会轮换、也可能被安全改写），
#    形态不会。两类形态覆盖本版接入的四家：
#      · sk-xxx            → OpenRouter / Agnes / DeepSeek 系
#      · 18位以上数字.12位以上字符 → 智谱 id.secret
_leak = []
_KP = [re.compile(r"sk-[A-Za-z0-9_\-]{20,}"), re.compile(r"\b\d{18,}\.[A-Za-z0-9]{12,}\b")]
for _n in names:
    if _n.endswith(('.js', '.html', '.json', '.css', '.webmanifest')):
        _t = read(_n)
        for _p in _KP:
            _m = _p.search(_t)
            if _m:
                _leak.append(_n + '::' + _m.group(0)[:24])
chk('v1.7.6·包内不含任何厂商密钥片段（直连厂商的前提是密钥只在服务端）',
    not _leak, ' | '.join(_leak[:3]))

# ---------- v1.7.5 本体：P2-3 月度复盘窗可关 ----------
mm = func_body(code_lines(app), 'function showMonthlyModal(')
chk('v1.7.5·js/app.js 进包', app != '' and bool(mm))
chk('v1.7.5·showMonthlyModal 取得到函数体', bool(mm), '取到 %d 字符' % len(mm) if mm else '没取到')
chk('v1.7.5·遮罩能点空白关（target === overlay 才关，点卡片不误关）',
    'ev.target === overlay' in mm and 'dismiss' in mm)
chk('v1.7.5·有 Esc 出口且 preventDefault', "ev.key === 'Escape'" in mm or "ev.key === 'Esc'" in mm)
chk('v1.7.5·document 级 keydown 是真监听（不是只写个 key 判断）',
    'document.addEventListener(\'keydown\'' in mm)
chk('v1.7.5·松手把 keydown 摘掉（add/remove 成对，不留裸监听）',
    'document.removeEventListener(\'keydown\'' in mm)
chk('v1.7.5·点按钮仍跑 act（关闭没做成"什么都不干"）', 'b.act' in mm)

# ---------- v1.7.5 本体：死配置清除（P2-1 / P3-1 / P2-2 / P3-3 / P3-4） ----------
chk('v1.7.5·配置里不再有 scene_effect 死块',
    cfgjs and '"scene_effect"' not in cfgjs)
chk('v1.7.5·配置里不再有 particle* 死字段',
    cfgjs and 'particle' not in cfgjs)
mot_code = code_lines(mot)
chk('v1.7.5·motion.js 不再写粒子 CSS 变量 / dataset（打代码形态）',
    not re.search(r"setProperty\(\s*['\"`]?--mm-particle", mot_code)
    and not re.search(r"dataset\.\s*particle\s*=", mot_code))
chk('v1.7.5·声音表里清掉了 scene 专用音效',
    all(n not in code_lines(find_js('js/ip-audio.js')) for n in
        ('bubble_single_soft', 'water_card_pop', 'underwater_loop_very_low', 'water_long_heal_full')))
chk('v1.7.5·store 不再有 historyBias 死字段',
    re.search(r"(^|\n)\s*historyBias\s*:", store) is None)
st_code = code_lines(store)
chk('v1.7.5·三个零调用导出已删（setQuietMode/setGreeting/setHistoryBias）',
    not re.search(r"export function set(QuietMode|Greeting|HistoryBias)\s*\(", st_code))
cw_code = code_lines(cw)
chk('v1.7.5·问候库删掉了永不命中的 morning 键（dawn 还在）',
    re.search(r"(^|\n)\s*morning\s*:", cw_code) is None and re.search(r"(^|\n)\s*dawn\s*:", cw_code) is not None)
cfg_code = code_lines(cfg)
# 🔴 只判 ASR 这一块，别扫整文件：CLOUD_ASR 的 endpoint/health 是真在读的，必须留
asr_block = block(cfg_code, 'export const ASR = {')
chk('v1.7.5·config.js 的 ASR 清掉零读字段 endpoint/health/timeoutMs',
    bool(asr_block)
    and not re.search(r"(^|\n)\s*(endpoint|health|timeoutMs)\s*:", asr_block))

# ---------- v1.7.5 本体：P3-5 / P3-6 ----------
chk('v1.7.5·reply_short 有显式默认 false', re.search(r"reply_short\s*:\s*false", sm) is not None)
chk('v1.7.5·timelines/cards 有上限（MAX_TIMELINES / MAX_CARDS）',
    'MAX_TIMELINES' in st_code and 'MAX_CARDS' in st_code)
# 🔴 slice(0, max) 在 trimOldest 的**函数体**里，调用点只传数组与常量 ⇒ 必须查函数体
trim_body = func_body(st_code, 'function trimOldest(')
chk('v1.7.5·超限时砍最旧的（trimOldest 超长取 slice(0, max)）',
    'trimOldest' in st_code
    and 'trimOldest([full, ...' in st_code
    and 'slice(0, max)' in trim_body)

# ---------- 不退化（v1.7.4 及以前的关键判据） ----------
chk('不退化·v1.7.4·config.js 有 probeTimeoutMs 6000', re.search(r"probeTimeoutMs\s*:\s*6000", cfg_code) is not None)
pbc = func_body(code_lines(asr), 'export async function probeCloud(')
chk('不退化·v1.7.4·probeCloud 带 AbortController + signal + finally clearTimeout',
    'AbortController' in pbc and 'signal: ctrl.signal' in pbc
    and re.search(r"finally\s*\{[\s\S]{0,80}clearTimeout", pbc) is not None)
app_code = code_lines(app)
chk('不退化·v1.7.4·app.js 仍 await asr.probeCloud()（修复落在真链路）',
    len(re.findall(r"asr\.probeCloud\(\)", app_code)) >= 1)
chk('不退化·v1.7.3·llm.js 有 probe()', 'export async function probe()' in llm)
chk('不退化·v1.7.3·api.js 有 aiProbe() 透传', 'async aiProbe()' in api and 'llmProbe' in api)
fill_body = func_body(app_code, 'async function fillAiChannel()', r"\n  \}")
chk('不退化·v1.7.3·首屏只取不探测（fillAiChannel 只调 aiStatus）',
    bool(fill_body) and 'api.aiStatus()' in fill_body and 'aiProbe()' not in fill_body)
chk('不退化·v1.7.3·设置页有 #aiChannelText 与 #aiChannelRetest',
    'id="aiChannelText"' in app and 'id="aiChannelRetest"' in app)
chk('不退化·v1.7.4·探测有 15s 超时兜底（按钮卡住会放回来）',
    'Promise.race' in app_code and 'setTimeout(() => r(null), 15000)' in app_code)
chk('不退化·v1.7.4·paintAiChannel 每次重取当前节点（不写旧节点）',
    re.search(r"function paintAiChannel\(s\)\s*\{[\s\S]{0,200}?getElementById\('aiChannelText'\)", app_code) is not None)
chk('不退化·v1.7.0·install.js 进包（三档下载回落 + 稳定别名）',
    ins != '' and 'apk/xiaoting-latest.apk' in ins and 'fetchLatest' in ins)
chk('不退化·v1.7.0·SW 预缓存 js/install.js', "'./js/install.js'" in sw)
chk('不退化·v1.6.19 时间线日期筛选（tlInRange + tlFilter）', 'tlInRange' in app and 'tlFilter' in app)
chk('不退化·v1.6.19 老用户记忆迁移（MEMORY_MIGRATED_KEY + miKeep/miOff）',
    'MEMORY_MIGRATED_KEY' in app and 'miKeep' in app and 'miOff' in app)
chk('不退化·v1.6.17 动效防抖（EMOTION_STABLE_MS 2500）', 'EMOTION_STABLE_MS = 2500' in mot_code)
chk('不退化·v1.6.19 memory_on 严格全等（api 侧）', re.search(r"memory_on\)\s*===\s*true", api) is not None)
chk('不退化·update.js 代码里不裸 import 原生插件（注释复述不算）',
    not re.search(r"import\(\s*['\"]@capacitor/", code_lines(upd)))
chk('不退化·asr.js 代码里不裸 import 原生插件',
    not re.search(r"import\(\s*['\"]@capacitor/", code_lines(asr)))
chk('不退化·文案库在（说教黑名单 想开就好）', '想开就好' in prompts)
chk('不退化·store 侧严格全等（sanitizeSermon）',
    'sanitizeSermon' in store and re.search(r"role\s*===\s*'ai'", store) is not None)

print('APK:', apk)
print('包内前端资产 js 数:', len([n for n in names if re.match(r'(assets/public/|public/)?js/.*\.js$', n)]))
print('--- v1.7.5 进包校验（P2-3 可关 + 死配置清除 + 存储上限 + 版本证据 + 不退化）---')
bad = 0
for label, ok, note in results:
    if not ok:
        bad += 1
    print('  %-4s %s%s' % ('OK' if ok else 'FAIL', label, ('   ' + note) if (note and not ok) else ''))
print('\n结果: %d/%d 通过' % (len(results) - bad, len(results)))
sys.exit(1 if bad else 0)
