"""观象 · 中文星空直播：本机控制台、OBS 播出页与 Stellarium 资源代理。

星空由 Stellarium Web 官方部署的引擎计算和渲染；本服务只做三件事：
保存直播状态并推送给各页面，按分组生成中文星空文化数据，代理并在本机缓存官方资源。
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import math
import mimetypes
import os
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
_cache_base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_CACHE_HOME")
CACHE = (Path(_cache_base) if _cache_base else Path.home() / ".cache") / "guanxiang-chinese-sky" / "stellarium"
SOURCE = json.loads((ROOT / "data" / "index.json").read_text(encoding="utf-8"))
REVISION = "2d80ce70984c14bba7da2d31a0f9b27e292861c9"
SOURCE_URL = f"https://github.com/Stellarium/stellarium-skycultures/tree/{REVISION}/chinese"

# Official Stellarium Web deployment (pinned). Its CDN only allows CORS from
# stellarium-web.org, so every engine request is proxied through /vendor/.
UPSTREAMS = {
    "vendor": "https://stellarium.sfo2.cdn.digitaloceanspaces.com/",
    "vendor-data": "https://stellarium.sfo2.digitaloceanspaces.com/",
}
FRONTEND = "stellarium-web/frontend-1.16.0/assets/"
FRONTEND_JS = FRONTEND + "index-Dd5gUw0Y.js"
FRONTEND_CSS = FRONTEND + "index-DAKDrmVX.css"
DISK_CACHED = {"vendor"}          # versioned, static files; the data host serves daily TLEs
MEMORY_LIMIT = 96 * 1024 * 1024

NAMES = {c["common_name"]["native"]: c for c in SOURCE["constellations"]}
MANSIONS = [name + "宿" for name in "角亢氐房心尾箕斗牛女虚危室壁奎娄胃昴毕觜参井鬼柳星张翼轸"]
WALLS = ["紫微左垣", "紫微右垣", "太微左垣", "太微右垣", "天市左垣", "天市右垣"]
# 近南极星区二十三星官：明末据西方星图增补，中原看不到或只贴地平线，排在最后。
# 亮星或常讲的小星官，星数少也优先标注。
FAMOUS = set("天狼 老人 大角 织女 河鼓 北落师门 南门 轩辕 五车 北河 南河 天津 北极 勾陈 华盖 文昌 三台 贯索 七公 "
             "招摇 王良 阁道 大陵 天船 天大将军 帝座 天关".split())
SOUTHERN = set("海山 十字架 马尾 马腹 蜜蜂 三角形 异雀 孔雀 波斯 蛇尾 蛇腹 蛇首 鸟喙 鹤 火鸟 水委 附白 夹白 金鱼 海石 飞鱼 南船 小斗".split())
# key: (显示名, 该组星官, 镜头中心 HIP, 视场)
GROUPS = {
    "all": ("中国星官", None, None, 100),
    "mansions": ("二十八宿", MANSIONS, None, 120),
    "ziwei": ("紫微垣", ["紫微左垣", "紫微右垣"], 11767, 80),
    "taiwei": ("太微垣", ["太微左垣", "太微右垣"], 57632, 55),
    "tianshi": ("天市垣", ["天市左垣", "天市右垣"], 84345, 60),
    "beidou": ("北斗", ["北斗"], 59774, 50),
    "dragon": ("东方苍龙", MANSIONS[:7], 80763, 95),
    "tortoise": ("北方玄武", MANSIONS[7:14], 102618, 95),
    "tiger": ("西方白虎", MANSIONS[14:21], 17702, 95),
    "bird": ("南方朱雀", MANSIONS[21:], 46390, 95),
}
# 三垣总名是显示注记，落在各垣的帝座上（紫微垣：北极二“帝”；太微垣：五帝座一；天市垣：帝座）。
REGIONS = {"ziwei": ("紫微垣", 72607), "taiwei": ("太微垣", 57632), "tianshi": ("天市垣", 84345)}
for _, _names, _, _ in GROUPS.values():
    assert not _names or all(name in NAMES for name in _names), _names


def asterism_rank(name: str, stars: int) -> int:
    """Label priority: 1 二十八宿, 2 垣墙/北斗/名星/大星官, 3 中等, 4 小星官与近南极星官（0 留给三垣总名）。"""
    if name in MANSIONS:
        return 1
    if name in SOUTHERN:
        return 4
    if name in WALLS or name in FAMOUS or name == "北斗" or stars >= 7:
        return 2
    return 3 if stars >= 3 else 4


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
    for key in ("highlight", "thumbnail", "thumbnail_bscale"):
        data.pop(key, None)
    return data


CULTURES = {key: make_culture(key) for key in GROUPS}
DESCRIPTION = f"""# 观象 · 中国星空

