#!/usr/bin/env python3
"""
Daily refresh — runs in GitHub Actions every day.

Tasks:
  1. Discovery: 1-2 date-bound queries to surface newly opened pet-friendly spots
  2. Re-verify: POIs whose freshness.checked_at > 14 days old
  3. Geocode any new POIs without lat/lng
  4. Re-apply verified filter
  5. Commit message includes stats — git commit/push is done by the workflow

Self-contained: no dependency on miniprogram-petguide/ directory; all logic here.
Inputs:
  - GEMINI_API_KEY env var (from GitHub Secret)
Outputs (in-place edits):
  - data/routes/*.md, *.json  (new discovery topics added)
  - data/routes.json, pois.json, _unverified_pois.json
"""
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# ---------- config ----------
API_KEY = os.environ.get("GEMINI_API_KEY", "")
if not API_KEY:
    print("FATAL: GEMINI_API_KEY env var required", file=sys.stderr)
    sys.exit(1)

GEN_MODEL = "gemini-2.5-pro"
FRESH_MODEL = "gemini-2.5-flash"

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.normpath(os.path.join(HERE, ".."))
DATA_DIR = os.path.join(WEB_DIR, "data")
ROUTES_DIR = os.path.join(DATA_DIR, "routes")
POIS_PATH = os.path.join(DATA_DIR, "pois.json")
ROUTES_JSON_PATH = os.path.join(DATA_DIR, "routes.json")
UNVER_PATH = os.path.join(DATA_DIR, "_unverified_pois.json")

TODAY = dt.date.today()
TODAY_STR = TODAY.strftime("%Y-%m-%d")
RECHECK_DAYS = 14

# ---------- HTTP helpers ----------
def gemini_call(model, prompt, tools_search=True, retries=2, max_tokens=8192, temp=0.3):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temp, "maxOutputTokens": max_tokens},
    }
    if tools_search:
        body["tools"] = [{"google_search": {}}]
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    for i in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and i < retries:
                time.sleep(10 * (i + 1))
                continue
            raise RuntimeError(f"HTTP {e.code}: {e.read()[:200]}")
        except urllib.error.URLError as e:
            if i < retries:
                time.sleep(5)
                continue
            raise
    return None

def extract_text(resp):
    cs = resp.get("candidates") or []
    if not cs:
        return ""
    content = cs[0].get("content") or {}
    parts = content.get("parts") or []
    return "".join(p.get("text", "") for p in parts if "text" in p)

def extract_chunks(resp):
    cs = resp.get("candidates") or []
    if not cs:
        return []
    meta = cs[0].get("groundingMetadata", {})
    out = []
    for ch in meta.get("groundingChunks", []):
        w = ch.get("web", {})
        if w.get("uri"):
            out.append({"title": w.get("title", ""), "uri": w["uri"]})
    return out

# ---------- 1. Discovery ----------
DISCOVERY_TEMPLATES = [
    # Each rotates by weekday
    "近 14 天内被小红书 / 大众点评 / 微博热议的北京宠物友好新地点",
    "{ym}北京新开 / 重装的宠物友好咖啡馆",
    "{ym}北京新开 / 重装的宠物友好餐厅与小酒馆",
    "{ym}北京新开 / 重装的宠物友好民宿、营地、宠物乐园",
    "近 30 天北京举办的宠物市集 / 领养日 / 宠物嘉年华",
    "近 14 天小红书博主推荐的北京带狗周末好去处",
    "本月（{ym}）北京宠物友好新晋打卡店",
]

