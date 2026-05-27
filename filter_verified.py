"""
Apply strict verification filter after check_freshness has run.

Keep only POIs whose freshness.status == 'open' (had recent network evidence
confirming the place is still open and pet-friendly).

Drop:
  - closed
  - policy_changed (no longer pet-friendly)
  - unclear (no recent evidence found — uncertain)
  - missing freshness (skipped or failed)

Effects:
  - data/pois.json: only verified POIs remain (others moved to data/_unverified_pois.json
    backup for transparency)
  - data/routes.json: poi_ids arrays pruned to verified POIs; poi_count updated
  - Routes with 0 verified POIs are tagged verified=False (UI can hide them)
"""
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def main():
    with open(os.path.join(DATA, "pois.json"), encoding="utf-8") as f:
        pois = json.load(f)
    with open(os.path.join(DATA, "routes.json"), encoding="utf-8") as f:
        routes = json.load(f)

    n_total = len(pois)
    by_status = {"open": 0, "closed": 0, "policy_changed": 0, "unclear": 0, "missing": 0}
    kept = {}
    dropped = {}
    for pid, p in pois.items():
        fr = p.get("freshness")
        if not fr:
            by_status["missing"] += 1
            dropped[pid] = {**p, "_drop_reason": "no_freshness_check"}
            continue
        status = fr.get("status", "unclear")
        by_status[status] = by_status.get(status, 0) + 1
        if status == "open":
            kept[pid] = p
        else:
            dropped[pid] = {**p, "_drop_reason": status}

    # update routes
    n_route_changes = 0
    for r in routes:
        orig_ids = r.get("poi_ids", []) or []
        new_ids = [pid for pid in orig_ids if pid in kept]
        if len(new_ids) != len(orig_ids):
            n_route_changes += 1
        r["poi_ids"] = new_ids
        r["poi_count"] = len(new_ids)
        r["verified"] = len(new_ids) >= 3   # arbitrary threshold: ≥3 verified POIs to consider "publishable"

    n_unverified_routes = sum(1 for r in routes if not r["verified"])

    # write outputs
    with open(os.path.join(DATA, "pois.json"), "w", encoding="utf-8") as f:
        json.dump(kept, f, ensure_ascii=False, indent=1)
    with open(os.path.join(DATA, "_unverified_pois.json"), "w", encoding="utf-8") as f:
        json.dump(dropped, f, ensure_ascii=False, indent=1)
    with open(os.path.join(DATA, "routes.json"), "w", encoding="utf-8") as f:
        json.dump(routes, f, ensure_ascii=False, indent=1)

    print("=== verification filter applied ===")
    print(f"POIs total: {n_total}")
    print(f"  by status: {by_status}")
    print(f"  kept (open): {len(kept)}")
    print(f"  dropped:     {len(dropped)} (backed up to data/_unverified_pois.json)")
    print(f"")
    print(f"Routes affected: {n_route_changes}/{len(routes)}")
    print(f"Routes now unverified (<3 confirmed POIs): {n_unverified_routes}")


if __name__ == "__main__":
    main()
