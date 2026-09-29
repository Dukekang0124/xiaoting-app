#!/usr/bin/env python3
# 等待某个 tag 的 CI 构建完成，并从 GitHub Release 下载 APK 到桌面，校验 PK 魔数 + 内嵌版本。
#
# 用法：
#   GH_TOKEN=<token> TAG=v1.1.0 [HEAD=<sha 前缀>] python _selftest/fetch_apk.py
# 说明：
#   · GH_TOKEN 必填（GitHub PAT，需要 repo + workflow 读权限）。
#   · TAG 默认取 argv[1]；HEAD 可选（给了就按 commit 前缀精确定位本次 run）。
#   · 产物落到桌面：C:/Users/Admin/Desktop/墨小溟-<TAG>-release.apk
import os, sys, time, json, zipfile, urllib.request

REPO = "Dukekang0124/xiaoting-app"
TAG = os.environ.get("TAG") or (sys.argv[1] if len(sys.argv) > 1 else "v1.1.0")
HEAD = os.environ.get("HEAD", "")
TOKEN = os.environ.get("GH_TOKEN", "")
DESKTOP = "C:/Users/Admin/Desktop"
VERSION_EXPECT = TAG.lstrip("v")
OUT = os.path.join(DESKTOP, f"墨小溟-{TAG}-release.apk")
MAX_WAIT = 30 * 60  # 30 分钟上限
POLL = 20


def api(url):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def get_run(started_at):
    d = api(f"https://api.github.com/repos/{REPO}/actions/runs?per_page=20")
    runs = d.get("workflow_runs", [])
    # ① 精确按 commit 前缀匹配（最可靠）
    if HEAD:
        for r in runs:
            if r.get("head_sha", "").startswith(HEAD):
                return r
    # ② 按 tag 名匹配（tag push 事件 head_branch 通常 = tag 名）
    for r in runs:
        if r.get("head_branch") == TAG:
            return r
    # ③ 兜底：脚本启动后新建的最近一次 run
    for r in runs:
        if r.get("created_at", "") >= started_at:
            return r
    return None


def download(url, dest):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read()
    with open(dest, "wb") as f:
        f.write(data)
    return len(data)


def main():
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[wait] 轮询 CI 构建 (tag={TAG}, head={HEAD or '(any)'}) ...", flush=True)
    start = time.time()
    run = None
    while time.time() - start < MAX_WAIT:
        try:
            run = get_run(started_at)
        except Exception as e:
            print(f"[warn] API 错误: {e}", flush=True)
        if run:
            st, con = run["status"], run.get("conclusion")
            print(f"[poll] run={run['id']} status={st} conclusion={con}", flush=True)
            if st == "completed":
                if con != "success":
                    print(f"[FAIL] 构建未成功: conclusion={con}", flush=True)
                    sys.exit(2)
                break
        time.sleep(POLL)
    else:
        print("[FAIL] 超时未等到构建完成", flush=True)
        sys.exit(3)

    # 成功：从 Release 取资产下载地址
    rel = api(f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}")
    url = None
    for a in rel.get("assets", []):
        if a["name"].endswith(".apk"):
            url = a["browser_download_url"]
            print(f"[dl] 资产: {a['name']} ({a['size']} bytes)", flush=True)
            break
    if not url:
        url = f"https://github.com/{REPO}/releases/download/{TAG}/Xiaoting-v{VERSION_EXPECT}-release.apk"
        print(f"[dl] 回退直链: {url}", flush=True)

    try:
        n = download(url, OUT)
        print(f"[ok] 已下载 {n} bytes -> {OUT}", flush=True)
    except Exception as e:
        print(f"[FAIL] 下载失败: {e}", flush=True)
        sys.exit(4)

    with open(OUT, "rb") as f:
        head = f.read(2)
    if head != b"PK":
        print(f"[FAIL] 文件头不是 PK（APK/ZIP 魔数），实际: {head!r}", flush=True)
        sys.exit(5)
    print("[ok] PK 魔数校验通过 (APK/ZIP)", flush=True)

    with zipfile.ZipFile(OUT) as z:
        try:
            idx = z.read("assets/public/index.html").decode("utf-8", "ignore")
        except KeyError:
            names = [n for n in z.namelist() if n.endswith("index.html")][:1]
            idx = z.read(names[0]).decode("utf-8", "ignore") if names else ""
    if f"APP_VERSION = '{VERSION_EXPECT}'" in idx or f"APP_VERSION='{VERSION_EXPECT}'" in idx:
        print(f"[ok] APK 内嵌网页版本 = {VERSION_EXPECT} ✓", flush=True)
    else:
        print(f"[warn] 未在 APK 内 index.html 找到 APP_VERSION = '{VERSION_EXPECT}'", flush=True)
    import hashlib
    with open(OUT, "rb") as f:
        data = f.read()
    print(f"[md5] {hashlib.md5(data).hexdigest()}", flush=True)
    print(f"[size] {len(data)}", flush=True)
    print("[DONE]", flush=True)


if __name__ == "__main__":
    main()
