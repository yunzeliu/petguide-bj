"""
Build static data files for the web app from miniprogram-petguide/data*/.

Supports multi-city: every directory under miniprogram-petguide/ matching
data-<city>/ is treated as a city. Plain `data/` is "beijing".

Outputs:
    web/data/routes.json        # ALL cities combined, with city tag
    web/data/pois.json          # { id: poi }, city-prefixed ids
    web/data/cities.json        # [{key, name, count}, ...]
    web/data/routes/{city}-{slug}.md
"""
import json
import os
import shutil

CITY_DIRS = {
    # source dir under miniprogram-petguide/ → city key + display name
    "data": ("beijing", "北京"),
    "data-shanghai": ("shanghai", "上海"),
    "data-hangzhou": ("hangzhou", "杭州"),
}
OUT = "data"

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.normpath(os.path.join(here, "..", "miniprogram-petguide"))
    out       = os.path.join(here, OUT)
    out_md    = os.path.join(out, "routes")
    os.makedirs(out_md, exist_ok=True)

    routes_meta = []
    pois = {}
    cities_summary = []
    preserve_geo = {}  # pid -> {lat, lng, geo_source, freshness} from existing pois.json
    if os.path.isfile(os.path.join(out, "pois.json")):
        try:
            with open(os.path.join(out, "pois.json"), encoding="utf-8") as f:
                old = json.load(f)
            for pid, op in old.items():
                keep = {}
                if "lat" in op and "lng" in op:
                    keep["lat"] = op["lat"]; keep["lng"] = op["lng"]
                    keep["geo_source"] = op.get("geo_source", "")
                if "freshness" in op:
                    keep["freshness"] = op["freshness"]
                if keep:
                    preserve_geo[pid] = keep
        except Exception:
            pass

    order = 0

    for data_dir, (city_key, city_name) in CITY_DIRS.items():
        src_routes = os.path.join(repo_root, data_dir, "routes")
        if not os.path.isdir(src_routes):
            continue

        city_route_count = 0
        for name in sorted(os.listdir(src_routes)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(src_routes, name), encoding="utf-8") as f:
                d = json.load(f)
            local_slug = d.get("slug") or name[:-5]
            # namespace slug per-city, except beijing keeps short form for back-compat
            full_slug = local_slug if city_key == "beijing" else f"{city_key}-{local_slug}"
            order += 1
            city_route_count += 1

            # copy md
            md_src = os.path.join(src_routes, local_slug + ".md")
            if os.path.isfile(md_src):
                shutil.copy(md_src, os.path.join(out_md, full_slug + ".md"))

            # poi ids: also need namespacing
            new_poi_ids = []
            for p in d.get("pois", []):
                old_id = p.get("id")
                if not old_id:
                    continue
                new_id = old_id if city_key == "beijing" else f"{city_key[0]}{old_id[1:]}"  # 'p_xxx' -> 's_xxx' for shanghai etc.
                # actually just prefix to keep it simple
                if city_key != "beijing":
                    new_id = f"{city_key[:1]}_{old_id.split('_',1)[1]}"
                new_poi_ids.append(new_id)
                if new_id not in pois:
                    pois[new_id] = {
                        "id": new_id,
                        "name": p.get("name", ""),
                        "category": p.get("category", ""),
                        "city": city_key,
                        "city_name": city_name,
                        "district": p.get("district", ""),
                        "address_hint": p.get("address_hint", ""),
                        "why_friendly": p.get("why_friendly", ""),
                        "tips": p.get("tips", ""),
                        "price_hint": p.get("price_hint", ""),
                        "sources": [],
                        "route_slugs": [],
                    }
                    # preserve cached geocode if same id existed
                    if new_id in preserve_geo:
                        pois[new_id].update(preserve_geo[new_id])
                if p.get("source_url"):
                    pois[new_id]["sources"].append({
                        "url": p["source_url"],
                        "name": p.get("source_name", ""),
                    })
                pois[new_id]["route_slugs"].append(full_slug)

            routes_meta.append({
                "id": full_slug,
                "title": d.get("title", ""),
                "summary": d.get("summary", ""),
                "duration_hours": d.get("duration_hours"),
                "best_seasons": d.get("best_seasons", []),
                "transport": d.get("transport", ""),
                "fit_dog_size": d.get("fit_dog_size", []),
                "districts": d.get("districts", []),
                "tags": list({*(d.get("tags", []) or []), *(d.get("topic_tags", []) or [])}),
                "category": d.get("topic_category", ""),
                "dim": d.get("topic_dim", ""),
                "city": city_key,
                "city_name": city_name,
                "poi_ids": new_poi_ids,
                "poi_count": len(new_poi_ids),
                "checklist": d.get("checklist", []),
                "warnings": d.get("warnings", []),
                "order": order,
            })

        cities_summary.append({"key": city_key, "name": city_name, "count": city_route_count})

    # dedupe poi sources and route_slugs
    for p in pois.values():
        seen, uniq = set(), []
        for s in p["sources"]:
            if s["url"] in seen:
                continue
            seen.add(s["url"])
            uniq.append(s)
        p["sources"] = uniq
        p["route_slugs"] = sorted(set(p["route_slugs"]))

    # backfill city on beijing pois (which didn't get tagged)
    for p in pois.values():
        if not p.get("city"):
            p["city"] = "beijing"
            p["city_name"] = "北京"

    with open(os.path.join(out, "routes.json"), "w", encoding="utf-8") as f:
        json.dump(routes_meta, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out, "pois.json"), "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out, "cities.json"), "w", encoding="utf-8") as f:
        json.dump(cities_summary, f, ensure_ascii=False, indent=1)

    print(f"routes: {len(routes_meta)} -> data/routes.json")
    print(f"pois:   {len(pois)} -> data/pois.json")
    print(f"cities: {len(cities_summary)} -> data/cities.json")
    for c in cities_summary:
        print(f"  - {c['name']}: {c['count']} routes")

if __name__ == "__main__":
    main()