def discover_today():
    """Run 1 date-bound discovery topic. Returns slug used."""
    ym = TODAY.strftime("%Y年%m月")
    weekday = TODAY.weekday()
    template = DISCOVERY_TEMPLATES[weekday % len(DISCOVERY_TEMPLATES)]
    title = template.format(ym=ym)
    slug = f"daily-{TODAY_STR}"

    # skip if already done today
    md_p = os.path.join(ROUTES_DIR, f"{slug}.md")
    js_p = os.path.join(ROUTES_DIR, f"{slug}.json")
    if os.path.isfile(md_p) and os.path.isfile(js_p):
        print(f"[discover] {slug} already exists, skipping")
        return slug

    prompt = build_discovery_prompt(title)
    print(f"[discover] {slug}: {title}")
    resp = gemini_call(GEN_MODEL, prompt, tools_search=True, max_tokens=16384, temp=0.35)
    text = extract_text(resp)
    chunks = extract_chunks(resp)
    if not text:
        print(f"[discover] empty response, skipping")
        return None

    md, data = split_md_json(text)
    if data is None:
        print(f"[discover] no JSON parsed, skipping")
        return None

    data["slug"] = slug
    data["topic_category"] = "season"
    data["topic_dim"] = f"daily-{weekday}"
    data["topic_tags"] = ["每日发现", "近期新开", ym]
    for p in data.get("pois", []):
        p["id"] = poi_id(p)
    data["grounding_sources"] = chunks

    with open(md_p, "w", encoding="utf-8") as f:
        f.write(f"# {data.get('title', title)}\n\n")
        # strip AI-style opener
        md_clean = strip_ai_voice(md or "")
        f.write(md_clean)
        if chunks:
            f.write("\n\n---\n\n## 来源\n\n")
            for i, c in enumerate(chunks, 1):
                t = c["title"] or "(无标题)"
                f.write(f"{i}. [{t}]({c['uri']})\n")
    with open(js_p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[discover] saved with {len(data.get('pois', []))} POIs")
    return slug

def build_discovery_prompt(title):
    return f"""你是面向养狗人的北京周末出行编辑。用 Google 搜索（覆盖小红书、马蜂窝、知乎、大众点评、澎湃、北京旅游网、北京本地宝、什么值得买等中文站点），调研下面这个主题：

主题：{title}

# 严格要求
- 只整理近 30 天内被网友/媒体提到的地点（旧的网红店不要写）
- 每个地点必须给出最新提及的具体日期（YYYY-MM 格式）
- 每个地点行尾必须紧跟 markdown 行内链接 `([来源](URL))`，URL 必须真实
- 没有近期证据的地点直接不写

# 输出格式（严格两段）

## PART_A_MARKDOWN
（1500~2500 字 markdown，含至少 6 个具体地点，每条包含：地址 / 商圈、为什么宠物友好、人均花费、近期提及日期、来源链接）

## PART_B_JSON

```json
{{
  "title": "...",
  "summary": "80~120 字摘要",
  "duration_hours": 4,
  "best_seasons": ["..."],
  "transport": "自驾 / 携宠网约车",
  "fit_dog_size": ["small", "medium"],
  "districts": ["..."],
  "tags": ["..."],
  "pois": [
    {{
      "name": "...",
      "category": "park|cafe|restaurant|hotel|petpark|mall|hike|water|vet|camp",
      "district": "...",
      "address_hint": "...",
      "why_friendly": "...",
      "tips": "...",
      "price_hint": "...",
      "source_url": "...",
      "source_name": "...",
      "latest_seen": "YYYY-MM"
    }}
  ],
  "checklist": [],
  "warnings": []
}}
```
"""

def split_md_json(text):
    m = re.search(r"##\s*PART_B_JSON\s*\n", text)
    if not m:
        return text, None
    md = re.sub(r"^##\s*PART_A_MARKDOWN\s*\n", "", text[:m.start()]).strip()
    rest = text[m.end():]
    jm = re.search(r"```json\s*\n(.*?)\n```", rest, re.DOTALL)
    jsstr = jm.group(1) if jm else None
    if not jsstr:
        i = rest.find("{"); j = rest.rfind("}")
        jsstr = rest[i:j+1] if i >= 0 and j > i else None
    if not jsstr:
        return md, None
    try:
        return md, json.loads(jsstr)
    except json.JSONDecodeError:
        return md, None

def strip_ai_voice(text):
    patterns = [
        re.compile(r'^[您你]?好[，,!！]?\s*[^\n]*?(?:我是|作为)[^\n]*?(?:编辑|专属|养狗人|铲屎官)[^\n]*?[。！\s]', re.MULTILINE),
        re.compile(r'^(?:嗨|哈喽|各位)[^\n]{0,80}?(?:铲屎官|养狗人|家长)[^\n]*?[。！]\s*', re.MULTILINE),
        re.compile(r'我是[您你]的专属[^\n]*?[。！]\s*'),
        re.compile(r'我是你们的专属?[^\n]*?编辑[^\n]*?[。！]\s*'),
        re.compile(r'我是你们的出行编辑[^\n]*?[。！]\s*'),
        re.compile(r'\bGemini\b'),
    ]
    for p in patterns:
        text = p.sub('', text)
    return text

def poi_id(poi):
    key = (poi.get("name", "") + "|" + poi.get("district", "")).strip().lower()
    return "p_" + hashlib.md5(key.encode("utf-8")).hexdigest()[:10]

# ---------- 2. Freshness re-verify stale ----------
def fresh_prompt(p):
    return f"""用 Google 搜索查证下面这个宠物友好地点近 6 个月的最新情况：

地点：{p.get('name')}
所在：{p.get('district','')}区
原本特点：{p.get('why_friendly','')}

输出严格要求：
- 第一个字符必须是 {{
- 只输出一个 JSON 对象
- 不要 markdown 代码块、不要解释、不要重复输出
- note 严格 ≤ 60 字

JSON 结构：
{{"status":"open|unclear|closed|policy_changed","latest_mention":"YYYY-MM或空","note":"≤60字","sources":[{{"name":"...","url":"..."}}]}}

status 取值：
- open: 仍正常营业且对宠物友好
- policy_changed: 营业但宠物政策变更
- closed: 已关停或完全禁宠
- unclear: 6 个月内没找到明确信息
"""

def parse_json_first_object(text):
    if not text:
        return None
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"```\s*$", "", s)
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(s[start:i+1])
                    except json.JSONDecodeError:
                        return None
    return None

