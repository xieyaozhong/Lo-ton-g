#!/usr/bin/env python3
"""Merge official NCDR CAP stop-work/class notices into dashboard JSON."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

DASH = Path("data/typhoon-dashboard.json")
NCDR = Path("data/ncdr-live.json")
TZ_TAIPEI = timezone(timedelta(hours=8))

COUNTIES = [
    "基隆市","臺北市","新北市","桃園市","新竹市","新竹縣","苗栗縣","臺中市",
    "彰化縣","南投縣","雲林縣","嘉義市","嘉義縣","臺南市","高雄市","屏東縣",
    "宜蘭縣","花蓮縣","臺東縣","澎湖縣","金門縣","連江縣",
]
ALIASES = {"台北市":"臺北市","台中市":"臺中市","台南市":"臺南市","台東縣":"臺東縣"}


def parse_dt(v: str):
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except Exception:
        return None


def norm_county(v: str) -> str:
    s = re.sub(r"\s+", "", v or "")
    return ALIASES.get(s, s)


def full_county_closed(status: str) -> bool:
    s = re.sub(r"\s+", "", status or "")
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


def main():
    if not DASH.exists() or not NCDR.exists():
        return

    dashboard = json.loads(DASH.read_text(encoding="utf-8"))
    ncdr = json.loads(NCDR.read_text(encoding="utf-8"))
    latest: datetime | None = None
    cap_rows: dict[str, str] = {}

    for entry in ncdr.get("entries", []):
        if not isinstance(entry, dict):
            continue
        cap = entry.get("cap") if isinstance(entry.get("cap"), dict) else {}
        message = str(cap.get("description") or entry.get("summary") or entry.get("content") or "").strip()
        areas = cap.get("areaDesc") or []
        if isinstance(areas, str):
            areas = [areas]
        stamp = str(cap.get("sent") or entry.get("updated") or "")
        dt = parse_dt(stamp)
        if dt and (latest is None or dt > latest):
            latest = dt

        haystack = " ".join([str(x) for x in areas] + [message])
        for county in COUNTIES:
            variants = (county, county.replace("臺", "台"))
            if any(v in haystack for v in variants) and any(
                k in message for k in ("停止上班","停止上課","已達停止上班","已達停止上課","未達停止","照常上班","照常上課")
            ):
                cap_rows[county] = re.sub(r"\s+", " ", message)[:900]

    official = dashboard.setdefault("official_closures", {})
    existing = {}
    for row in official.get("rows", []):
        if isinstance(row, dict) and row.get("county"):
            existing[norm_county(str(row["county"]))] = str(row.get("status") or "")
    for county, status in cap_rows.items():
        existing[county] = status

    official["rows"] = [{"county": c, "status": existing.get(c, "")} for c in COUNTIES]
    official["fetch_ok"] = bool(official.get("fetch_ok")) or bool(ncdr.get("fetch_ok"))
    if cap_rows:
        official["no_notice"] = False
    if latest:
        official["updated_text"] = latest.astimezone(TZ_TAIPEI).strftime("%Y/%m/%d %H:%M:%S")
    official["machine_source"] = "DGPA HTML + NCDR CAP"

    for p in dashboard.get("predictions", []):
        county = norm_county(str(p.get("county") or ""))
        status = existing.get(county, "")
        p["official_status"] = status
        if full_county_closed(status):
            p["score"] = 100
            p["level"] = "官方公告"
            p["predicted"] = True
            reasons = [r for r in (p.get("reasons") or []) if "人事行政總處" not in str(r)]
            p["reasons"] = ["人事行政總處／NCDR 已公告全縣市停班及停課"] + reasons[:3]

    health = dashboard.setdefault("health", {})
    health["ncdr_error"] = ncdr.get("error")
    health["ncdr_entry_count"] = len(ncdr.get("entries", []))
    health["closure_machine_source"] = "NCDR CAP"
    dashboard.setdefault("sources", {})["ncdr_closures"] = ncdr.get("source_url")
    dashboard["schema"] = max(int(dashboard.get("schema", 1)), 4)
    dashboard["generated_at"] = datetime.now(TZ_TAIPEI).isoformat(timespec="seconds")

    DASH.write_text(json.dumps(dashboard, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Merged NCDR closures:", ", ".join(cap_rows) if cap_rows else "none")


if __name__ == "__main__":
    main()