## Introduction
中国星官、二十八宿与三垣的直播显示定制，连线沿用原数据。

## Authors
Original data: Karrie Berglund, Sun Shuwei and the Stellarium team.
Chinese display and broadcast controls: 观象.

## License
Original text and lines: CC BY-SA, as stated by the source repository.

## References
- {SOURCE_URL}
"""


def build_catalog() -> dict:
    asterisms = []
    for c in SOURCE["constellations"]:
        name = c["common_name"]["native"]
        hips = list(dict.fromkeys(s for line in c["lines"] for s in line if isinstance(s, int)))
        stars = len(hips)
        if stars:
            # 同名星官在原数据里带括注（如“柱 (毕宿)”），画面上只写名字
            label = re.sub(r"\s*[(（].*?[)）]", "", name) or name
            asterisms.append({"name": name, "label": label, "suffix": c["id"].split()[-1], "stars": stars,
                              "rank": asterism_rank(name, stars), "hips": hips[:3]})
    star_names = {}
    for key, names in SOURCE["common_names"].items():
        if key.startswith("HIP "):
            entry = [names[0]["native"]]
            if len(names) > 1:
                entry.append(names[1]["native"])
            star_names[key] = entry
    return {
        "revision": REVISION, "source_url": SOURCE_URL,
        "asterism_count": len(SOURCE["constellations"]),
        "star_name_count": sum(len(v) for v in SOURCE["common_names"].values()),
        "groups": [{"key": k, "name": v[0], "hip": v[2], "fov": v[3]} for k, v in GROUPS.items()],
        "regions": [{"key": k, "name": v[0], "hip": v[1]} for k, v in REGIONS.items()],
        "asterisms": asterisms,
        "stars": star_names,
    }


CATALOG = build_catalog()

# ---------------------------------------------------------------- state

DEFAULT_STATE = {
    "version": 1,
    "group": "all",
    "title": "今晚的中国星空",
    "caption": "",
    "location": {"name": "洛阳", "lat": 34.62, "lng": 112.45, "elev": 150},
    # Sky time in ms since epoch = t0 + (now - w0) * rate; live follows the clock.
    "time": {"live": True, "t0": 0, "w0": 0, "rate": 1},
    "view": {"lines": True, "labels": True, "stars": False, "planets": "modern", "grid": False,
             "ground": "ink", "atmosphere": True, "hud": True, "aspect": "16:9"},
    "camera": {"serial": 1, "kind": "altaz", "az": 180, "alt": 32, "fov": 100, "object": None,
               "motion": "cut", "source": ""},
    "follow": True,
}


def finite(value, low, high):
    value = float(value)
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"数值需在 {low} 至 {high} 之间")
    return value


def text(value, limit):
    return str(value).replace("\n", " ").strip()[:limit]


def validate(patch: dict) -> dict:
    clean = {}
    if "group" in patch:
        if patch["group"] not in GROUPS:
            raise ValueError("星官分组不存在")
        clean["group"] = patch["group"]
    if "title" in patch:
        clean["title"] = text(patch["title"], 40)
    if "caption" in patch:
        clean["caption"] = text(patch["caption"], 60)
    if "follow" in patch:
        clean["follow"] = bool(patch["follow"])
    if "location" in patch:
        loc = patch["location"]
        clean["location"] = {
            "name": text(loc.get("name", ""), 24) or "自定地点",
            "lat": finite(loc["lat"], -90, 90),
            "lng": finite(loc["lng"], -180, 180),
            "elev": finite(loc.get("elev", 0), -500, 9000),
        }
    if "time" in patch:
        t = patch["time"]
        clean["time"] = {
            "live": bool(t.get("live")),
            "t0": finite(t.get("t0", 0), -2.5e14, 2.5e14),
            "w0": finite(t.get("w0", 0), 0, 1e14),
            "rate": finite(t.get("rate", 1), -86400, 86400),
        }
    if "view" in patch:
        v, out = patch["view"], {}
        for key in ("lines", "labels", "stars", "grid", "atmosphere", "hud"):
            if key in v:
                out[key] = bool(v[key])
        choices = {"planets": ("modern", "classic"), "ground": ("ink", "field", "none"), "aspect": ("16:9", "9:16")}
        for key, allowed in choices.items():
            if key in v:
                if v[key] not in allowed:
                    raise ValueError("画面设置无效")
                out[key] = v[key]
        clean["view"] = out
    if "camera" in patch:
        c = patch["camera"]
        kind = c.get("kind", "altaz")
        if kind not in ("altaz", "object"):
            raise ValueError("镜头类型无效")
        motion = c.get("motion", "glide")
        if motion not in ("glide", "cut", "track"):
            raise ValueError("运镜方式无效")
        # fov 0 asks the page to fit the object
        cam = {"kind": kind, "fov": finite(c["fov"], 0 if kind == "object" else 0.2, 180), "motion": motion,
               "source": text(c.get("source", ""), 40), "object": None, "az": 0, "alt": 0}
        if kind == "object":
            cam["object"] = text(c["object"], 80)
        else:
            cam["az"] = finite(c["az"], -720, 720) % 360
            cam["alt"] = finite(c["alt"], -90, 90)
        clean["camera"] = cam
    return clean


class Hub:
    """Shared live state; every change wakes the event streams."""

    def __init__(self):
        self.cond = threading.Condition()
        self.state = copy.deepcopy(DEFAULT_STATE)
        now = time.time() * 1000
        self.state["time"].update(t0=now, w0=now)
        self.program = {}

    def snapshot(self):
        with self.cond:
            return copy.deepcopy(self.state)

    def apply(self, clean):
        with self.cond:
            for key, value in clean.items():
                if key == "view":
                    self.state["view"].update(value)
                elif key == "camera":
                    value["serial"] = self.state["camera"]["serial"] + 1
                    self.state["camera"] = value
                else:
                    self.state[key] = value
            self.state["version"] += 1
            self.cond.notify_all()
            return copy.deepcopy(self.state)

    def wait(self, version, timeout):
        with self.cond:
            self.cond.wait_for(lambda: self.state["version"] != version, timeout)
            return copy.deepcopy(self.state) if self.state["version"] != version else None


HUB = Hub()

# ---------------------------------------------------------------- vendor proxy


class Vendor:
    """Fetch official resources once; persist them in the user's application cache."""

    def __init__(self):
        self.lock = threading.Lock()
        self.inflight = {}
        self.memory = {}
        self.memory_size = 0

    @staticmethod
    def disk_path(host, resource):
        return CACHE / host / Path(*resource.split("/"))

    def get(self, host, resource):
        with self.lock:
            gate = self.inflight.setdefault((host, resource), threading.Lock())
        with gate:
            path = self.disk_path(host, resource)
            if host in DISK_CACHED and path.is_file():
                meta = path.with_name(path.name + ".type")
                kind = meta.read_text() if meta.is_file() else (mimetypes.guess_type(path.name)[0] or "application/octet-stream")
                return path.read_bytes(), kind
            with self.lock:
                if (host, resource) in self.memory:
                    return self.memory[(host, resource)]
            request = Request(UPSTREAMS[host] + resource,
                              headers={"User-Agent": "Guanxiang-Chinese-Sky/2.0", "Accept-Encoding": "identity"})
            with urlopen(request, timeout=40) as upstream:
                body = upstream.read()
                kind = upstream.headers.get("Content-Type", "application/octet-stream")
            if host in DISK_CACHED:
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    temp = path.with_name(path.name + ".part")
                    temp.write_bytes(body)
                    os.replace(temp, path)
                    path.with_name(path.name + ".type").write_text(kind)
                except OSError:
                    pass
            elif len(body) < MEMORY_LIMIT // 8:
                with self.lock:
                    self.memory[(host, resource)] = (body, kind)
                    self.memory_size += len(body)
                    while self.memory_size > MEMORY_LIMIT:
                        old, _ = self.memory.pop(next(iter(self.memory)))
                        self.memory_size -= len(old)
            return body, kind


