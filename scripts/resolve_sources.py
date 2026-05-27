#!/usr/bin/env python3
"""
Resolve Gemini's vertex-grounding redirect URLs into real article URLs,
verify domain matches the source name, drop mismatches, dedupe by domain.

Why: Gemini returns short-lived vertexaisearch.cloud.google.com/... tokens that
either expire, 404, or land on unrelated cache pages (Baidu Wenku snapshots,
generic search results). For a public site we only want links that actually
go where the label says they go.
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
POIS_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "pois.json"))
UNVER_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "_unverified_pois.json"))

UA = "Mozilla/5.0 (compatible; PetGuideBJ/1.0; resolver)"
TIMEOUT = 10

# Source name → known domain substrings. Final URL host must contain ONE of these
# for us to trust the link. (We allow substring match to handle subdomains.)
SOURCE_DOMAINS = {
    "小红书":         ["xiaohongshu.com", "xhslink.com"],
    "大众点评":       ["dianping.com"],
    "澎湃新闻":       ["thepaper.cn"],
    "澎湃":           ["thepaper.cn"],
    "北京旅游网":     ["visitbeijing.com.cn"],
    "北京本地宝":     ["bj.bendibao.com", "bendibao.com"],
    "什么值得买":     ["smzdm.com"],
    "马蜂窝":         ["mafengwo.cn", "mafengwo.com"],
    "知乎":           ["zhihu.com", "zhihu.com.cn"],
    "微博":           ["weibo.com", "weibo.cn"],
    "36氪":           ["36kr.com"],
    "Time Out":       ["timeoutbeijing.com", "timeout.com"],
    "timeoutbeijing": ["timeoutbeijing.com"],
    "美团":           ["meituan.com"],
    "携程":           ["ctrip.com", "trip.com"],
    "微信":           ["mp.weixin.qq.com", "weixin.qq.com"],
    "公众号":         ["mp.weixin.qq.com"],
    "嗅评食堂":       ["qq.com", "weixin.qq.com"],
    "BTV":            ["btime.com", "btv.com.cn"],
    "新京报":         ["bjnews.com.cn"],
    "凤凰网":         ["ifeng.com"],
    "搜狐":           ["sohu.com"],
    "网易":           ["163.com"],
    "Trip.com":       ["trip.com"],
    "Visit Beijing":  ["visitbeijing.com.cn"],
}

# domains we never accept as "article" landing (caches / aggregators / homepages)
BLOCKLIST_HOSTS = {
    "word.baidu.com",       # Baidu Wenku preview cache
    "wenku.baidu.com",
    "baike.baidu.com",      # generic encyclopedia, not the source's content
    "www.google.com",
    "www.bing.com",
    "vertexaisearch.cloud.google.com",
}


def resolve_url(url):
    """Follow redirects, return (final_url, host) or (None, None)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        # HEAD first; fall back to GET if HEAD not allowed
        for method in ("HEAD", "GET"):
            req.method = method
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                    final = resp.geturl()
                    host = urlparse(final).netloc.lower()
                    return final, host
            except urllib.error.HTTPError as e:
                if e.code in (403, 405) and method == "HEAD":
                    continue
                # 404 / 410 → drop
                return None, None
            except Exception:
                return None, None
    except Exception:
        pass
    return None, None


def host_matches_source(host, source_name):
    """Return True if host appears to belong to source_name's known domains."""
    if not host:
        return False
    if host in BLOCKLIST_HOSTS:
        return False
    expected = []
    for key, domains in SOURCE_DOMAINS.items():
        if key.lower() in source_name.lower():
            expected.extend(domains)
    if not expected:
        # source name not in our map — accept any non-blocked host
        return host not in BLOCKLIST_HOSTS
    return any(d in host for d in expected)


def dedupe_by_host(sources):
    """Keep first occurrence per host."""
    seen = set()
    out = []
    for s in sources:
        host = urlparse(s.get("url", "")).netloc.lower()
        if not host or host in seen:
            continue
        seen.add(host)
        out.append(s)
    return out


def process_source(s):
    """Resolve one source, returning a cleaned dict or None to drop."""
    url = s.get("url") or ""
    name = s.get("name") or ""
    if not url:
        return None
    # Pass-through if not a vertex redirect (likely already real)
    if "vertexaisearch" not in url:
        return s
    final, host = resolve_url(url)
    if not final or not host:
        return None
    if not host_matches_source(host, name):
        return None
    return {"url": final, "name": name}


def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)

    # Gather every (pid, source_index, source) tuple
    tasks = []
    for pid, p in pois.items():
        for i, s in enumerate(p.get("sources", [])):
            tasks.append((pid, i, s))

    print(f"[start] {len(tasks)} source URLs to resolve across {len(pois)} POIs")

    # Resolve in parallel
    results = [None] * len(tasks)
    with cf.ThreadPoolExecutor(max_workers=12) as ex:
        for idx, r in enumerate(ex.map(lambda t: process_source(t[2]), tasks)):
            results[idx] = r
            if (idx + 1) % 50 == 0:
                print(f"  ... {idx + 1}/{len(tasks)}")

    # Apply: rebuild each POI's sources keeping only resolved ones
    by_pid = {}
    for (pid, i, _), r in zip(tasks, results):
        by_pid.setdefault(pid, []).append(r)

    n_total_before = 0
    n_total_after = 0
    for pid, p in pois.items():
        n_total_before += len(p.get("sources", []))
        cleaned = [r for r in by_pid.get(pid, []) if r is not None]
        cleaned = dedupe_by_host(cleaned)
        p["sources"] = cleaned
        n_total_after += len(cleaned)

    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)

    print(f"\n[done] kept {n_total_after} / {n_total_before} source URLs")
    print(f"  POIs with at least 1 verified source: {sum(1 for p in pois.values() if p.get('sources'))}")
    print(f"  POIs with 0 verified sources:         {sum(1 for p in pois.values() if not p.get('sources'))}")


if __name__ == "__main__":
    main()