def check_freshness(pid_p):
    pid, p = pid_p
    try:
        resp = gemini_call(FRESH_MODEL, fresh_prompt(p), tools_search=True, max_tokens=2048, temp=0.2, retries=1)
    except Exception as e:
        return {"pid": pid, "ok": False, "error": str(e)[:100]}
    text = extract_text(resp)
    obj = parse_json_first_object(text)
    if not obj or "status" not in obj:
        return {"pid": pid, "ok": False, "error": "json parse failed"}
    obj["checked_at"] = TODAY_STR
    return {"pid": pid, "ok": True, "freshness": obj}

def is_stale(p):
    fr = p.get("freshness") or {}
    ca = fr.get("checked_at")
    if not ca:
        return True
    try:
        d = dt.datetime.strptime(ca, "%Y-%m-%d").date()
    except Exception:
        return True
    return (TODAY - d).days >= RECHECK_DAYS

# ---------- 3. Geocoding (skip if already has lat/lng) ----------
UA = "PetGuideBJDaily/1.0"
DISTRICT_CENTROID = {
    "东城": (39.929, 116.416), "西城": (39.913, 116.366),
    "朝阳": (39.921, 116.486), "海淀": (39.959, 116.298),
    "丰台": (39.858, 116.287), "石景山": (39.906, 116.222),
    "通州": (39.909, 116.657), "大兴": (39.726, 116.341),
    "顺义": (40.130, 116.654), "昌平": (40.220, 116.231),
    "门头沟": (39.940, 116.106), "房山": (39.736, 115.973),
    "怀柔": (40.316, 116.632), "平谷": (40.144, 117.121),
    "密云": (40.376, 116.843), "延庆": (40.465, 115.985),
}

