"""Build the web font subsets used by the broadcast page and the console.

    python -X utf8 build_fonts.py --serif C:/Windows/Fonts/NotoSerifSC-VF.ttf --kai LXGWWenKai-Regular.ttf

Needs fontTools. Output goes to web/fonts/ as WOFF: Noto Serif SC (instanced at weight 600,
renamed "GX Sky Serif") and LXGW WenKai, each cut to GB2312 level 1, every name in
data/index.json and the text of the web pages. Both fonts are SIL OFL 1.1.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "web" / "fonts"
PUNCT = "，。、：；！？（）《》〈〉「」『』“”‘’—…·・〇○●◆◇■□▲△▼▽▶◀↗↺＋－×÷°′″℃％　"


def charset() -> str:
    chars = {chr(c) for c in range(0x20, 0x7F)} | set(PUNCT)
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    data = json.loads((ROOT / "data" / "index.json").read_text(encoding="utf-8"))
    for c in data["constellations"]:
        chars.update(c["common_name"].get("native", ""))
    for names in data["common_names"].values():
        for name in names:
            chars.update(name.get("native", ""))
    for path in list((ROOT / "web").glob("*.*")) + [ROOT / "server.py"]:
        if path.suffix in (".html", ".js", ".css", ".py"):
            chars.update(re.findall(r"[^\x00-\x7f]", path.read_text(encoding="utf-8")))
    return "".join(sorted(chars))


def rename(font: TTFont, family: str):
    for record in font["name"].names:
        if record.nameID in (1, 4, 16):
            record.string = family
        elif record.nameID == 6:
            record.string = family.replace(" ", "")


def cut(font: TTFont, text: str, target: Path):
    options = subset.Options()
    options.flavor = "woff"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    target.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = "woff"
    font.save(target)
    print(target.name, round(target.stat().st_size / 1024), "KiB")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--serif", required=True, help="Noto Serif SC variable font (NotoSerifSC-VF.ttf)")
    parser.add_argument("--kai", required=True, help="LXGW WenKai Regular .ttf")
    args = parser.parse_args()
    text = charset()
    print("characters:", len(text))
    serif = TTFont(args.serif)
    if "fvar" in serif:
        serif = instancer.instantiateVariableFont(serif, {"wght": 600})
    rename(serif, "GX Sky Serif")
    cut(serif, text, OUT / "gx-sky-serif.woff")
    kai = TTFont(args.kai)
    rename(kai, "GX Sky Kai")
    cut(kai, text, OUT / "gx-sky-kai.woff")


if __name__ == "__main__":
    main()
