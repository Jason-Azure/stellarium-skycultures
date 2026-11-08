"""Local Chinese skyculture controller and a separate OBS program page."""
from __future__ import annotations

import argparse
import collections
import copy
import datetime as dt
import json
import math
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
SOURCE = json.loads((ROOT / "data" / "index.json").read_text(encoding="utf-8"))
REVISION = "2d80ce70984c14bba7da2d31a0f9b27e292861c9"
SOURCE_URL = f"https://github.com/Stellarium/stellarium-skycultures/tree/{REVISION}/chinese"
CDN = "https://stellarium.sfo2.cdn.digitaloceanspaces.com/"
VENDOR_CACHE = collections.OrderedDict()
VENDOR_LOCK = threading.Lock()
VENDOR_INFLIGHT = {}
VENDOR_LIMIT = 128 * 1024 * 1024
NAMES = {c["common_name"]["native"]: c for c in SOURCE["constellations"]}
MANSIONS = [name + "宿" for name in "角亢氐房心尾箕斗牛女虚危室壁奎娄胃昴毕觜参井鬼柳星张翼轸"]
GROUPS = {
    "all": ("中国星官", None, None, 120),
    "mansions": ("二十八宿", MANSIONS, None, 150),
    "ziwei": ("紫微垣", ["紫微左垣", "紫微右垣"], 11767, 95),
    "taiwei": ("太微垣", ["太微左垣", "太微右垣"], 57632, 60),
    "tianshi": ("天市垣", ["天市左垣", "天市右垣"], 84345, 65),
    "beidou": ("北斗", ["北斗"], 59774, 60),
    "dragon": ("东方苍龙", MANSIONS[:7], 80763, 110),
    "tortoise": ("北方玄武", MANSIONS[7:14], 102618, 110),
    "tiger": ("西方白虎", MANSIONS[14:21], 17702, 110),
    "bird": ("南方朱雀", MANSIONS[21:], 46390, 110),
}
# Labels are anchored to representative stars; no new enclosure edges are drawn.
REGION_LABELS = {"ziwei": ("紫微垣", 72607), "taiwei": ("太微垣", 57632), "tianshi": ("天市垣", 84345)}
for _, names, _, _ in GROUPS.values():
    if names:
        assert all(name in NAMES for name in names), names

STATE_LOCK = threading.Lock()
STATE = {
    "version": 1,
    "location": {"name": "洛阳", "lat": 34.62, "lng": 112.45, "elev": 150},
    "time": {"mode": "realtime", "iso": ""},
    "group": "all",
    "lines": True,
    "labels": True,
    "star_labels": False,
    "grid": False,
    "ground": True,
    "camera_serial": 1,
    "camera": {"az": 90, "alt": 30, "fov": 120},
    "focus": None,
    "title": "中国星空",
}

SKY_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>观象 · 星图画面</title>
<!-- Official deployed frontend; custom code uses its exposed window._stel. -->
<script type="module" src="/vendor/stellarium-web/frontend-1.16.0/assets/index-Dd5gUw0Y.js"></script>
<link rel="stylesheet" href="/vendor/stellarium-web/frontend-1.16.0/assets/index-DAKDrmVX.css">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#080c12}
#app *{visibility:hidden!important}#stel-canvas{visibility:visible!important}
#nightmode{display:none!important}
</style>
<script src="/bridge.js" defer></script>
<script src="/labels.js" defer></script>
</head><body><div id="nightmode"></div><div id="app"></div></body></html>"""


def make_culture(group: str) -> dict:
    data = copy.deepcopy(SOURCE)
    culture_id = "gx_" + group
    data["id"] = culture_id
    wanted = GROUPS[group][1]
    data["constellations"] = [
        c for c in data["constellations"] if wanted is None or c["common_name"]["native"] in wanted
    ]
    for c in data["constellations"]:
        c["id"] = f"CON {culture_id} {c['id'].split()[-1]}"
    if group == "all" or group in REGION_LABELS:
        for key, (name, hip) in REGION_LABELS.items():
            if group != "all" and group != key:
                continue
            data["constellations"].append({
                "id": f"CON {culture_id} yuan_{key}",
                "lines": [[hip, hip]],
                "common_name": {"native": name, "english": name},
                "comment": "Display annotation at a representative star, not an additional historical asterism.",
            })
    data.pop("highlight", None)
    data.pop("thumbnail", None)
    return data


CULTURES = {key: make_culture(key) for key in GROUPS}
DESCRIPTION = f"""# 观象 · 中国星空

## Introduction
中国星官、二十八宿与三垣的直播显示定制。三垣标题锚在代表星附近，垣墙沿用原数据连线。
这里显示的是计算星空；关闭地景时用于全天球讲解。星官连线与宿度分界是两种不同的标注。

## Authors
Original data: Karrie Berglund, Sun Shuwei and the Stellarium team.
Chinese display and broadcast controls: 观象.

## License
Original text and lines: CC BY-SA, as stated by the source repository.
The derived skyculture retains the same attribution and license.

