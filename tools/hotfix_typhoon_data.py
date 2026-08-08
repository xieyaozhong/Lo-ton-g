#!/usr/bin/env python3
"""Live calibration layer for the typhoon dashboard.

Primary live sources:
- CWA W-C0034-005 tropical cyclone track dataset, fetched into data/cwa-live.json.
- DGPA daily suspension-of-work/classes page.

The slower Open-Meteo county forecast remains in update_typhoon_data.py and is
re-scored here against the latest official CWA forecast track.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
import update_typhoon_data as base

OUT = Path("data/typhoon-dashboard.json")
CWA_RAW = Path("data/cwa-live.json")
DGPA_LIVE_URL = "https://www.dgpa.gov.tw/typh/daily/nds.html"
CWA_DATASET_URL = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Warning/W-C0034-005.json"

COUNTY_NAMES = [c["name"] for c in base.COUNTIES]
COUNTY_BY_NAME = {c["name"]: c for c in base.COUNTIES}
ALIASES = {"台北市":"臺北市","台中市":"臺中市","台南市":"臺南市","台東縣":"臺東縣"}

DIR_ZH = {
    "N":"北", "NNE":"北北東", "NE":"東北", "ENE":"東北東",
    "E":"東", "ESE":"東南東", "SE":"東南", "SSE":"南南東",
    "S":"南", "SSW":"南南西", "SW":"西南", "WSW":"西南西",
    "W":"西", "WNW":"西北西", "NW":"西北", "NNW":"北北西",
}


def listify(value: Any) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def fnum(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def inum(value: Any) -> int | None:
    x = fnum(value)
    return int(round(x)) if x is not None else None


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


def zh_text(value: Any) -> str:
    """Extract zh-hant text from CWA multilingual fields."""
    for item in listify(value):
        if isinstance(item, dict):
            if str(item.get("@lang", "")).lower() in {"zh-hant", "zh-tw"}:
                return str(item.get("#text", "")).strip()
    for item in listify(value):
        if isinstance(item, dict) and item.get("#text"):
            return str(item["#text"]).strip()
        if isinstance(item, str):
            return item.strip()
    return ""


def radius_of(value: Any) -> float | None:
    if not isinstance(value, dict):
        return None
    return fnum(value.get("Radius"))


def cwa_intensity(max_wind_ms: float | None) -> str:
    if max_wind_ms is None:
        return "熱帶氣旋"
    if max_wind_ms >= 51.0:
        return "強烈颱風"
    if max_wind_ms >= 32.7:
        return "中度颱風"
    if max_wind_ms >= 17.2:
        return "輕度颱風"
    return "熱帶性低氣壓"


def track_point_from_analysis(fix: dict[str, Any]) -> dict[str, Any] | None:
    lat = fnum(fix.get("CoordinateLatitude"))
    lon = fnum(fix.get("CoordinateLongitude"))
    if lat is None or lon is None:
        return None
    return {
        "time": fix.get("DateTime"),
        "kind": "actual",
        "lat": lat,
        "lon": lon,
        "location": "",
        "pressure_hpa": inum(fix.get("Pressure")),
        "direction": DIR_ZH.get(str(fix.get("MovingDirection", "")), str(fix.get("MovingDirection", ""))),
        "speed_kmh": fnum(fix.get("MovingSpeed")),
        "max_wind_ms": fnum(fix.get("MaxWindSpeed")),
        "max_gust_ms": fnum(fix.get("MaxGustSpeed")),
        "forecast_radius_km": None,
    }


def track_point_from_forecast(fix: dict[str, Any]) -> dict[str, Any] | None:
    lat = fnum(fix.get("CoordinateLatitude"))
    lon = fnum(fix.get("CoordinateLongitude"))
    initial = parse_dt(fix.get("InitialTime"))
    hour = fnum(fix.get("ForecastHour"))
    if lat is None or lon is None or initial is None or hour is None:
        return None
    point_time = initial + timedelta(hours=hour)
    return {
        "time": iso(point_time),
        "kind": "forecast",
        "lat": lat,
        "lon": lon,
        "location": "",
        "pressure_hpa": inum(fix.get("Pressure")),
        "direction": DIR_ZH.get(str(fix.get("MovingDirection", "")), str(fix.get("MovingDirection", ""))),
        "speed_kmh": fnum(fix.get("MovingSpeed")),
        "max_wind_ms": fnum(fix.get("MaxWindSpeed")),
        "max_gust_ms": fnum(fix.get("MaxGustSpeed")),
        "forecast_radius_km": fnum(fix.get("Radius70PercentProbability")),
    }


def parse_cwa_typhoons() -> tuple[list[dict[str, Any]], str | None]:
    raw = json.loads(CWA_RAW.read_text(encoding="utf-8"))
    root = raw.get("cwaopendata", {})
    sent = root.get("Sent")
    dataset = root.get("Dataset", {})
    tropical = dataset.get("TropicalCyclones", {}).get("TropicalCyclone", [])
    now = base.now_taipei()

    systems: list[dict[str, Any]] = []
    for tc in listify(tropical):
        if not isinstance(tc, dict):
            continue

        analyses = [x for x in listify(tc.get("AnalysisData", {}).get("Fix")) if isinstance(x, dict)]
        analyses.sort(key=lambda x: x.get("DateTime", ""))
        if not analyses:
            continue

        latest = analyses[-1]
        latest_dt = parse_dt(latest.get("DateTime"))
        if latest_dt is None:
            continue
        if now - latest_dt.astimezone(base.TZ_TAIPEI) > timedelta(hours=24):
            continue

        recent_start = latest_dt - timedelta(hours=24)
        actual_track = []
        for fix in analyses:
            dt = parse_dt(fix.get("DateTime"))
            if dt and dt >= recent_start:
                p = track_point_from_analysis(fix)
                if p:
                    actual_track.append(p)

        forecasts = [x for x in listify(tc.get("ForecastData", {}).get("Fix")) if isinstance(x, dict)]
        forecast_track = []
        for fix in forecasts:
            p = track_point_from_forecast(fix)
            if p:
                forecast_track.append(p)
        forecast_track.sort(key=lambda p: p["time"] or "")

        current = track_point_from_analysis(latest)
        if not current:
            continue

        maxwind = current.get("max_wind_ms")
        intensity = cwa_intensity(maxwind)
        number = str(tc.get("CwaTyNo") or tc.get("CwaTdNo") or "").strip()
        zh_name = str(tc.get("CwaTyphoonName") or "").strip()
        en_name = str(tc.get("TyphoonName") or "").strip()
        current["moving_prediction"] = zh_text(latest.get("MovingPrediction"))
        current["radius15_km"] = radius_of(latest.get("Circle15ms"))
        current["radius25_km"] = radius_of(latest.get("Circle25ms"))

        systems.append({
            "event_id": f"CWA-{tc.get('Year','')}-{number or tc.get('CwaTdNo','')}",
            "number": number,
            "name": zh_name or en_name or "熱帶氣旋",
            "name_en": en_name,
            "remark": "",
            "class": intensity,
            "intensity": intensity,
            "area_class": "",
            "report_time": latest.get("DateTime"),
            "current": current,
            "track": actual_track + forecast_track,
            "source_url": CWA_DATASET_URL,
        })

    systems.sort(key=lambda x: x.get("report_time") or "", reverse=True)
    return systems, sent


def normalize_county(raw: str) -> str:
    s = re.sub(r"\s+", "", raw)
    s = ALIASES.get(s, s)
    for name in COUNTY_NAMES:
        if s.startswith(name) or s.startswith(name.replace("臺", "台")):
            return name
    return s


def clean_status(value: str) -> str:
    s = re.sub(r"\s+", " ", value).strip()
    for name in COUNTY_NAMES:
        for variant in {name, name.replace("臺", "台")}:
            idx = s.find(variant)
            if idx > 0:
                s = s[:idx].strip()
    return s[:900]


def fetch_dgpa_resilient() -> dict[str, Any]:
    r = base.get(DGPA_LIVE_URL, params={"_": int(datetime.now().timestamp())})
    soup = BeautifulSoup(r.text, "html.parser")
    plain = soup.get_text("\n", strip=True)
    m = re.search(
        r"更新時間[:：]\s*([0-9]{4}/[0-9]{2}/[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})",
        plain,
    )
    updated = m.group(1) if m else ""
    rows: dict[str, str] = {}

    for tr in soup.find_all("tr"):
        cells = [
            re.sub(r"\s+", " ", x.get_text(" ", strip=True)).strip()
            for x in tr.find_all(["th", "td"])
        ]
        if len(cells) < 2:
            continue
        county = normalize_county(cells[0])
        if county in COUNTY_NAMES:
            rows[county] = clean_status(" ".join(cells[1:]))

    if not rows:
        compact = re.sub(r"[\t\r]+", " ", plain)
        positions = []
        for name in COUNTY_NAMES:
            found = None
            for variant in (name, name.replace("臺", "台")):
                pos = compact.find(variant)
                if pos >= 0 and (found is None or pos < found[0]):
                    found = (pos, variant)
            if found:
                positions.append((found[0], name, len(found[1])))
        positions.sort()

        for i, (pos, name, nlen) in enumerate(positions):
            end = positions[i + 1][0] if i + 1 < len(positions) else min(len(compact), pos + 1200)
            block = clean_status(compact[pos + nlen:end].strip(" |\n：:"))
            if any(k in block for k in (
                "停止上班", "停止上課", "未達停止", "照常上班", "照常上課", "尚未宣布"
            )):
                rows[name] = block

    return {
        "fetch_ok": True,
        "updated_text": updated,
        "no_notice": "無停班停課訊息" in plain,
        "rows": [{"county": name, "status": rows.get(name, "")} for name in COUNTY_NAMES],
    }


def full_county_closed(status: str) -> bool:
    s = re.sub(r"\s+", "", status)
    if not s:
        return False
    if "未達停止上班" in s or "照常上班" in s:
        return False
    if "部分地區" in s or "部分學校" in s:
        return False
    return (
        "停止上班及上課" in s
        or "停止上班、停止上課" in s
        or ("停止上班" in s and "停止上課" in s)
    )


def distance_for_target(county: dict[str, Any], typhoons: list[dict[str, Any]], target_date: str) -> float | None:
    distances: list[float] = []
    for ty in typhoons:
        for p in ty.get("track", []):
            if p.get("kind") != "forecast":
                continue
            ts = p.get("time") or ""
            if not ts.startswith(target_date):
                continue
            lat, lon = p.get("lat"), p.get("lon")
            if lat is None or lon is None:
                continue
            distances.append(base.haversine_km(county["lat"], county["lon"], float(lat), float(lon)))
    return min(distances) if distances else None


def rescore_predictions(payload: dict[str, Any], typhoons: list[dict[str, Any]], dgpa: dict[str, Any]) -> None:
    target_date = payload.get("target_date") or (base.now_taipei().date() + timedelta(days=1)).isoformat()
    status_map = {x["county"]: x.get("status", "") for x in dgpa.get("rows", [])}

    for p in payload.get("predictions", []):
        name = p.get("county")
        county = COUNTY_BY_NAME.get(name)
        if not county:
            continue

        wx = p.get("weather") or {}
        distance = distance_for_target(county, typhoons, target_date)
        score, reasons = base.risk_score(county, wx, distance)
        status = status_map.get(name, "")
        p["official_status"] = status
        p["closest_track_km"] = round(distance, 1) if distance is not None else None

        if full_county_closed(status):
            p["score"] = 100
            p["level"] = "官方公告"
            p["predicted"] = True
            p["reasons"] = ["人事行政總處已公告全縣市停班及停課"] + reasons[:3]
        else:
            p["score"] = score
            p["level"] = base.risk_level(score)
            p["predicted"] = score >= 55
            p["reasons"] = reasons[:4]

    payload["predictions"].sort(key=lambda x: (-x.get("score", 0), x.get("county", "")))


def main() -> None:
    if not OUT.exists():
        raise SystemExit("Baseline dashboard JSON is missing; run update_typhoon_data.py once first.")
    if not CWA_RAW.exists():
        raise SystemExit("CWA live JSON is missing; run probe_cwa_live.py first.")

    payload = json.loads(OUT.read_text(encoding="utf-8"))
    health = payload.setdefault("health", {})
    generated = base.now_taipei()

    try:
        typhoons, cwa_sent = parse_cwa_typhoons()
        payload["typhoons"] = typhoons
        payload["jma_updated_at"] = cwa_sent
        payload["typhoon_updated_at"] = cwa_sent
        payload["typhoon_source"] = "中央氣象署 W-C0034-005"
        health["typhoon_error"] = None
        health["typhoon_count"] = len(typhoons)
        health["cwa_sent"] = cwa_sent
        health["typhoon_empty_verified"] = len(typhoons) == 0
    except Exception as exc:
        health["typhoon_error"] = f"CWA live parse: {exc}"
        typhoons = payload.get("typhoons", [])

    try:
        dgpa = fetch_dgpa_resilient()
        payload["official_closures"] = dgpa
        health["dgpa_error"] = None
    except Exception as exc:
        health["dgpa_error"] = f"DGPA live parse: {exc}"
        dgpa = payload.get("official_closures", {"rows": []})

    rescore_predictions(payload, typhoons, dgpa)

    payload.setdefault("sources", {})["cwa_live"] = CWA_DATASET_URL
    payload["sources"]["dgpa"] = DGPA_LIVE_URL
    payload["schema"] = max(int(payload.get("schema", 1)), 3)
    payload["generated_at"] = generated.isoformat(timespec="seconds")
    payload["freshness_policy"] = {
        "typhoon_and_closure_refresh_minutes": 5,
        "county_weather_refresh_minutes": 30,
        "page_poll_minutes": 5,
        "rule": "颱風與停班停課採官方即時資料；來源失敗時保留錯誤狀態，不把抓取失敗顯示成無颱風。",
    }

    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Live calibration wrote {OUT} at {payload['generated_at']}; "
        f"storms={len(payload.get('typhoons', []))}; "
        f"DGPA={payload.get('official_closures', {}).get('updated_text', '')}"
    )


if __name__ == "__main__":
    main()
