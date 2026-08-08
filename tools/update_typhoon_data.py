#!/usr/bin/env python3
"""Build data/typhoon-dashboard.json for the static GitHub Pages dashboard.

Sources:
- JMA disaster-prevention XML feed: live tropical cyclone analysis / 5-day forecast.
- Taiwan DGPA: official suspension of work/classes announcements.
- Open-Meteo: county-level wind/rain forecast used only for a clearly-labeled estimate.
"""

from __future__ import annotations

import json
import math
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

TZ_TAIPEI = timezone(timedelta(hours=8))
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; Lo-ton-g Typhoon Dashboard/1.0; +https://xieyaozhong.github.io/Lo-ton-g/)"
}
TIMEOUT = 20

JMA_FEED = "https://www.data.jma.go.jp/developer/xml/feed/extra.xml"
DGPA_URL = "https://www.dgpa.gov.tw/typh/daily/nds.html?uid=31"
CWA_TYPHOON_URL = "https://www.cwa.gov.tw/V8/C/P/Typhoon/TY_WARN.html"
CWA_ROUTE_URL = "https://www.cwa.gov.tw/V8/C/P/Typhoon/PTA.html"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"

COUNTIES = [
    {"name": "基隆市", "lat": 25.1283, "lon": 121.7419, "rain": 200},
    {"name": "臺北市", "lat": 25.0375, "lon": 121.5637, "rain": 350},
    {"name": "新北市", "lat": 25.0120, "lon": 121.4657, "rain": 350},
    {"name": "桃園市", "lat": 24.9937, "lon": 121.3010, "rain": 350, "mountain_rain": 200},
    {"name": "新竹市", "lat": 24.8138, "lon": 120.9675, "rain": 350},
    {"name": "新竹縣", "lat": 24.8390, "lon": 121.0177, "rain": 350, "mountain_rain": 200},
    {"name": "苗栗縣", "lat": 24.5602, "lon": 120.8214, "rain": 350, "mountain_rain": 200},
    {"name": "臺中市", "lat": 24.1477, "lon": 120.6736, "rain": 350, "mountain_rain": 200},
    {"name": "彰化縣", "lat": 24.0756, "lon": 120.5440, "rain": 350},
    {"name": "南投縣", "lat": 23.9609, "lon": 120.9719, "rain": 350, "mountain_rain": 200},
    {"name": "雲林縣", "lat": 23.7092, "lon": 120.4313, "rain": 350, "mountain_rain": 200},
    {"name": "嘉義市", "lat": 23.4801, "lon": 120.4491, "rain": 350},
    {"name": "嘉義縣", "lat": 23.4518, "lon": 120.2555, "rain": 350, "mountain_rain": 200},
    {"name": "臺南市", "lat": 22.9997, "lon": 120.2270, "rain": 350},
    {"name": "高雄市", "lat": 22.6273, "lon": 120.3014, "rain": 350, "mountain_rain": 200},
    {"name": "屏東縣", "lat": 22.5519, "lon": 120.5488, "rain": 350},
    {"name": "宜蘭縣", "lat": 24.7021, "lon": 121.7378, "rain": 350},
    {"name": "花蓮縣", "lat": 23.9911, "lon": 121.6112, "rain": 350},
    {"name": "臺東縣", "lat": 22.7554, "lon": 121.1500, "rain": 350, "mountain_rain": 200},
    {"name": "澎湖縣", "lat": 23.5712, "lon": 119.5793, "rain": 350},
    {"name": "金門縣", "lat": 24.4368, "lon": 118.3186, "rain": 350},
    {"name": "連江縣", "lat": 26.1605, "lon": 119.9517, "rain": 200},
]

NAME_ALIASES = {"台北市": "臺北市", "台中市": "臺中市", "台南市": "臺南市", "台東縣": "臺東縣"}


def now_taipei() -> datetime:
    return datetime.now(TZ_TAIPEI)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


def get(url: str, **kwargs: Any) -> requests.Response:
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, **kwargs)
    r.raise_for_status()
    return r


def text_of(el: ET.Element | None) -> str:
    return (el.text or "").strip() if el is not None else ""


def find_first(root: ET.Element | None, local_name: str) -> ET.Element | None:
    if root is None:
        return None
    for el in root.iter():
        if el.tag.split("}")[-1] == local_name:
            return el
    return None


def find_all(root: ET.Element | None, local_name: str) -> list[ET.Element]:
    if root is None:
        return []
    return [el for el in root.iter() if el.tag.split("}")[-1] == local_name]