def photon(q):
    import urllib.parse as up
    url = "https://photon.komoot.io/api/?" + up.urlencode({"q": q, "limit": 1, "lang": "default"})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode("utf-8"))
            feats = d.get("features", [])
            if feats:
                c = feats[0]["geometry"]["coordinates"]
                return float(c[1]), float(c[0])
    except Exception:
        pass
    return None

def in_bj(lat, lng):
    return 39.4 <= lat <= 41.1 and 115.4 <= lng <= 117.5

def geocode_pois(pois):
    todo = [pid for pid, p in pois.items() if "lat" not in p]
    print(f"[geocode] {len(todo)} POIs need coords")
    last = 0
    for pid in todo:
        p = pois[pid]
        name = (p.get("name") or "").strip()
        district = (p.get("district") or "").strip()
        if not name:
            continue
        queries = [f"{name}, {district}区, 北京" if district else f"{name}, 北京", f"{name}, 北京"]
        result = None
        for q in queries:
            wait = 0.3 - (time.time() - last)
            if wait > 0:
                time.sleep(wait)
            last = time.time()
            r = photon(q)
            if r and in_bj(*r):
                result = r
                break
        if result:
            p["lat"], p["lng"] = round(result[0], 6), round(result[1], 6)
            p["geo_source"] = "nominatim"
        else:
            ct = DISTRICT_CENTROID.get(district)
            if ct:
                p["lat"], p["lng"] = ct[0], ct[1]
                p["geo_source"] = "district-centroid"

# ---------- 4. Build merged data (mirrors build_data.py minimal) ----------
def merge_route_into_pois(slug, route_data, pois, preserve_freshness=True):
    """Take a single route's JSON data and merge its POIs into the main pool."""
    for p in route_data.get("pois", []):
        pid = p.get("id")
        if not pid:
            continue
        if pid not in pois:
            pois[pid] = {
                "id": pid,
                "name": p.get("name", ""),
                "category": p.get("category", ""),
                "district": p.get("district", ""),
                "address_hint": p.get("address_hint", ""),
                "why_friendly": p.get("why_friendly", ""),
                "tips": p.get("tips", ""),
                "price_hint": p.get("price_hint", ""),
                "sources": [],
                "route_slugs": [],
                "city": "beijing",
                "city_name": "北京",
            }
        if p.get("source_url"):
            pois[pid]["sources"].append({
                "url": p["source_url"],
                "name": p.get("source_name", ""),
            })
        if slug not in pois[pid]["route_slugs"]:
            pois[pid]["route_slugs"].append(slug)

def dedupe_sources(pois):
    for p in pois.values():
        seen, uniq = set(), []
        for s in p.get("sources", []):
            if s["url"] in seen:
                continue
            seen.add(s["url"])
            uniq.append(s)
        p["sources"] = uniq
        p["route_slugs"] = sorted(set(p.get("route_slugs", [])))

def add_route_to_routes_json(slug, route_data, routes_list):
    """Add or update a route's metadata in routes.json."""
    for i, r in enumerate(routes_list):
        if r.get("id") == slug:
            routes_list.pop(i)
            break
    rec = {
        "id": slug,
        "title": route_data.get("title", ""),
        "summary": route_data.get("summary", ""),
        "duration_hours": route_data.get("duration_hours"),
        "best_seasons": route_data.get("best_seasons", []),
        "transport": route_data.get("transport", ""),
        "fit_dog_size": route_data.get("fit_dog_size", []),
        "districts": route_data.get("districts", []),
        "tags": list({*(route_data.get("tags", []) or []), *(route_data.get("topic_tags", []) or [])}),
        "category": route_data.get("topic_category", ""),
        "dim": route_data.get("topic_dim", ""),
        "poi_ids": [p["id"] for p in route_data.get("pois", []) if "id" in p],
        "poi_count": len([p for p in route_data.get("pois", []) if "id" in p]),
        "checklist": route_data.get("checklist", []),
        "warnings": route_data.get("warnings", []),
        "city": "beijing",
        "city_name": "北京",
        "order": 9999 + (TODAY - dt.date(2026, 1, 1)).days,  # daily ones go to the end
    }
    routes_list.append(rec)

