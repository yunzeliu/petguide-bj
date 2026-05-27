#!/usr/bin/env python3
"""
Google Custom Search Engine (CSE) discovery — pulls fresh xhs results, extracts
new POI candidates.

How it works:
  1. 跑 N 条针对 site:xiaohongshu.com 的 query（按 weekday 轮换 14 条；每天 3 条）
  2. 每条 query 拿到 ≤10 条 (CSE 单次上限)，三条 query 大约 ~30 条结果
  3. 用 Gemini 单次 batch 调用从标题+摘要里提取地名（结构化 JSON）
  4. 与现有 pois.json 比对，加入新候选（不重复）
  5. 不存储 xhs 帖子正文，只保留地名 + xhs URL 作为来源

Env vars required:
  - GOOGLE_CSE_KEY   (Google API key with Custom Search API enabled)
  - GOOGLE_CSE_CX    (Programmable Search Engine ID)
  - GEMINI_API_KEY   (Gemini API for extraction step)

Free tier: 100 queries/day. We use 3/day.
"""
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CSE_KEY = os.environ.get("GOOGLE_CSE_KEY", "")
CSE_CX  = os.environ.get("GOOGLE_CSE_CX", "")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
if not (CSE_KEY and CSE_CX and GEMINI_KEY):
    print("FATAL: GOOGLE_CSE_KEY, GOOGLE_CSE_CX, GEMINI_API_KEY env vars required", file=sys.stderr)
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(HERE, "..", "data"))
POIS_PATH = os.path.join(DATA_DIR, "pois.json")
TODAY = dt.date.today()
TODAY_STR = TODAY.strftime("%Y-%m-%d")

# ===== Query rotation (14 queries; 3 per day → ~5-day full cycle) =====
CSE_QUERIES = [
    # 区域
    "site:xiaohongshu.com 朝阳 宠物友好",
    "site:xiaohongshu.com 海淀 遛狗",
    "site:xiaohongshu.com 通州 带狗",
    "site:xiaohongshu.com 顺义 带狗",
    "site:xiaohongshu.com 怀柔 民宿 带狗",
    "site:xiaohongshu.com 平谷 宠物 友好",
    # 品类
    "site:xiaohongshu.com 北京 宠物友好 咖啡",
    "site:xiaohongshu.com 北京 宠物友好 餐厅",
    "site:xiaohongshu.com 北京 宠物友好 商场",
    "site:xiaohongshu.com 北京 宠物友好 露营",
    "site:xiaohongshu.com 北京 带狗 公园",
    # 季节 / 主题
    "site:xiaohongshu.com 北京 樱花 带狗",
    "site:xiaohongshu.com 北京 银杏 带狗",
    "site:xiaohongshu.com 北京 雪 带狗",
]


def cse_search(query, num=10):
    """Google Custom Search call. dateRestrict='m1' = past month."""
    url = "https://www.googleapis.com/customsearch/v1?" + urllib.parse.urlencode({
        "key": CSE_KEY,
        "cx": CSE_CX,
        "q": query,
        "num": min(num, 10),  # max 10 per request
        "dateRestrict": "m1",  # past 1 month for freshness
        "lr": "lang_zh-CN",
        "safe": "active",
    })
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("items", []) or []
    except urllib.error.HTTPError as e:
        body = e.read()[:300].decode("utf-8", "replace")
        print(f"[cse] HTTP {e.code}: {body}", file=sys.stderr)
    except Exception as e:
        print(f"[cse] error: {e}", file=sys.stderr)
    return []