## References
- {SOURCE_URL}
"""


def finite_number(value, low, high):
    value = float(value)
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"数值需在 {low} 至 {high} 之间")
    return value


def validate_patch(patch: dict) -> dict:
    clean = {}
    for key in ("lines", "labels", "star_labels", "grid", "ground"):
        if key in patch:
            if not isinstance(patch[key], bool):
                raise ValueError("开关值无效")
            clean[key] = patch[key]
    if "group" in patch:
        if patch["group"] not in GROUPS:
            raise ValueError("星官分组不存在")
        clean["group"] = patch["group"]
    if "title" in patch:
        clean["title"] = str(patch["title"]).strip()[:48]
    if "location" in patch:
        loc = patch["location"]
        clean["location"] = {
            "name": str(loc["name"]).strip()[:32] or "自定地点",
            "lat": finite_number(loc["lat"], -90, 90),
            "lng": finite_number(loc["lng"], -180, 180),
            "elev": finite_number(loc.get("elev", 0), -500, 10000),
        }
    if "time" in patch:
        value = patch["time"]
        if value["mode"] not in ("realtime", "paused"):
            raise ValueError("时间模式无效")
        iso = ""
        if value["mode"] == "paused":
            timestamp = dt.datetime.fromisoformat(value["iso"].replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                raise ValueError("演示时间需要时区")
            iso = timestamp.astimezone(dt.timezone.utc).isoformat()
        clean["time"] = {"mode": value["mode"], "iso": iso}
    if "camera" in patch:
        camera = patch["camera"]
        clean["camera"] = {
            "az": finite_number(camera["az"], -360, 720) % 360,
            "alt": finite_number(camera["alt"], -90, 90),
            "fov": finite_number(camera["fov"], 0.5, 170),
        }
        clean["focus"] = None
    if "focus" in patch:
        value = patch["focus"]
        if value is None:
            clean["focus"] = None
        else:
            clean["focus"] = {
                "object": str(value["object"])[:80],
                "fov": finite_number(value["fov"], 0.5, 170),
            }
    return clean


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
        super().end_headers()

    def send_bytes(self, body: bytes, content_type: str, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status)

    def vendor_resource(self, route):
        # Only the public Stellarium CDN is proxied. Cache stays in process memory.
        resource = route[len("/vendor/"):]
        if not resource or ".." in resource.split("/") or resource.startswith("/"):
            return self.send_error(400)
        with VENDOR_LOCK:
            lock = VENDOR_INFLIGHT.setdefault(resource, threading.Lock())
        with lock:
            with VENDOR_LOCK:
                cached = VENDOR_CACHE.get(resource)
                if cached:
                    VENDOR_CACHE.move_to_end(resource)
            if not cached:
                try:
                    request = Request(CDN + resource, headers={"User-Agent": "Guanxiang-Chinese-Sky/1.0", "Accept-Encoding": "identity"})
                    with urlopen(request, timeout=30) as upstream:
                        body = upstream.read()
                        content_type = upstream.headers.get("Content-Type", "application/octet-stream")
                    cached = (body, content_type)
                    if len(body) <= VENDOR_LIMIT:
                        with VENDOR_LOCK:
                            VENDOR_CACHE[resource] = cached
                            while sum(len(v[0]) for v in VENDOR_CACHE.values()) > VENDOR_LIMIT:
                                VENDOR_CACHE.popitem(last=False)
                except Exception as error:
                    return self.send_json({"error": "Stellarium CDN 资源获取失败", "resource": resource, "detail": str(error)}, 502)
        body, content_type = cached
        if resource.endswith((".js", ".css", ".json")):
            local_cdn = f"http://127.0.0.1:{self.server.server_port}/vendor/".encode()
            body = body.replace(CDN.encode(), local_cdn)
        return self.send_bytes(body, content_type)

    def do_GET(self):
        route = unquote(urlsplit(self.path).path)
        if route == "/api/health":
            return self.send_json({"app": "guanxiang-chinese-sky", "pid": os.getpid(), "revision": REVISION})
        if route.startswith("/vendor/"):
            return self.vendor_resource(route)
        if route == "/api/state":
            with STATE_LOCK:
                return self.send_json(copy.deepcopy(STATE))
        if route == "/api/catalog":
            return self.send_json({
                "revision": REVISION, "source_url": SOURCE_URL,
                "asterisms": len(SOURCE["constellations"]),
                "star_names": sum(len(v) for v in SOURCE["common_names"].values()),
                "groups": [{"key": k, "name": v[0], "hip": v[2], "fov": v[3]} for k, v in GROUPS.items()],
                "names": [{"name": n, "suffix": c["id"].split()[-1]} for n, c in NAMES.items()],
            })
        if route == "/api/label-data":
            return self.send_json({
                "stars": {k: v[0]["native"] for k, v in SOURCE["common_names"].items() if k.startswith("HIP ")},
            })
        if route == "/nav.json":
            return self.send_json({"sections": []})
        if route in ("/sky", "/sky/"):
            return self.send_bytes(SKY_HTML.encode("utf-8"), "text/html; charset=utf-8")
        if route.startswith("/culture/gx_"):
            pieces = route.split("/")
            if len(pieces) == 4 and pieces[2][3:] in CULTURES:
                if pieces[3] == "index.json":
                    return self.send_json(CULTURES[pieces[2][3:]])
                if pieces[3] == "description.md":
                    return self.send_bytes(DESCRIPTION.encode("utf-8"), "text/markdown; charset=utf-8")
            return self.send_error(404)
        if route in ("/", "/program", "/program/"):
            self.path = "/app.html"
        return super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/api/state":
            return self.send_error(404)
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc not in (self.headers.get("Host"), f"localhost:{self.server.server_port}"):
            return self.send_json({"error": "只接受本机控制台请求"}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length < 10000:
                raise ValueError("请求大小无效")
            patch = json.loads(self.rfile.read(length))
            if not isinstance(patch, dict):
                raise ValueError("请求格式无效")
            clean = validate_patch(patch)
            with STATE_LOCK:
                STATE.update(clean)
                STATE["version"] += 1
                if "camera" in clean or "focus" in clean:
                    STATE["camera_serial"] += 1
                result = copy.deepcopy(STATE)
            self.send_json(result)
        except (ValueError, KeyError, TypeError) as error:
            self.send_json({"error": str(error)}, 400)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
