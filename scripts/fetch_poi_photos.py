#!/usr/bin/env python3
"""
For each POI, fetch og:image from its existing source URLs (xhs, dianping,
visitbeijing, thepaper, smzdm 等). Save the first usable photo URL into
poi['photo_url'].

Idempotent: skips POIs that already have photo_url.

Strategy:
  1. Iterate p.sources URLs
  2. For each URL, fetch HTML with realistic User-Agent
  3. Parse <meta property="og:image"> / twitter:image / first <img>
  4. Validate via HEAD request (Content-Type starts with image/)
  5. Save first valid one
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
POIS_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "pois.json"))

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# 优先级排序 (来源域)：可信度高的站点优先
HOST_PRIORITY = {
    "xiaohongshu.com": 5, "xhscdn.com": 5,
    "dianping.com": 4,
    "visitbeijing.com.cn": 4,
    "thepaper.cn": 3,
    "smzdm.com": 3,
    "mafengwo.cn": 3, "mafengwo.com": 3,
    "weibo.com": 2,
    "mp.weixin.qq.com": 4,   # WeChat articles often have good cover images
    "36kr.com": 2,
    "ifeng.com": 2, "sohu.com": 2, "163.com": 2,
}

# OG image regex (greedy enough)
RE_OG = re.compile(
    r'<meta\s+[^>]*(?:property|name)\s*=\s*["\']?'
    r'(?:og:image|twitter:image|twitter:image:src)["\']?[^>]*'
    r'content\s*=\s*["\']([^"\']+)["\']',
    re.IGNORECASE
)
RE_OG_REV = re.compile(
    r'<meta\s+[^>]*content\s*=\s*["\']([^"\']+)["\'][^>]*'
    r'(?:property|name)\s*=\s*["\']?(?:og:image|twitter:image|twitter:image:src)',
    re.IGNORECASE
)


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ct = r.headers.get("Content-Type", "")
            data = r.read(300000)  # 最多 300KB
            charset = "utf-8"
            m = re.search(r"charset=([\w-]+)", ct)
            if m:
                charset = m.group(1)
            try:
                return data.decode(charset, errors="replace")
            except Exception:
                return data.decode("utf-8", errors="replace")
    except Exception:
        return None


def head_check_image(url, timeout=8):
    """HEAD 检查是不是图片"""
    req = urllib.request.Request(url, headers=HEADERS, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ct = r.headers.get("Content-Type", "").lower()
            cl = int(r.headers.get("Content-Length", "0") or "0")
            return ct.startswith("image/") and cl > 5000  # 至少 5KB
    except Exception:
        return False


def parse_og_image(html, base_url):
    if not html:
        return None
    candidates = []
    for pat in (RE_OG, RE_OG_REV):
        for m in pat.finditer(html):
            url = m.group(1).strip()
            if url:
                candidates.append(url)
    # 兜底：找 <img src=...> 第一个看上去 OK 的
    if not candidates:
        for m in re.finditer(r'<img[^>]+src\s*=\s*["\']([^"\']+)["\']', html, re.IGNORECASE):
            u = m.group(1).strip()
            if any(x in u.lower() for x in ('logo', 'avatar', 'icon', '1x1', 'pixel')):
                continue
            candidates.append(u)
            if len(candidates) >= 3:
                break
    # 解析相对路径
    out = []
    for u in candidates:
        if u.startswith('//'):
            u = 'https:' + u
        elif u.startswith('/'):
            u = urljoin(base_url, u)
        elif not u.startswith('http'):
            u = urljoin(base_url, u)
        out.append(u)
    return out


def try_poi(p):
    pid = p['id']
    if p.get('photo_url'):
        return {'pid': pid, 'skip': True}
    sources = p.get('sources') or []
    if not sources:
        return {'pid': pid, 'ok': False, 'reason': 'no sources'}

    # 按域名优先级排序
    sorted_src = sorted(sources, key=lambda s: -HOST_PRIORITY.get(urlparse(s.get('url', '')).netloc.replace('www.', '').split('.', 1)[-1] if '.' in urlparse(s.get('url', '')).netloc else '', HOST_PRIORITY.get(urlparse(s.get('url', '')).netloc, 0)))

    for s in sorted_src:
        url = s.get('url')
        if not url:
            continue
        html = fetch(url)
        if not html:
            continue
        candidates = parse_og_image(html, url) or []
        for c in candidates:
            if head_check_image(c):
                return {'pid': pid, 'ok': True, 'photo_url': c, 'src': url}
    return {'pid': pid, 'ok': False, 'reason': 'no image'}


def main():
    with open(POIS_PATH, encoding='utf-8') as f:
        pois = json.load(f)

    todo = [p for p in pois.values() if not p.get('photo_url')]
    print(f"to fetch photos: {len(todo)} / total {len(pois)}", flush=True)

    n_ok = 0; n_fail = 0
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for r in ex.map(try_poi, todo):
            if r.get('skip'):
                continue
            pid = r['pid']
            name = pois[pid]['name'][:24]
            if r.get('ok'):
                pois[pid]['photo_url'] = r['photo_url']
                n_ok += 1
                print(f"  [{n_ok}] OK   {name:24} | {r['photo_url'][:80]}", flush=True)
            else:
                n_fail += 1
                print(f"  -    fail {name:24} | {r.get('reason')}", flush=True)
            # checkpoint
            if (n_ok + n_fail) % 20 == 0:
                with open(POIS_PATH, 'w', encoding='utf-8') as f:
                    json.dump(pois, f, ensure_ascii=False, indent=1)

    with open(POIS_PATH, 'w', encoding='utf-8') as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)

    print(f"\n=== done === ok={n_ok}, fail={n_fail}")


if __name__ == '__main__':
    main()