def parse_coord(value: str) -> tuple[float, float] | None:
    m = re.search(r"([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/?", value.strip())
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


def parse_jma_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).astimezone(TZ_TAIPEI)
    except ValueError:
        return None


def child_text_by_type(root: ET.Element | None, local_name: str, type_contains: str | None = None) -> str:
    for el in find_all(root, local_name):
        if type_contains is None or type_contains in el.attrib.get("type", ""):
            if text_of(el):
                return text_of(el)
    return ""


def parse_typhoon_xml(xml_text: str, source_url: str) -> dict[str, Any] | None:
    root = ET.fromstring(xml_text)
    event_id = text_of(find_first(root, "EventID"))
    report_time = parse_jma_datetime(text_of(find_first(root, "ReportDateTime")))
    infos = find_all(root, "MeteorologicalInfo")
    if not infos:
        return None

    actual = infos[0]
    name_part = find_first(actual, "TyphoonNamePart")
    name = text_of(find_first(name_part, "Name"))
    number = text_of(find_first(name_part, "Number"))
    remark = text_of(find_first(name_part, "Remark"))
    typhoon_class = child_text_by_type(actual, "TyphoonClass")
    intensity = child_text_by_type(actual, "IntensityClass")
    area_class = child_text_by_type(actual, "AreaClass")

    if any(k in remark for k in ("消滅", "温帯低気圧化", "熱帯低気圧化")):
        return None
    if "温帯低気圧" in typhoon_class:
        return None

    track: list[dict[str, Any]] = []
    for info in infos:
        dt_el = find_first(info, "DateTime")
        point_time = parse_jma_datetime(text_of(dt_el))
        point_type = dt_el.attrib.get("type", "") if dt_el is not None else ""
        coord = None
        coord_desc = ""
        for c in find_all(info, "Coordinate"):
            if "中心位置（度）" in c.attrib.get("type", ""):
                coord = parse_coord(text_of(c))
                coord_desc = c.attrib.get("description", "")
                if coord:
                    break
        if not coord:
            continue

        center = find_first(info, "CenterPart")
        pressure = None
        direction = ""
        speed_kmh = None
        location = ""
        if center is not None:
            location = text_of(find_first(center, "Location"))
            direction = child_text_by_type(center, "Direction", "移動方向")
            for s in find_all(center, "Speed"):
                if s.attrib.get("unit") == "km/h":
                    try:
                        speed_kmh = float(text_of(s))
                    except ValueError:
                        pass
            for p in find_all(center, "Pressure"):
                if "中心気圧" in p.attrib.get("type", ""):
                    try:
                        pressure = int(float(text_of(p)))
                    except ValueError:
                        pass

        radius_km = None
        for radius in find_all(info, "Radius"):
            if radius.attrib.get("unit") == "km" and "予報円" in radius.attrib.get("type", ""):
                try:
                    radius_km = float(text_of(radius))
                    break
                except ValueError:
                    pass

        max_wind_ms = None
        max_gust_ms = None
        for wind in find_all(info, "WindSpeed"):
            if wind.attrib.get("unit") != "m/s":
                continue
            try:
                value = float(text_of(wind))
            except ValueError:
                continue
            t = wind.attrib.get("type", "")
            if "最大瞬間風速" in t:
                max_gust_ms = value
            elif "最大風速" in t:
                max_wind_ms = value

        track.append({
            "time": iso(point_time), "kind": "actual" if "実況" in point_type else "forecast",
            "lat": coord[0], "lon": coord[1], "coord_description": coord_desc,
            "location": location, "pressure_hpa": pressure, "direction": direction,
            "speed_kmh": speed_kmh, "max_wind_ms": max_wind_ms, "max_gust_ms": max_gust_ms,
            "forecast_radius_km": radius_km,
        })

    if not track:
        return None
    current = next((p for p in track if p["kind"] == "actual"), track[0])
    return {
        "event_id": event_id,
        "number": number,
        "name": name or ("Tropical Depression" if "熱帯低気圧" in typhoon_class else "Tropical Cyclone"),
        "remark": remark, "class": typhoon_class, "intensity": intensity, "area_class": area_class,
        "report_time": iso(report_time), "current": current, "track": track, "source_url": source_url,
    }


