#!/usr/bin/env python3
"""
Detect and merge duplicate POIs based on normalized name.
Same venue, different ID due to variations in punctuation, spacing, district suffix, case.

Merge strategy: keep the "best" record (most photos / freshness / sources / fields),
move all routes' poi_ids to point at the survivor, delete the dups, move photo files.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
POIS_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "pois.json"))
ROUTES_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "routes.json"))
UNVER_PATH = os.path.normpath(os.path.join(HERE, "..", "data", "_unverified_pois.json"))

NORM_PUNCT = re.compile(r"[\s\(\)（）·.,\-—\[\]【】《》\"'　、:：;；?？!！]+")


def normalize_name(s):
    if not s:
        return ""
    return NORM_PUNCT.sub("", s).lower()


def score(p):
    s = 0
    if (p.get("photo_url") or "").startswith("data/photos/"):
        s += 100
    if (p.get("freshness") or {}).get("status") == "open":
        s += 50
    s += len(p.get("sources") or []) * 5
    s += len(p.get("route_slugs") or []) * 3
    if p.get("pet_features"):
        s += 20
    if p.get("address_hint"):
        s += 5
    if p.get("why_friendly"):
        s += 3 if len(p["why_friendly"]) > 20 else 1
    return s


def merge_into(survivor, dup):
    s_urls = {x.get("url") for x in (survivor.get("sources") or [])}
    for x in (dup.get("sources") or []):
        if x.get("url") and x["url"] not in s_urls:
            survivor.setdefault("sources", []).append(x)
            s_urls.add(x["url"])
    survivor["route_slugs"] = sorted(set((survivor.get("route_slugs") or []) + (dup.get("route_slugs") or [])))
    for f in ("address_hint", "why_friendly", "tips", "price_hint", "photo_url",
              "photo_attribution", "google_place_id", "amap_id", "lat", "lng",
              "geo_source", "pet_features"):
        if not survivor.get(f) and dup.get(f):
            survivor[f] = dup[f]
    sf = survivor.get("freshness") or {}
    df = dup.get("freshness") or {}
    if df.get("checked_at") and (not sf.get("checked_at") or df["checked_at"] > sf["checked_at"]):
        survivor["freshness"] = df


def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)

    groups = {}
    for pid, p in pois.items():
        key = normalize_name(p.get("name", ""))
        if not key:
            continue
        groups.setdefault(key, []).append(pid)

    rename_map = {}
    to_delete = set()
    for key, ids in groups.items():
        if len(ids) <= 1:
            continue
        ids_sorted = sorted(ids, key=lambda i: -score(pois[i]))
        survivor_id = ids_sorted[0]
        for dup_id in ids_sorted[1:]:
            merge_into(pois[survivor_id], pois[dup_id])
            rename_map[dup_id] = survivor_id
            to_delete.add(dup_id)

    print(f"groups with dups: {sum(1 for ids in groups.values() if len(ids) > 1)}")
    print(f"to delete: {len(to_delete)} POIs")

    for pid in to_delete:
        old_photo = os.path.normpath(os.path.join(HERE, "..", f"data/photos/{pid}.jpg"))
        new_photo = os.path.normpath(os.path.join(HERE, "..", f"data/photos/{rename_map[pid]}.jpg"))
        if os.path.isfile(old_photo):
            if not os.path.isfile(new_photo):
                os.rename(old_photo, new_photo)
                pois[rename_map[pid]]["photo_url"] = f"data/photos/{rename_map[pid]}.jpg"
            else:
                os.remove(old_photo)
        del pois[pid]

    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)
    print(f"pois.json: {len(pois)} unique")

    if os.path.isfile(ROUTES_PATH):
        with open(ROUTES_PATH, encoding="utf-8") as f:
            routes = json.load(f)
        n_changed = 0
        for r in routes:
            orig = r.get("poi_ids") or []
            new = [rename_map.get(pid, pid) for pid in orig]
            new = list(dict.fromkeys(new))
            if new != orig:
                n_changed += 1
                r["poi_ids"] = new
                r["poi_count"] = len(new)
        with open(ROUTES_PATH, "w", encoding="utf-8") as f:
            json.dump(routes, f, ensure_ascii=False, indent=1)
        print(f"routes.json: updated {n_changed}")

    if os.path.isfile(UNVER_PATH):
        try:
            with open(UNVER_PATH, encoding="utf-8") as f:
                unver = json.load(f)
            unver = {k: v for k, v in unver.items() if k not in to_delete}
            with open(UNVER_PATH, "w", encoding="utf-8") as f:
                json.dump(unver, f, ensure_ascii=False, indent=1)
        except Exception:
            pass


if __name__ == "__main__":
    main()
