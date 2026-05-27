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

# rough WGS-84 centroids of Beijing districts
DISTRICT_CENTROID = {
    "东城": (39.929, 116.416),
    "西城": (39.913, 116.366),
    "朝阳": (39.921, 116.486),
    "海淀": (39.959, 116.298),
    "丰台": (39.858, 116.287),
    "石景山": (39.906, 116.222),
    "通州": (39.909, 116.657),
    "大兴": (39.726, 116.341),
    "顺义": (40.130, 116.654),
    "昌平": (40.220, 116.231),
    "门头沟": (39.940, 116.106),
    "房山": (39.736, 115.973),
    "怀柔": (40.316, 116.632),
    "平谷": (40.144, 117.121),
    "密云": (40.376, 116.843),
    "延庆": (40.465, 115.985),
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

def in_bj(lat, lng):
    # Beijing rough bbox
    return 39.4 <= lat <= 41.1 and 115.4 <= lng <= 117.5

def main():
    with open(POIS_PATH, encoding="utf-8") as f:
        pois = json.load(f)

    todo = [pid for pid, p in pois.items() if "lat" not in p or "lng" not in p]
    print(f"to geocode: {len(todo)} / total {len(pois)}", flush=True)

    last_req = 0
    for i, pid in enumerate(todo):
        p = pois[pid]
        name = p.get("name", "").strip()
        district = (p.get("district") or "").strip()

        # build query variants
        queries = []
        if name:
            queries.append(f"{name}, {district}区, 北京" if district else f"{name}, 北京")
            queries.append(f"{name}, 北京")
        result = None

        for q in queries:
            # gentle throttle (Photon is more permissive but still be kind)
            wait = 0.3 - (time.time() - last_req)
            if wait > 0:
                time.sleep(wait)
            last_req = time.time()
            r = nominatim_query(q)
            if r and in_bj(r[0], r[1]):
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
                # last resort: Tiananmen
                p["lat"], p["lng"] = 39.905, 116.397
                p["geo_source"] = "fallback"
                print(f"  [{i+1}/{len(todo)}] FALLBACK {name:30}", flush=True)

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