def fetch_typhoons() -> tuple[list[dict[str, Any]], str | None]:
    root = ET.fromstring(get(JMA_FEED).text)
    entries = [el for el in root.iter() if el.tag.split("}")[-1] == "entry"]
    candidates: list[tuple[datetime, str]] = []
    now = datetime.now(timezone.utc)
    for entry in entries:
        title = text_of(find_first(entry, "title"))
        if "台風解析・予報情報（５日予報）" not in title:
            continue
        updated = text_of(find_first(entry, "updated"))
        try:
            updated_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
        except ValueError:
            continue
        if now - updated_dt > timedelta(days=3):
            continue
        href = ""
        for link in find_all(entry, "link"):
            if link.attrib.get("type") == "application/xml" and link.attrib.get("href"):
                href = link.attrib["href"]
                break
        if href:
            candidates.append((updated_dt, href))

    candidates.sort(reverse=True)
    systems: dict[str, dict[str, Any]] = {}
    newest: datetime | None = None
    for updated_dt, href in candidates[:24]:
        try:
            parsed = parse_typhoon_xml(get(href).text, href)
        except Exception as exc:
            print(f"JMA parse warning: {href}: {exc}")
            continue
        if not parsed:
            continue
        key = parsed.get("event_id") or href
        if key not in systems:
            systems[key] = parsed
            newest = max(newest, updated_dt) if newest else updated_dt
    return list(systems.values()), iso(newest.astimezone(TZ_TAIPEI)) if newest else None


def normalize_county(value: str) -> str:
    clean = re.sub(r"\s+", "", value)
    clean = NAME_ALIASES.get(clean, clean)
    for c in COUNTIES:
        if clean.startswith(c["name"]):
            return c["name"]
    return clean


def fetch_dgpa() -> dict[str, Any]:
    html = get(DGPA_URL).text
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text("\n", strip=True)
    update_match = re.search(r"更新時間[:：]\s*([0-9/\- :]+)", text)
    update_text = update_match.group(1).strip() if update_match else ""
    valid_names = {c["name"] for c in COUNTIES}
    rows: dict[str, str] = {}
    for tr in soup.find_all("tr"):
        cells = [re.sub(r"\s+", " ", td.get_text(" ", strip=True)).strip() for td in tr.find_all(["th", "td"])]
        if len(cells) < 2:
            continue
        county = normalize_county(cells[0])
        if county in valid_names:
            rows[county] = cells[1]
    return {
        "fetch_ok": True,
        "updated_text": update_text,
        "no_notice": "無停班停課訊息" in text,
        "rows": rows,
        "source_url": DGPA_URL,
    }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def typhoon_distance_for_date(county: dict[str, Any], typhoons: list[dict[str, Any]], target_date: str) -> float | None:
    distances: list[float] = []
    for ty in typhoons:
        for p in ty.get("track", []):
            ts = p.get("time")
            if ts and ts.startswith(target_date):
                distances.append(haversine_km(county["lat"], county["lon"], p["lat"], p["lon"]))
    return min(distances) if distances else None


def fetch_open_meteo(county: dict[str, Any]) -> dict[str, Any]:
    params = {
        "latitude": county["lat"], "longitude": county["lon"],
        "daily": "precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max",
        "forecast_days": 3, "timezone": "Asia/Taipei",
    }
    daily = get(OPEN_METEO, params=params).json().get("daily", {})
    days: dict[str, Any] = {}
    for i, day in enumerate(daily.get("time", [])):
        def pick(key: str) -> float | None:
            values = daily.get(key, [])
            if i >= len(values) or values[i] is None:
                return None
            return float(values[i])
        days[day] = {
            "precip_mm": pick("precipitation_sum"),
            "wind_kmh": pick("wind_speed_10m_max"),
            "gust_kmh": pick("wind_gusts_10m_max"),
        }
    return days


