#!/usr/bin/env python3
"""
Fetch real venue photos for each POI via Google Places API.

Steps per POI:
  1. Find Place from Text (query: name + district + 北京) — returns place_id + first photo_reference
  2. Place Photo download — actual JPEG bytes saved to data/photos/{poi_id}.jpg
  3. Save photo_url (local relative path) + photo_attribution + place_id back into pois.json

API key is read from env var GOOGLE_MAPS_API_KEY at runtime — never persisted.

Idempotent: skips POIs with photo_url already pointing to a local file.

Estimated cost (185 POIs):
  Find Place w/ photos field: $0.024 × 185 ≈ $4.5
  Place Photo download:       $0.007 × 185 ≈ $1.3
  Total: ~$6
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")
if not KEY:
    print("FATAL: GOOGLE_MAPS_API_KEY env var required", file=sys.stderr)
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
POIS_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "pois.json"))
PHOTOS_DIR = os.path.normpath(os.path.join(HERE, "..", "data", "photos"))
os.makedirs(PHOTOS_DIR, exist_ok=True)

UA = "Mozilla/5.0 PawsPath-Photo-Fetcher/1.0"

# Beijing rough bbox to validate place location
def in_beijing(lat, lng):
    return 39.4 <= lat <= 41.1 and 115.4 <= lng <= 117.5


def find_place(name, district, retries=2):
    """Find Place from Text — returns dict with place_id, photo_reference, attribution, lat, lng."""
    q_variants = []
    if district:
        q_variants.append(f"{name} {district}区 北京")
        q_variants.append(f"{name} {district} 北京")
    q_variants.append(f"{name} 北京")
    q_variants.append(name)

    for q in q_variants:
        url = (
            "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?"
            + urllib.parse.urlencode({
                "input": q,
                "inputtype": "textquery",
                "fields": "place_id,name,geometry,photos",
                "language": "zh-CN",
                "key": KEY,
                "locationbias": "circle:50000@39.905,116.397",
            })
        )
        for i in range(retries + 1):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = json.loads(r.read().decode("utf-8"))
                break
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if i < retries:
                    time.sleep(2 * (i + 1))
                    continue
                return None

        status = data.get("status")
        if status != "OK":
            if status in ("ZERO_RESULTS", "NOT_FOUND"):
                continue  # try next query variant
            if status == "OVER_QUERY_LIMIT":
                time.sleep(2)
                continue
            print(f"  ! status={status}: {data.get('error_message','')}", file=sys.stderr)
            return None
        cs = data.get("candidates", [])
        if not cs:
            continue
        c = cs[0]
        geo = (c.get("geometry") or {}).get("location") or {}
        lat = geo.get("lat"); lng = geo.get("lng")
        if lat and lng and not in_beijing(lat, lng):
            # Wrong city — skip
            continue
        photos = c.get("photos") or []
        if not photos:
            # Found but no photo — try next variant in case different POI has photos
            continue
        attr = photos[0].get("html_attributions") or []
        # strip html tags from attribution
        attr_clean = []
        for a in attr:
            txt = re.sub(r"<[^>]+>", "", a).strip()
            if txt:
                attr_clean.append(txt)
        return {
            "place_id": c.get("place_id"),
            "photo_reference": photos[0].get("photo_reference"),
            "attribution": " · ".join(attr_clean),
            "lat": lat, "lng": lng,
            "matched_query": q,
        }
    return None


def download_photo(photo_ref, save_path, max_width=900):
    url = (
        "https://maps.googleapis.com/maps/api/place/photo?"
        + urllib.parse.urlencode({
            "maxwidth": max_width,
            "photo_reference": photo_ref,
            "key": KEY,
        })
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            ct = r.headers.get("Content-Type", "")
            if not ct.startswith("image/"):
                return False
            data = r.read()
            if len(data) < 5000:
                return False
            with open(save_path, "wb") as f:
                f.write(data)
            return True
    except Exception as e:
        print(f"  ! download error: {e}", file=sys.stderr)
        return False


def process(p):
    pid = p["id"]
    # Skip if already have a LOCAL photo
    if (p.get("photo_url") or "").startswith("data/photos/"):
        return {"pid": pid, "skip": True}
    res = find_place(p.get("name", ""), p.get("district", ""))
    if not res:
        return {"pid": pid, "ok": False, "reason": "not found / no photos"}
    save_path = os.path.join(PHOTOS_DIR, f"{pid}.jpg")
    if not download_photo(res["photo_reference"], save_path):
        return {"pid": pid, "ok": False, "reason": "download failed"}
    return {
        "pid": pid,
        "ok": True,
        "photo_url": f"data/photos/{pid}.jpg",
        "photo_attribution": res["attribution"],
        "google_place_id": res["place_id"],
        "google_lat": res["lat"],
        "google_lng": res["lng"],
        "matched_query": res["matched_query"],
    }


def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)

    todo = [p for p in pois.values() if not (p.get("photo_url") or "").startswith("data/photos/")]
    print(f"to fetch: {len(todo)} / total {len(pois)}", flush=True)

    n_ok = n_fail = 0
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        for r in ex.map(process, todo):
            if r.get("skip"):
                continue
            pid = r["pid"]
            name = pois[pid]["name"][:24]
            if r.get("ok"):
                pois[pid]["photo_url"] = r["photo_url"]
                pois[pid]["photo_attribution"] = r["photo_attribution"]
                pois[pid]["google_place_id"] = r["google_place_id"]
                # Optionally update lat/lng to Google's more accurate one
                # Comment out if you want to preserve original Photon coords
                # pois[pid]["lat"] = r["google_lat"]; pois[pid]["lng"] = r["google_lng"]
                n_ok += 1
                attr = (r.get("photo_attribution") or "")[:30]
                print(f"  [{n_ok}] OK   {name:24} | by {attr}", flush=True)
            else:
                n_fail += 1
                print(f"  -    fail {name:24} | {r.get('reason')}", flush=True)
            # checkpoint every 25
            if (n_ok + n_fail) % 25 == 0:
                with open(POIS_PATH, "w", encoding="utf-8") as f:
                    json.dump(pois, f, ensure_ascii=False, indent=1)

    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)

    print(f"\n=== done === ok={n_ok}, fail={n_fail}")
    print(f"photos saved to: {PHOTOS_DIR}")


if __name__ == "__main__":
    main()
