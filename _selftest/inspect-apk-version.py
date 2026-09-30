#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
开包读版本：判「这个 APK 到底是哪一版」的唯一可信手段。

🔴 为什么必须开包：文件名（200 不等于就是那版）、md5（只证明与清单同源）、
   体积（历史上两版曾逐字节相等，都是 3 367 544）**都不是版本证据**。
   唯一可信的是包内 `assets/public/index.html` 里的 `window.APP_VERSION`。

顺带核对：包内是否真的含这一版改动过的文件与特征串 —— 防「版本号升了、代码没上」。

用法：
  python _selftest/inspect-apk-version.py apk-dist/Xiaoting-v1.3.5-release.apk
  python _selftest/inspect-apk-version.py            # 默认读 apk-dist/ 下 mtime 最新的包
"""
import zipfile, re, sys, os, glob

MARKS = {
    'assets/public/js/app.js': ['replayIpColors', 'readIpInlineColors', 'scheduleIdleRevert', 'touchInteraction', 'NODE_BUBBLE.listening'],
    'assets/public/js/state-machine.js': ['IP_SETTINGS_DEFAULT', 'BASE_SETTINGS_DEFAULT', 'NODE_BUBBLE'],
    'assets/public/js/store.js': ['touchInteraction', 'IP_SETTINGS_DEFAULT'],
    'assets/public/js/prompts.js': ['不用急着说清楚'],
    'assets/public/sw.js': [],
}
STRUCT = ['assets/public/index.html', 'assets/public/styles.css', 'assets/public/manifest.webmanifest',
          'assets/public/js/state-machine.js', 'assets/public/js/copywriting.js',
          'assets/public/js/interaction.js', 'assets/public/js/ip-audio.js']


def pick_default():
    cands = glob.glob(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'apk-dist', '*.apk'))
    if not cands:
        return None
    return max(cands, key=lambda f: os.path.getmtime(f))


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else pick_default()
    if not path or not os.path.exists(path):
        print('✗ 找不到安装包：%s\n  先跑 node scripts/fetch-dist-apk.mjs' % path)
        return 2
    print('包：%s' % path)
    print('体积：%d 字节' % os.path.getsize(path))

    z = zipfile.ZipFile(path)
    names = z.namelist()

    def read(suffix):
        hit = sorted([n for n in names if n.endswith(suffix)], key=len)
        if not hit:
            return None
        return z.read(hit[0]).decode('utf-8', 'ignore')

    html = read('assets/public/index.html')
    if not html:
        print('✗ 包内没有 assets/public/index.html —— 不是本项目的 Capacitor 产物')
        return 1
    m = re.search(r"APP_VERSION\s*=\s*'([^']+)'", html)
    ver = m.group(1) if m else None
    print('APP_VERSION = %s   ← 版本证据（唯一可信）' % (ver or 'NOT FOUND'))

    sw = read('assets/public/sw.js') or ''
    mc = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
    man = read('assets/public/manifest.webmanifest') or ''
    mv = re.search(r'"version"\s*:\s*"([^"]+)"', man)
    print('sw.js CACHE = %s   manifest version = %s' % (mc.group(1) if mc else '?', mv.group(1) if mv else '?'))

    ok = True
    print('\n--- 结构完整性 ---')
    for f in STRUCT:
        hit = [n for n in names if n == f]
        print('  %-44s %s' % (f, '在包' if hit else '缺失'))
        if not hit:
            ok = False

    print('\n--- 本版特征串 ---')
    for f, keys in MARKS.items():
        t = read(f)
        if t is None:
            print('  %-44s 缺失' % f)
            ok = False
            continue
        missing = [k for k in keys if k not in t]
        print('  %-44s %s' % (f, '齐' if not missing else '缺 ' + ','.join(missing)))
        if missing:
            ok = False

    print('\n结果：%s' % ('✅ 包内即 %s，且本版改动都在' % ver if ok else '❌ 有缺失'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