def risk_score(county: dict[str, Any], wx: dict[str, Any], distance_km: float | None) -> tuple[int, list[str]]:
    precip = wx.get("precip_mm") or 0.0
    wind_ms = (wx.get("wind_kmh") or 0.0) / 3.6
    gust_ms = (wx.get("gust_kmh") or 0.0) / 3.6
    score = 0.0
    reasons: list[str] = []

    if gust_ms >= 24.5:
        score += 55; reasons.append("陣風接近／達10級門檻")
    elif gust_ms >= 20.8:
        score += 40; reasons.append("陣風達強風區間")
    elif gust_ms >= 17.2:
        score += 24; reasons.append("陣風明顯增強")

    if wind_ms >= 13.9:
        score += 45; reasons.append("平均風接近／達7級門檻")
    elif wind_ms >= 10.8:
        score += 24; reasons.append("平均風偏強")

    rain_threshold = float(county["rain"])
    mountain_threshold = county.get("mountain_rain")
    if precip >= rain_threshold:
        score += 55; reasons.append(f"24h雨量接近／達{int(rain_threshold)}mm參考值")
    elif precip >= rain_threshold * 0.75:
        score += 35; reasons.append("24h雨量達雨量基準約75%")
    elif precip >= rain_threshold * 0.5:
        score += 16; reasons.append("24h雨量達雨量基準約50%")
    elif mountain_threshold and precip >= mountain_threshold * 0.75:
        score += 18; reasons.append("山區雨量風險需留意")

    if distance_km is not None:
        if distance_km <= 150:
            score += 25; reasons.append("預報中心路徑非常接近")
        elif distance_km <= 300:
            score += 18; reasons.append("預報中心路徑接近")
        elif distance_km <= 500:
            score += 10; reasons.append("可能受外圍環流影響")

    return int(round(max(0, min(100, score)))), reasons


def risk_level(score: int) -> str:
    if score >= 75:
        return "高"
    if score >= 55:
        return "中高"
    if score >= 30:
        return "觀察"
    return "低"


def official_is_closed(status: str) -> bool:
    normalized = status.replace(" ", "")
    return "停止上班" in normalized or "停止上課" in normalized


def build() -> dict[str, Any]:
    generated = now_taipei()
    target_date = (generated.date() + timedelta(days=1)).isoformat()
    typhoon_error = None
    dgpa_error = None
    weather_errors: list[str] = []

    try:
        typhoons, jma_updated = fetch_typhoons()
    except Exception as exc:
        typhoons, jma_updated = [], None
        typhoon_error = str(exc)

    try:
        dgpa = fetch_dgpa()
    except Exception as exc:
        dgpa = {"fetch_ok": False, "updated_text": "", "no_notice": False, "rows": {}, "source_url": DGPA_URL}
        dgpa_error = str(exc)

    predictions = []
    for county in COUNTIES:
        try:
            wx = fetch_open_meteo(county).get(target_date, {})
        except Exception as exc:
            weather_errors.append(f"{county['name']}: {exc}")
            wx = {}
        distance = typhoon_distance_for_date(county, typhoons, target_date)
        score, reasons = risk_score(county, wx, distance)
        status = dgpa.get("rows", {}).get(county["name"], "")
        if official_is_closed(status):
            score = 100
            reasons = ["人事行政總處已公告停班或停課"] + reasons
        predictions.append({
            "county": county["name"], "lat": county["lat"], "lon": county["lon"],
            "score": score, "level": risk_level(score), "predicted": score >= 55,
            "official_status": status, "weather": wx,
            "closest_track_km": round(distance, 1) if distance is not None else None,
            "rain_reference_mm": county["rain"],
            "mountain_rain_reference_mm": county.get("mountain_rain"),
            "reasons": reasons[:4],
        })

    predictions.sort(key=lambda x: (-x["score"], x["county"]))
    official_rows = [{"county": c["name"], "status": dgpa.get("rows", {}).get(c["name"], "")} for c in COUNTIES]
    return {
        "schema": 1,
        "generated_at": iso(generated),
        "target_date": target_date,
        "typhoons": typhoons,
        "jma_updated_at": jma_updated,
        "official_closures": {
            "fetch_ok": bool(dgpa.get("fetch_ok")),
            "updated_text": dgpa.get("updated_text", ""),
            "no_notice": bool(dgpa.get("no_notice")),
            "rows": official_rows,
        },
        "predictions": predictions,
        "sources": {
            "cwa_typhoon": CWA_TYPHOON_URL,
            "cwa_route": CWA_ROUTE_URL,
            "jma_xml": JMA_FEED,
            "dgpa": DGPA_URL,
            "open_meteo": "https://open-meteo.com/",
            "dgpa_rules": "https://www.dgpa.gov.tw/information?pid=12961&uid=84",
        },
        "health": {
            "typhoon_error": typhoon_error,
            "dgpa_error": dgpa_error,
            "weather_error_count": len(weather_errors),
            "weather_errors": weather_errors[:5],
        },
        "disclaimer": "官方停班停課以行政院人事行政總處及各地方政府公告為準；推估指數僅依公開風雨預報、法規參考門檻與颱風距離產生，不代表政府決策或統計機率。",
    }


def main() -> None:
    payload = build()
    out = Path(os.environ.get("OUTPUT_PATH", "data/typhoon-dashboard.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out} at {payload['generated_at']}")


if __name__ == "__main__":
    main()
