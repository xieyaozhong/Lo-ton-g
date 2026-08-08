#!/usr/bin/env python3
"""Build tomorrow + day-after-tomorrow closure likelihood outlook.

This is a heuristic model estimate, not a calibrated statistical probability.
Weather is refreshed on the slower forecast cadence; the latest CWA track is
re-applied every live refresh by rescore_holiday_outlook.py.
"""
from __future__ import annotations

import json
import math
import re
from datetime import timedelta
from pathlib import Path
from typing import Any

import update_typhoon_data as base

OUT = Path("data/typhoon-dashboard.json")


def likelihood_from_score(score: int) -> int:
    """Convert the internal risk index into an intuitive model-likelihood display."""
    if score <= 0:
        return 2
    p = 100.0 / (1.0 + math.exp(-(float(score) - 52.0) / 10.5))
    return int(round(max(2.0, min(97.0, p))))


def status_matches_date(status: str, date_iso: str) -> bool:
    if not status:
        return False
    try:
        _, month, day = date_iso.split("-")
        m = str(int(month)); d = str(int(day))
    except Exception:
        return False
    s = re.sub(r"\s+", "", status)
    return f"{m}/{d}" in s or f"{m}月{d}日" in s


def official_is_closed(status: str) -> bool:
    s = re.sub(r"\s+", "", status or "")
    if not s or "未達停止上班" in s or "照常上班" in s:
        return False
    return "停止上班" in s or "停止上課" in s or "已達停止上班" in s or "已達停止上課" in s


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


def confidence_for(day_offset: int, wx: dict[str, Any], distance: float | None) -> str:
    if not wx:
        return "低"
    if day_offset == 1 and distance is not None:
        return "較高"
    if day_offset == 1:
        return "中"
    return "中低" if distance is not None else "較低"


def build() -> None:
    if not OUT.exists():
        raise SystemExit("dashboard JSON missing")
    data = json.loads(OUT.read_text(encoding="utf-8"))
    today = base.now_taipei().date()
    dates = [(today + timedelta(days=1)).isoformat(), (today + timedelta(days=2)).isoformat()]
    typhoons = data.get("typhoons", [])
    status_map = {
        row.get("county"): row.get("status", "")
        for row in data.get("official_closures", {}).get("rows", [])
        if isinstance(row, dict)
    }

    weather_errors: list[str] = []
    weather_by_county: dict[str, dict[str, Any]] = {}
    for county in base.COUNTIES:
        try:
            weather_by_county[county["name"]] = base.fetch_open_meteo(county)
        except Exception as exc:
            weather_by_county[county["name"]] = {}
            weather_errors.append(f"{county['name']}: {exc}")

    days = []
    for day_offset, date_iso in enumerate(dates, start=1):
        counties = []
        for county in base.COUNTIES:
            wx = weather_by_county.get(county["name"], {}).get(date_iso, {})
            distance = distance_for_date(county, typhoons, date_iso)
            score, reasons = base.risk_score(county, wx, distance)
            status = status_map.get(county["name"], "")
            official = official_is_closed(status) and status_matches_date(status, date_iso)
            likelihood = 100 if official else likelihood_from_score(score)
            if official:
                reasons = ["官方已公告該日停班或停課"] + reasons
            counties.append({
                "county": county["name"],
                "date": date_iso,
                "day_offset": day_offset,
                "risk_score": score,
                "likelihood_pct": likelihood,
                "confidence": confidence_for(day_offset, wx, distance),
                "official": official,
                "official_status": status if official else "",
                "weather": wx,
                "closest_track_km": round(distance, 1) if distance is not None else None,
                "reasons": reasons[:4],
            })
        counties.sort(key=lambda x: (-int(x["official"]), -x["likelihood_pct"], x["county"]))
        days.append({"date": date_iso, "day_offset": day_offset, "counties": counties})

    data["holiday_outlook"] = {
        "model": "heuristic-v1",
        "updated_at": base.now_taipei().isoformat(timespec="seconds"),
        "days": days,
        "note": "模型估計可能性由公開風雨預報、停班停課參考門檻與官方颱風預測中心距離轉換而成，並非經歷史樣本校準的統計機率。",
    }
    health = data.setdefault("health", {})
    health["holiday_weather_error_count"] = len(weather_errors)
    health["holiday_weather_errors"] = weather_errors[:5]
    data["schema"] = max(int(data.get("schema", 1)), 5)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Updated two-day holiday outlook:", ", ".join(dates))


if __name__ == "__main__":
    build()
