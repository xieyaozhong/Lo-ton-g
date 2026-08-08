#!/usr/bin/env python3
import json
from pathlib import Path
import requests

URL = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Warning/W-C0034-005.json"
r = requests.get(URL, timeout=20, headers={"User-Agent": "Lo-ton-g/2.0"})
r.raise_for_status()
data = r.json()
out = Path("data/cwa-live.json")
out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("CWA live data written", out, "bytes", out.stat().st_size)
