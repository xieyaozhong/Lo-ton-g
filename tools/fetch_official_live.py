#!/usr/bin/env python3
"""Fetch machine-readable official live feeds used by the dashboard."""
from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; Lo-ton-g Typhoon Dashboard/3.0; +https://xieyaozhong.github.io/Lo-ton-g/)"
}
TIMEOUT = 20
CWA_URL = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Warning/W-C0034-005.json"
NCDR_FEED = "https://alerts.ncdr.nat.gov.tw/RssAtomFeed.ashx?AlertType=33"


def get(url: str) -> requests.Response:
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    return r


def local(tag: str) -> str:
    return tag.split("}")[-1]


def first_text(root: ET.Element, name: str) -> str:
    for el in root.iter():
        if local(el.tag) == name and (el.text or "").strip():
            return (el.text or "").strip()
    return ""


def all_text(root: ET.Element, name: str) -> list[str]:
    vals = []
    for el in root.iter():
        if local(el.tag) == name and (el.text or "").strip():
            vals.append((el.text or "").strip())
    return vals


def parse_dt(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_cap(xml_text: str, source_url: str) -> dict[str, Any]:
    root = ET.fromstring(xml_text)
    return {
        "source_url": source_url,
        "identifier": first_text(root, "identifier"),
        "sender": first_text(root, "sender"),
        "sent": first_text(root, "sent"),
        "status": first_text(root, "status"),
        "msgType": first_text(root, "msgType"),
        "scope": first_text(root, "scope"),
        "headline": first_text(root, "headline"),
        "event": first_text(root, "event"),
        "description": first_text(root, "description"),
        "instruction": first_text(root, "instruction"),
        "effective": first_text(root, "effective"),
        "onset": first_text(root, "onset"),
        "expires": first_text(root, "expires"),
        "areaDesc": all_text(root, "areaDesc"),
        "parameters": [
            {
                "valueName": first_text(p, "valueName"),
                "value": first_text(p, "value"),
            }
            for p in root.iter()
            if local(p.tag) == "parameter"
        ],
    }


def fetch_ncdr() -> dict[str, Any]:
    r = get(NCDR_FEED)
    root = ET.fromstring(r.content)
    now = datetime.now(timezone.utc)
    entries = []

    for entry in [el for el in root.iter() if local(el.tag) == "entry"]:
        updated = first_text(entry, "updated") or first_text(entry, "published")
        dt = parse_dt(updated)
        if dt and now - dt.astimezone(timezone.utc) > timedelta(days=3):
            continue

        links = []
        for el in entry.iter():
            if local(el.tag) != "link":
                continue
            href = el.attrib.get("href")
            if href:
                links.append(urljoin(NCDR_FEED, href))

        item: dict[str, Any] = {
            "id": first_text(entry, "id"),
            "title": first_text(entry, "title"),
            "updated": updated,
            "summary": first_text(entry, "summary"),
            "content": first_text(entry, "content"),
            "links": links,
            "cap": None,
        }

        for href in links[:5]:
            try:
                rr = get(href)
                body = rr.text.lstrip()
                if body.startswith("<?xml") or body.startswith("<alert") or "<alert" in body[:500]:
                    item["cap"] = parse_cap(rr.text, href)
                    break
            except Exception:
                continue

        entries.append(item)
        if len(entries) >= 20:
            break

    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_url": NCDR_FEED,
        "entries": entries,
    }


def main() -> None:
    out = Path("data")
    out.mkdir(exist_ok=True)

    cwa = get(CWA_URL).json()
    (out / "cwa-live.json").write_text(
        json.dumps(cwa, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    ncdr = fetch_ncdr()
    (out / "ncdr-live.json").write_text(
        json.dumps(ncdr, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(
        "Fetched official live feeds:",
        "CWA bytes", (out / "cwa-live.json").stat().st_size,
        "NCDR entries", len(ncdr["entries"]),
    )


if __name__ == "__main__":
    main()
