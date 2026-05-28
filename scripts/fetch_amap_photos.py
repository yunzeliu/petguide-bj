#!/usr/bin/env python3
"""
Fetch real venue photos via Amap Web Service API for POIs that Google
Places couldn't find. Amap has better coverage of small Chinese venues.

Steps per POI:
  1. /v3/place/text — search by name + district, get first POI with photos
  2. Download photo URL from photos[0].url
  3. Save to data/photos/{poi_id}.jpg + update poi.photo_url + photo_attribution

Only processes POIs that:
  - Don't already have a local photo
  - Either have photo_attempted=True (previous Google failure) OR no attempt yet
"""
import concurrent.futures as cf
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KEY = os.environ.get("AMAP_API_KEY", "")
if not KEY:
    print("FATAL: AMAP_API_KEY env var required", file=sys.stderr)
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
POIS_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "pois.json"))
PHOTOS_DIR = os.path.normpath(os.path.join(HERE, "..", "data", "photos"))
os.makedirs(PHOTOS_DIR, exist_ok=True)

UA = "Mozilla/5.0 PawsPath-Amap-Photo/1.0"


def amap_search(name, district, retries=2):
    """Return first POI with photos[].url, or None."""
    q_variants = []
    if district:
        q_variants.append(f"{name} {district}区")
        q_variants.append(name)
    else:
        q_variants.append(name)

    for q in q_variants:
        url = (
            "https://restapi.amap.com/v3/place/text?"
            + urllib.parse.urlencode({
                "key": KEY,
                "keywords": q,
                "city": "北京",
                "citylimit": "true",
                "extensions": "all",
                "offset": "5",
                "page": "1",
            })
        )
        for i in range(retries + 1):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=15) as r:
                    data = json.loads(r.read().decode("utf-8"))
                break
            except (urllib.error.URLError, TimeoutError, OSError):
                if i < retries:
                    time.sleep(2 * (i + 1))
                    continue
                data = None
        if not data:
            continue
        if data.get("status") != "1":
            info = data.get("info", "")
            if "DAILY_QUERY_OVER_LIMIT" in info or "USER_DAILY_QUERY_OVER_LIMIT" in info:
                print(f"  ! quota exhausted: {info}", file=sys.stderr)
                return "QUOTA_OUT"
            print(f"  ! amap error: {info}", file=sys.stderr)
            continue
        pois_res = data.get("pois", []) or []
        for p in pois_res:
            photos = p.get("photos") or []
            # filter valid photo URLs
            valid_photos = [ph for ph in photos if ph.get("url", "").startswith("http")]
            if valid_photos:
                return {
                    "name": p.get("name"),
                    "address": p.get("address"),
                    "adname": p.get("adname"),
                    "location": p.get("location"),  # "lng,lat"
                    "amap_id": p.get("id"),
                    "photo_url": valid_photos[0]["url"],
                    "photo_title": valid_photos[0].get("title", ""),
                }
    return None


def download_photo(url, save_path, timeout=20):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ct = r.headers.get("Content-Type", "")
            if not ct.startswith("image/"):
                return False
            data = r.read()
            if len(data) < 5000:
                return False
            with open(save_path, "wb") as f:
                f.write(data)
            return True
    except Exception:
        return False


def process(p):
    pid = p["id"]
    if (p.get("photo_url") or "").startswith("data/photos/"):
        return {"pid": pid, "skip": True, "reason": "have"}
    if p.get("amap_attempted"):
        return {"pid": pid, "skip": True, "reason": "amap previously failed"}

    res = amap_search(p.get("name", ""), p.get("district", ""))
    if res == "QUOTA_OUT":
        return {"pid": pid, "ok": False, "reason": "quota", "quota_out": True}
    if not res:
        return {"pid": pid, "ok": False, "reason": "not in amap", "mark_attempted": True}

    save_path = os.path.join(PHOTOS_DIR, f"{pid}.jpg")
    if not download_photo(res["photo_url"], save_path):
        return {"pid": pid, "ok": False, "reason": "download fail", "mark_attempted": True}

    return {
        "pid": pid,
        "ok": True,
        "photo_url": f"data/photos/{pid}.jpg",
        "photo_attribution": "via 高德地图",
        "amap_id": res["amap_id"],
        "amap_name": res["name"],
    }


def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)

    # Process POIs without local photo (regardless of prior attempts; we explicitly
    # want a second-chance from Amap for those Google missed)
    todo = [p for p in pois.values() if not (p.get("photo_url") or "").startswith("data/photos/")]
    print(f"to try Amap: {len(todo)} POIs", flush=True)

    n_ok = n_fail = 0
    quota_hit = False
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for r in ex.map(process, todo):
            if quota_hit:
                break
            if r.get("skip"):
                continue
            pid = r["pid"]
            name = pois[pid]["name"][:24]
            if r.get("ok"):
                pois[pid]["photo_url"] = r["photo_url"]
                pois[pid]["photo_attribution"] = r["photo_attribution"]
                pois[pid]["amap_id"] = r["amap_id"]
                # clear failed flag since we now succeeded
                pois[pid].pop("photo_attempted", None)
                n_ok += 1
                print(f"  [{n_ok}] OK   {name:24} | matched: {r.get('amap_name', '')[:30]}", flush=True)
            else:
                n_fail += 1
                if r.get("quota_out"):
                    quota_hit = True
                    print(f"  !! quota exhausted, stopping", flush=True)
                else:
                    if r.get("mark_attempted"):
                        pois[pid]["amap_attempted"] = True
                    print(f"  -    fail {name:24} | {r.get('reason')}", flush=True)
            if (n_ok + n_fail) % 20 == 0:
                with open(POIS_PATH, "w", encoding="utf-8") as f:
                    json.dump(pois, f, ensure_ascii=False, indent=1)

    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)

    print(f"\n=== done === ok={n_ok}, fail={n_fail}, quota_hit={quota_hit}")
    if quota_hit:
        print("Hint: 高德个人免费 100 次/天，明天再跑一次 daily 会续上。")


if __name__ == "__main__":
    main()
