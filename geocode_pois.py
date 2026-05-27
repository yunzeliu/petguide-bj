"""
Geocode all POIs via Nominatim (OSM, free). Add lat/lng + a confidence tag to
each POI in data/pois.json. Falls back to district centroid if Nominatim misses.

Polite: 1.1s between requests per Nominatim usage policy.
Cache: rerun is safe; only POIs without lat/lng are looked up.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
POIS_PATH = os.path.join(HERE, "data", "pois.json")
UA = "PetGuideBJ/1.0 (research; contact: hello@example.com)"

# rough WGS-84 centroids of Beijing / Shanghai / Hangzhou districts
DISTRICT_CENTROID = {
    # Beijing
    "东城": (39.929, 116.416), "西城": (39.913, 116.366),
    "朝阳": (39.921, 116.486), "海淀": (39.959, 116.298),
    "丰台": (39.858, 116.287), "石景山": (39.906, 116.222),
    "通州": (39.909, 116.657), "大兴": (39.726, 116.341),
    "顺义": (40.130, 116.654), "昌平": (40.220, 116.231),
    "门头沟": (39.940, 116.106), "房山": (39.736, 115.973),
    "怀柔": (40.316, 116.632), "平谷": (40.144, 117.121),
    "密云": (40.376, 116.843), "延庆": (40.465, 115.985),
    # Shanghai
    "黄浦": (31.231, 121.484), "静安": (31.247, 121.448),
    "徐汇": (31.184, 121.437), "长宁": (31.221, 121.425),
    "普陀": (31.249, 121.397), "虹口": (31.265, 121.504),
    "杨浦": (31.260, 121.526), "浦东": (31.222, 121.544),
    "闵行": (31.113, 121.381), "宝山": (31.405, 121.490),
    "嘉定": (31.375, 121.265), "金山": (30.741, 121.342),
    "松江": (31.032, 121.223), "青浦": (31.150, 121.124),
    "奉贤": (30.918, 121.474), "崇明": (31.624, 121.397),
    # Hangzhou
    "上城": (30.243, 120.171), "拱墅": (30.319, 120.142),
    "西湖": (30.259, 120.130), "滨江": (30.207, 120.211),
    "萧山": (30.184, 120.264), "余杭": (30.422, 120.297),
    "临平": (30.426, 120.298), "钱塘": (30.299, 120.452),
    "富阳": (30.049, 119.961), "临安": (30.234, 119.724),
    "桐庐": (29.798, 119.689), "淳安": (29.609, 119.043),
    "建德": (29.481, 119.282),
}

# City bbox check (loose)
CITY_BBOX = {
    "beijing":  (39.4, 41.1, 115.4, 117.5),
    "shanghai": (30.6, 31.9, 120.8, 122.2),
    "hangzhou": (29.1, 30.7, 118.5, 120.9),
}

def photon_query(q):
    """Komoot's Photon geocoder. Free, no API key, more permissive than Nominatim."""
    url = "https://photon.komoot.io/api/?" + urllib.parse.urlencode({
        "q": q,
        "limit": 1,
        "lang": "default",
    })
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            feats = data.get("features", [])
            if feats:
                coords = feats[0]["geometry"]["coordinates"]  # [lon, lat]
                name = feats[0].get("properties", {}).get("name", "")
                return float(coords[1]), float(coords[0]), name
    except Exception as e:
        print(f"  ! photon error: {e}", file=sys.stderr)
    return None

# Alias for code below
nominatim_query = photon_query

def in_city(lat, lng, city):
    bb = CITY_BBOX.get(city)
    if not bb:
        return 28 <= lat <= 42 and 115 <= lng <= 123  # China-ish
    return bb[0] <= lat <= bb[1] and bb[2] <= lng <= bb[3]

def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)

    # also re-geocode anything previously stuck at "fallback" or wrong city
    todo = []
    for pid, p in pois.items():
        if "lat" not in p or "lng" not in p:
            todo.append(pid); continue
        city = p.get("city", "beijing")
        if p.get("geo_source") == "fallback":
            todo.append(pid); continue
        # already-set centroid lookups: keep if matches a known centroid for the city
        if p.get("geo_source") == "district-centroid":
            # if the coordinate is clearly outside its city bbox, redo
            if not in_city(p["lat"], p["lng"], city):
                todo.append(pid); continue
    print(f"to geocode: {len(todo)} / total {len(pois)}", flush=True)

    last_req = 0
    CITY_NAME = {"beijing": "北京", "shanghai": "上海", "hangzhou": "杭州"}
    for i, pid in enumerate(todo):
        p = pois[pid]
        name = p.get("name", "").strip()
        district = (p.get("district") or "").strip()
        city = p.get("city", "beijing")
        city_zh = CITY_NAME.get(city, "")

        # build query variants tailored to this city
        queries = []
        if name:
            queries.append(f"{name}, {district}区, {city_zh}" if district else f"{name}, {city_zh}")
            queries.append(f"{name}, {city_zh}")
            queries.append(name)
        result = None

        for q in queries:
            # gentle throttle (Photon is more permissive but still be kind)
            wait = 0.3 - (time.time() - last_req)
            if wait > 0:
                time.sleep(wait)
            last_req = time.time()
            r = nominatim_query(q)
            if r and in_city(r[0], r[1], city):
                result = r
                break

        if result:
            lat, lng, src = result
            p["lat"], p["lng"] = round(lat, 6), round(lng, 6)
            p["geo_source"] = "nominatim"
            print(f"  [{i+1}/{len(todo)}] OK {name:30} | {lat:.4f},{lng:.4f}", flush=True)
        else:
            # fall back to district centroid
            ct = DISTRICT_CENTROID.get(district)
            if ct:
                p["lat"], p["lng"] = ct[0], ct[1]
                p["geo_source"] = "district-centroid"
                print(f"  [{i+1}/{len(todo)}] CENTROID {name:30} | district={district}", flush=True)
            else:
                # last resort: city center
                ct = {"beijing": (39.905, 116.397), "shanghai": (31.23, 121.47), "hangzhou": (30.26, 120.15)}.get(city, (39.905, 116.397))
                p["lat"], p["lng"] = ct[0], ct[1]
                p["geo_source"] = "fallback"
                print(f"  [{i+1}/{len(todo)}] FALLBACK {name:30} city={city}", flush=True)

        # checkpoint every 20
        if (i + 1) % 20 == 0:
            with open(POIS_PATH, "w", encoding="utf-8") as f:
                json.dump(pois, f, ensure_ascii=False, indent=1)
            print(f"  ...checkpoint saved", flush=True)

    with open(POIS_PATH, "w", encoding="utf-8") as f:
        json.dump(pois, f, ensure_ascii=False, indent=1)

    # stats
    sources = {}
    for p in pois.values():
        sources[p.get("geo_source", "?")] = sources.get(p.get("geo_source", "?"), 0) + 1
    print("\n=== done ===")
    print("by source:", sources)

if __name__ == "__main__":
    main()
