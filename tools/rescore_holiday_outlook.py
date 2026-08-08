#!/usr/bin/env python3
"""Re-score the cached two-day closure outlook against the latest CWA track."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import update_typhoon_data as base

OUT = Path("data/typhoon-dashboard.json")
COUNTY_BY_NAME = {c["name"]: c for c in base.COUNTIES}


def likelihood_from_score(score: int) -> int:
    if score <= 0:
        return 2
    p = 100.0 / (1.0 + math.exp(-(float(score) - 52.0) / 10.5))
    return int(round(max(2.0, min(97.0, p))))


def distance_for_date(county: dict[str, Any], typhoons: list[dict[str, Any]], date_iso: str) -> float | None:
    distances: list[float] = []
    for ty in typhoons:
        for point in ty.get("track", []):
            if point.get("kind") != "forecast":
                continue
            ts = str(point.get("time") or "")
            if not ts.startswith(date_iso):
                continue
            lat, lon = point.get("lat"), point.get("lon")
            if lat is None or lon is None:
                continue
            distances.append(base.haversine_km(county["lat"], county["lon"], float(lat), float(lon)))
    return min(distances) if distances else None


def main() -> None:
    if not OUT.exists():
        return
    data = json.loads(OUT.read_text(encoding="utf-8"))
    outlook = data.get("holiday_outlook")
    if not isinstance(outlook, dict):
        return

    typhoons = data.get("typhoons", [])
    for day in outlook.get("days", []):
        date_iso = str(day.get("date") or "")
        for item in day.get("counties", []):
            county = COUNTY_BY_NAME.get(item.get("county"))
            if not county:
                continue
            wx = item.get("weather") or {}
            distance = distance_for_date(county, typhoons, date_iso)
            score, reasons = base.risk_score(county, wx, distance)
            item["risk_score"] = score
            item["closest_track_km"] = round(distance, 1) if distance is not None else None
            if item.get("official"):
                item["likelihood_pct"] = 100
                item["reasons"] = ["官方已公告該日停班或停課"] + reasons[:3]
            else:
                item["likelihood_pct"] = likelihood_from_score(score)
                item["reasons"] = reasons[:4]
        day["counties"].sort(key=lambda x: (-int(bool(x.get("official"))), -int(x.get("likelihood_pct", 0)), x.get("county", "")))

    outlook["rescored_at"] = base.now_taipei().isoformat(timespec="seconds")
    data["schema"] = max(int(data.get("schema", 1)), 5)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Re-scored two-day holiday outlook against latest CWA track")


if __name__ == "__main__":
    main()
