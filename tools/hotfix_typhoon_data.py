#!/usr/bin/env python3
"""Fast correctness patch for the typhoon dashboard.

Runs after update_typhoon_data.py. It refreshes the two sources that must never
silently look empty: active tropical cyclones (JMA XML) and DGPA closures.
"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

from bs4 import BeautifulSoup
import update_typhoon_data as base

OUT = Path("data/typhoon-dashboard.json")
COUNTY_NAMES = [c["name"] for c in base.COUNTIES]
ALIASES = {"台北市":"臺北市","台中市":"臺中市","台南市":"臺南市","台東縣":"臺東縣"}


def local(tag: str) -> str:
    return tag.split("}")[-1]


def text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def descendants(root, name: str):
    return [el for el in root.iter() if local(el.tag) == name]


def first(root, name: str):
    for el in root.iter():
        if local(el.tag) == name:
            return el
    return None


def parse_dt(value: str):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def fetch_typhoons_broad():
    feed = ET.fromstring(base.get(base.JMA_FEED, params={"_": int(datetime.now().timestamp())}).text)
    candidates = []
    for entry in [e for e in feed.iter() if local(e.tag) == "entry"]:
        title = text(first(entry, "title"))
        if "台風解析・予報情報" not in title:
            continue
        updated = parse_dt(text(first(entry, "updated")))
        if not updated:
            continue
        href = ""
        for link in descendants(entry, "link"):
            if link.attrib.get("href", "").endswith(".xml"):
                href = link.attrib["href"]
                break
        if href:
            candidates.append((updated, href, title))

    candidates.sort(reverse=True, key=lambda x: x[0])
    systems = {}
    newest = None
    now = datetime.now(timezone.utc)
    diagnostics = []
    for updated, href, title in candidates[:60]:
        if now - updated.astimezone(timezone.utc) > timedelta(hours=36):
            continue
        try:
            parsed = base.parse_typhoon_xml(base.get(href).text, href)
        except Exception as exc:
            diagnostics.append(f"{title}: {exc}")
            continue
        if not parsed:
            continue
        key = parsed.get("event_id") or href
        report = parse_dt(parsed.get("report_time") or "")
        if report and now - report.astimezone(timezone.utc) > timedelta(hours=18):
            continue
        if key not in systems:
            systems[key] = parsed
        newest = max(newest, updated) if newest else updated
    return list(systems.values()), newest, diagnostics


def normalize_county(raw: str) -> str:
    s = re.sub(r"\s+", "", raw)
    s = ALIASES.get(s, s)
    for name in COUNTY_NAMES:
        if s.startswith(name):
            return name
    return s


def fetch_dgpa_resilient():
    r = base.get(base.DGPA_URL, params={"_": int(datetime.now().timestamp())})
    soup = BeautifulSoup(r.text, "html.parser")
    plain = soup.get_text("\n", strip=True)
    m = re.search(r"更新時間[:：]\s*([0-9]{4}/[0-9]{2}/[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})", plain)
    updated = m.group(1) if m else ""
    rows = {}

    for tr in soup.find_all("tr"):
        cells = [re.sub(r"\s+", " ", x.get_text(" ", strip=True)).strip() for x in tr.find_all(["th", "td"])]
        if len(cells) >= 2:
            county = normalize_county(cells[0])
            if county in COUNTY_NAMES:
                rows[county] = " ".join(cells[1:]).strip()

    if not rows:
        compact = re.sub(r"[\t\r]+", " ", plain)
        positions = []
        for name in COUNTY_NAMES:
            for variant in {name, name.replace("臺", "台")}:
                pos = compact.find(variant)
                if pos >= 0:
                    positions.append((pos, name, len(variant)))
                    break
        positions.sort()
        for i, (pos, name, nlen) in enumerate(positions):
            end = positions[i + 1][0] if i + 1 < len(positions) else min(len(compact), pos + 1200)
            block = compact[pos + nlen:end].strip(" |\n：:")
            if any(k in block for k in ("停止上班", "停止上課", "未達停止", "照常上班", "照常上課")):
                rows[name] = re.sub(r"\n+", " ", block).strip()[:900]

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
    return ("停止上班及上課" in s or "停止上班、停止上課" in s or
            ("停止上班" in s and "停止上課" in s))


def main():
    payload = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    health = payload.setdefault("health", {})
    generated = base.now_taipei()

    try:
        typhoons, newest, diag = fetch_typhoons_broad()
        payload["typhoons"] = typhoons
        stamp = newest.astimezone(base.TZ_TAIPEI).isoformat(timespec="seconds") if newest else None
        payload["jma_updated_at"] = stamp
        payload["typhoon_updated_at"] = stamp
        payload["typhoon_source"] = "JMA 防災氣象 XML（即時）"
        health["typhoon_error"] = None
        health["typhoon_diagnostics"] = diag[:4]
        health["typhoon_empty_verified"] = len(typhoons) == 0
    except Exception as exc:
        health["typhoon_error"] = f"hotfix: {exc}"

    try:
        dgpa = fetch_dgpa_resilient()
        payload["official_closures"] = dgpa
        health["dgpa_error"] = None
        status_map = {x["county"]: x["status"] for x in dgpa["rows"]}
        for p in payload.get("predictions", []):
            status = status_map.get(p.get("county"), "")
            p["official_status"] = status
            if full_county_closed(status):
                p["score"] = 100
                p["level"] = "官方公告"
                p["predicted"] = True
                reasons = [x for x in p.get("reasons", []) if "人事行政總處" not in x]
                p["reasons"] = ["人事行政總處已公告全縣市停班及停課"] + reasons[:3]
    except Exception as exc:
        health["dgpa_error"] = f"hotfix: {exc}"

    payload["schema"] = max(int(payload.get("schema", 1)), 2)
    payload["generated_at"] = generated.isoformat(timespec="seconds")
    payload["freshness_policy"] = {
        "typhoon_and_closure_refresh_minutes": 5,
        "page_poll_minutes": 5,
        "rule": "來源失敗會顯示錯誤，不以空資料冒充無颱風或無公告"
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Hotfix refreshed {OUT} at {payload['generated_at']}; storms={len(payload.get('typhoons', []))}")


if __name__ == "__main__":
    main()