VENDOR = Vendor()

SKY_HTML = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>观象 · 星空画面</title>
<link rel="stylesheet" href="/vendor/{FRONTEND_CSS}">
<link rel="stylesheet" href="/web/sky.css">
<script type="module" src="/vendor/{FRONTEND_JS}"></script>
<script src="/web/labels.js" defer></script>
<script src="/web/sky.js" defer></script>
</head><body><div id="nightmode"></div><div id="app"></div></body></html>"""


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, *_args):
        pass

    def end_headers(self):
        if not self.path.startswith("/vendor"):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
        super().end_headers()

    def send_bytes(self, body: bytes, content_type: str, status=200, cache=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status)

    def vendor(self, host, resource):
        if not resource or ".." in resource.split("/") or resource.startswith("/") or "\\" in resource:
            return self.send_error(400)
        try:
            body, kind = VENDOR.get(host, resource)
        except Exception as error:  # network trouble is reported to the page, not raised
            return self.send_json({"error": "Stellarium 资源获取失败", "resource": resource, "detail": str(error)}, 502)
        if resource.endswith((".js", ".css", ".json")):
            base = f"http://{self.headers.get('Host', '127.0.0.1')}/"
            for key in ("vendor", "vendor-data"):
                body = body.replace(UPSTREAMS[key].encode(), (base + key + "/").encode())
        self.send_bytes(body, kind, cache=True)

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()
        state = HUB.snapshot()
        try:
            self.wfile.write(b"retry: 1000\n\n")
            while True:
                if state:
                    payload = json.dumps(state, ensure_ascii=False)
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    version = state["version"]
                else:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
                state = HUB.wait(version, 15)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def do_GET(self):
        route = unquote(urlsplit(self.path).path)
        for key in UPSTREAMS:
            if route.startswith(f"/{key}/"):
                return self.vendor(key, route[len(key) + 2:])
        if route == "/api/health":
            return self.send_json({"app": "guanxiang-chinese-sky", "version": 2, "build": "2.0.1",
                                   "pid": os.getpid(), "revision": REVISION, "root": str(ROOT), "cache": str(CACHE)})
        if route == "/api/state":
            return self.send_json(HUB.snapshot())
        if route == "/api/events":
            return self.events()
        if route == "/api/catalog":
            return self.send_json(CATALOG)
        if route == "/api/program":
            with HUB.cond:
                seen = dict(HUB.program)
            seen["age"] = time.time() - seen["seen"] if seen else None
            return self.send_json(seen)
        if route == "/nav.json":
            return self.send_json({"sections": []})
        if route == "/program":
            self.send_response(302)
            self.send_header("Location", "/sky/?role=program")
            return self.end_headers()
        if route in ("/sky", "/sky/") or route.startswith("/sky/"):
            return self.send_bytes(SKY_HTML.encode("utf-8"), "text/html; charset=utf-8")
        if route.startswith("/culture/gx_"):
            pieces = route.split("/")
            if len(pieces) == 4 and pieces[2][3:] in CULTURES:
                if pieces[3] == "index.json":
                    return self.send_json(CULTURES[pieces[2][3:]])
                if pieces[3] == "description.md":
                    return self.send_bytes(DESCRIPTION.encode("utf-8"), "text/markdown; charset=utf-8")
            return self.send_error(404)
        if route == "/":
            self.path = "/console.html"
        elif route.startswith("/web/"):
            self.path = self.path[4:]
        else:
            return self.send_error(404)
        return super().do_GET()

    def read_json(self):
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            raise PermissionError("只接受本机页面的请求")
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length < 20000:
            raise ValueError("请求大小无效")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("请求格式无效")
        return value

    def do_POST(self):
        route = urlsplit(self.path).path
        try:
            value = self.read_json()
            if route == "/api/state":
                return self.send_json(HUB.apply(validate(value)))
            if route == "/api/program":
                info = {"seen": time.time(), "w": int(finite(value.get("w", 0), 0, 10000)),
                        "h": int(finite(value.get("h", 0), 0, 10000)),
                        "fps": round(finite(value.get("fps", 0), 0, 1000)),
                        "ready": bool(value.get("ready"))}
                with HUB.cond:
                    HUB.program = info
                return self.send_json({"ok": True})
            return self.send_error(404)
        except PermissionError as error:
            return self.send_json({"error": str(error)}, 403)
        except (ValueError, KeyError, TypeError) as error:
            return self.send_json({"error": str(error)}, 400)


class Server(ThreadingHTTPServer):
    # Windows lets a second process share a port under SO_REUSEADDR; refuse instead.
    allow_reuse_address = False
    allow_reuse_port = False
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    mimetypes.add_type("application/wasm", ".wasm")
    mimetypes.add_type("font/woff", ".woff")
    server = Server(("127.0.0.1", args.port), Handler)
    print(f"控制台：http://127.0.0.1:{args.port}/", flush=True)
    print(f"OBS 浏览器来源：http://127.0.0.1:{args.port}/program", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