# ---------- 5. Filter ----------
def filter_verified(pois, routes_list):
    kept = {}
    dropped = {}
    for pid, p in pois.items():
        fr = p.get("freshness")
        if fr and fr.get("status") == "open":
            kept[pid] = p
        else:
            reason = "no_freshness_check" if not fr else fr.get("status", "unclear")
            dropped[pid] = {**p, "_drop_reason": reason}
    for r in routes_list:
        orig = r.get("poi_ids", []) or []
        new = [pid for pid in orig if pid in kept]
        r["poi_ids"] = new
        r["poi_count"] = len(new)
        r["verified"] = len(new) >= 3
    return kept, dropped

# ---------- main ----------
def main():
    # Load existing
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)
    with open(ROUTES_JSON_PATH, encoding="utf-8") as f:
        routes = json.load(f)

    # Restore previously dropped POIs (so we can re-check)
    if os.path.isfile(UNVER_PATH):
        with open(UNVER_PATH, encoding="utf-8") as f:
            unver = json.load(f)
        for pid, p in unver.items():
            if pid not in pois:
                p.pop("_drop_reason", None)
                pois[pid] = p
        print(f"[restore] merged back {len(unver)} previously-dropped POIs for re-check")

    print(f"[start] pois={len(pois)}, routes={len(routes)}")

    # 1. Discovery
    new_slug = discover_today()
    if new_slug:
        js_p = os.path.join(ROUTES_DIR, f"{new_slug}.json")
        if os.path.isfile(js_p):
            with open(js_p, encoding="utf-8") as f:
                rd = json.load(f)
            merge_route_into_pois(new_slug, rd, pois)
            add_route_to_routes_json(new_slug, rd, routes)
            dedupe_sources(pois)
            print(f"[discovery] merged {new_slug} into pool")

    # 2. Find stale POIs needing re-verification
    stale = [(pid, p) for pid, p in pois.items() if is_stale(p)]
    # cap per run to avoid burning quota
    MAX_PER_RUN = 80
    stale = stale[:MAX_PER_RUN]
    print(f"[freshness] re-checking {len(stale)} stale POIs (cap {MAX_PER_RUN})")
    ok_count, fail_count, status_counts = 0, 0, {}
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for r in ex.map(check_freshness, stale):
            if r.get("ok"):
                pois[r["pid"]]["freshness"] = r["freshness"]
                ok_count += 1
                s = r["freshness"].get("status", "?")
                status_counts[s] = status_counts.get(s, 0) + 1
            else:
                fail_count += 1
    print(f"[freshness] ok={ok_count}, fail={fail_count}, status={status_counts}")

    # 3. Geocode any new ones
    geocode_pois(pois)

    # 4. Filter
    kept, dropped = filter_verified(pois, routes)
    print(f"[filter] kept={len(kept)}, dropped={len(dropped)}")

    # Save
    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(kept, f, ensure_ascii=False, indent=1)
    with open(UNVER_PATH, "w", encoding="utf-8") as f:
        json.dump(dropped, f, ensure_ascii=False, indent=1)
    with open(ROUTES_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(routes, f, ensure_ascii=False, indent=1)

    # cities.json refresh (since route count may have changed)
    with open(os.path.join(DATA_DIR, "cities.json"), "w", encoding="utf-8") as f:
        json.dump([{"key": "beijing", "name": "北京", "count": len(routes)}], f, ensure_ascii=False, indent=1)

    print(f"[done] verified routes: {sum(1 for r in routes if r.get('verified'))}, verified POIs: {len(kept)}")


if __name__ == "__main__":
    main()