def gemini_extract(snippets):
    """Single Gemini call: extract place names from a batch of search snippets."""
    if not snippets:
        return []
    body_lines = []
    for i, s in enumerate(snippets, 1):
        title = (s.get("title") or "").replace("\n", " ").strip()
        # CSE puts snippet in 'snippet' field
        desc = (s.get("snippet") or "").replace("\n", " ").strip()
        link = s.get("link") or ""
        body_lines.append(f"[{i}] 标题：{title}\n    摘要：{desc[:300]}\n    URL：{link}")
    body = "\n\n".join(body_lines)

    prompt = f"""下面是 {len(snippets)} 个小红书帖子的标题+摘要+URL。请从中提取**真实被网友提到的、位于北京的、对宠物友好的具体地点/商家**。

# 帖子列表
{body}

# 严格输出要求
- 只输出一个 JSON 数组，第一字符必须是 [
- 每条对象结构：
{{"name":"地点中文名","district":"朝阳|海淀|通州|顺义|怀柔|平谷|延庆|密云|昌平|门头沟|房山|大兴|丰台|石景山|东城|西城","category":"park|cafe|restaurant|hotel|petpark|mall|hike|water|vet|camp","why":"≤30字 为什么宠物友好（基于摘要）","source_snippet":"≤80字 摘要原文","source_url":"对应原帖URL"}}
- 同一地点只列一次
- 摘要里没有明确提到"带狗"/"宠物友好"/"可携宠"等字样的，不要列
- 商家名不清楚的不要列
- 不要返回 markdown 代码块、不要任何解释
"""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 4096},
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            resp = json.loads(r.read())
    except Exception as e:
        print(f"[gemini] error: {e}", file=sys.stderr)
        return []
    parts = (resp.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts if "text" in p)
    if not text:
        return []
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"```\s*$", "", text)
    i = text.find("[")
    j = text.rfind("]")
    if i < 0 or j <= i:
        return []
    try:
        return json.loads(text[i:j+1])
    except json.JSONDecodeError as e:
        print(f"[gemini] json parse failed: {e}", file=sys.stderr)
        return []


def poi_id(name, district):
    key = (name + "|" + (district or "")).strip().lower()
    return "p_" + hashlib.md5(key.encode("utf-8")).hexdigest()[:10]


def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)

    # Pick queries: 3 per day, rotating through 14 → full cycle every ~5 days
    weekday = TODAY.weekday()
    base = (weekday * 3) % len(CSE_QUERIES)
    todays = [CSE_QUERIES[(base + i) % len(CSE_QUERIES)] for i in range(3)]
    print(f"[cse] today's {len(todays)} queries:")
    for q in todays:
        print(f"  - {q}")

    all_snippets = []
    for q in todays:
        r = cse_search(q, num=10)
        print(f"[cse] '{q[:40]}...': {len(r)} results")
        all_snippets.extend(r)
        time.sleep(0.3)

    if not all_snippets:
        print("[cse] no results, exiting")
        return

    # Dedupe by URL
    seen_urls = set()
    uniq = []
    for s in all_snippets:
        u = s.get("link")
        if not u or u in seen_urls:
            continue
        seen_urls.add(u)
        uniq.append(s)
    print(f"[cse] {len(uniq)} unique snippets")

    extracted = gemini_extract(uniq)
    print(f"[gemini] extracted {len(extracted)} candidate POIs")

    # Add to pois.json
    added = 0
    enriched_existing = 0
    for cand in extracted:
        name = (cand.get("name") or "").strip()
        if not name:
            continue
        district = (cand.get("district") or "").strip()
        pid = poi_id(name, district)
        if pid in pois:
            existing_urls = {s.get("url") for s in pois[pid].get("sources", [])}
            if cand.get("source_url") and cand["source_url"] not in existing_urls:
                pois[pid].setdefault("sources", []).append({
                    "url": cand["source_url"],
                    "name": "小红书",
                })
                enriched_existing += 1
            continue
        pois[pid] = {
            "id": pid,
            "name": name,
            "category": cand.get("category", "park"),
            "district": district,
            "address_hint": "",
            "why_friendly": (cand.get("why") or "")[:80],
            "tips": "",
            "price_hint": "",
            "sources": [{
                "url": cand.get("source_url", ""),
                "name": "小红书",
            }] if cand.get("source_url") else [],
            "route_slugs": [f"cse-discovery-{TODAY_STR}"],
            "city": "beijing",
            "city_name": "北京",
            "discovered_at": TODAY_STR,
            "discovered_by": "google-cse",
        }
        added += 1

    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)

    print(f"\n[done] added {added} new candidate POIs, enriched {enriched_existing} existing")
    print(f"  total POIs now: {len(pois)} (will be verified by next freshness pass)")


if __name__ == "__main__":
    main()
