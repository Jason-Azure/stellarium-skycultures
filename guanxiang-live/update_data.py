"""Regenerate Chinese display data from an explicitly selected upstream revision."""
from __future__ import annotations

import argparse
import ast
import copy
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DEFAULT_REVISION = "2d80ce70984c14bba7da2d31a0f9b27e292861c9"
UPSTREAM = "Stellarium/stellarium-skycultures"
REGIONS = {"ziwei": ("紫微垣", 72607), "taiwei": ("太微垣", 57632), "tianshi": ("天市垣", 84345)}


def read_url(url):
    with urlopen(Request(url, headers={"User-Agent": "Guanxiang-Chinese-Sky/1.0"}), timeout=30) as response:
        return response.read()


def translations(text):
    entries, current, field = {}, {"id": "", "str": ""}, None
    for line in text.splitlines() + [""]:
        line = line.strip()
        if not line:
            if current["id"] and current["str"]:
                entries[current["id"]] = current["str"]
            current, field = {"id": "", "str": ""}, None
            continue
        match = re.match(r'^(msgid|msgstr)\s+(".*")$', line)
        if match:
            field = {"msgid": "id", "msgstr": "str"}[match[1]]
            current[field] = ast.literal_eval(match[2])
        elif line.startswith('"') and field:
            current[field] += ast.literal_eval(line)
    return entries


def roman_number(value):
    digits = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    total = 0
    for i, letter in enumerate(value):
        number = digits[letter]
        total += -number if i + 1 < len(value) and number < digits[value[i + 1]] else number
    return total


def han_number(number):
    if not 0 < number < 10000:
        raise ValueError("Unsupported star ordinal: " + str(number))
    digits, units, result, zero = "零一二三四五六七八九", ["千", "百", "十", ""], "", False
    for value, unit in zip(f"{number:04d}", units):
        digit = int(value)
        if digit:
            if zero:
                result += "零"
            result += digits[digit] + unit
            zero = False
        elif result:
            zero = True
    return result[1:] if 10 <= number < 20 else result


def customize(source, words, revision):
    data = copy.deepcopy(source)
    for constellation in data["constellations"]:
        name = constellation["common_name"]
        name["native"] = name.get("native") or words.get(name["english"])
        if not name["native"]:
            raise ValueError("Missing asterism translation: " + name["english"])
    base_names = dict(words)
    base_names.update({c["common_name"]["english"]: c["common_name"]["native"] for c in data["constellations"]})
    for names in data["common_names"].values():
        for name in names:
            native = name.get("native") or words.get(name["english"])
            numbered = re.fullmatch(r"(.*?)\s+(Added\s+)?([IVXLCDM]+)", name["english"])
            if not native and numbered and numbered[1] in base_names:
                base = re.sub(r"\s*[(（].*?[)）]", "", base_names[numbered[1]])
                native = base + ("增" if numbered[2] else "") + han_number(roman_number(numbered[3]))
            if not native:
                raise ValueError("Missing star translation: " + name["english"])
            name["native"] = native
    data["langs_use_native_names"] = ["en", "zh", "zh_CN", "zh_TW", "zh_HK"]
    data["native_lang"] = "zh_CN"
    data["fallback_to_international_names"] = False
    data["comment"] = (
        "观象直播定制：启用中文原名；保留原星位编号与连线。来源："
        + UPSTREAM + "@" + revision + "/chinese，CC BY-SA；"
        "原作者 Karrie Berglund、Sun Shuwei 与 Stellarium team。"
    )
    assert [c["lines"] for c in data["constellations"]] == [c["lines"] for c in source["constellations"]]
    mansion_names = {c["common_name"]["native"] for c in data["constellations"]}
    assert all(name + "宿" in mansion_names for name in "角亢氐房心尾箕斗牛女虚危室壁奎娄胃昴毕觜参井鬼柳星张翼轸")
    return data


def write_json(path, data):
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if max(len(line.encode("utf-8")) for line in text.splitlines()) >= 4096:
        raise ValueError("Generated data has a physical line exceeding 4 KiB")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--latest", action="store_true", help="Explicitly select the current upstream master commit")
    args = parser.parse_args()
    revision = args.revision
    if args.latest:
        revision = json.loads(read_url(f"https://api.github.com/repos/{UPSTREAM}/commits/master"))["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("--revision requires a full upstream commit SHA")
    base = f"https://raw.githubusercontent.com/{UPSTREAM}/{revision}/chinese/"
    source = json.loads(read_url(base + "index.json"))
    words = translations(read_url(base + "po/zh_CN.po").decode("utf-8"))
    data = customize(source, words, revision)
    write_json(ROOT / "data" / "index.json", data)
    server = ROOT / "server.py"
    server.write_text(re.sub(r'^REVISION = "[0-9a-f]{40}"$', f'REVISION = "{revision}"', server.read_text(encoding="utf-8"), flags=re.M), encoding="utf-8")

    # Export a normal skyculture folder alongside the tool in the fork checkout.
    if (ROOT.parent / "chinese").is_dir():
        culture = copy.deepcopy(data)
        culture["id"] = "chinese_guanxiang"
        culture.pop("highlight", None)
        for constellation in culture["constellations"]:
            constellation["id"] = "CON chinese_guanxiang " + constellation["id"].split()[-1]
        for key, (name, hip) in REGIONS.items():
            culture["constellations"].append({
                "id": "CON chinese_guanxiang yuan_" + key,
                "lines": [[hip, hip]],
                "common_name": {"native": name, "english": name},
                "comment": "Display annotation at a representative star; the original enclosure wall lines are preserved.",
            })
        target = ROOT.parent / "chinese_guanxiang"
        write_json(target / "index.json", culture)
        description = read_url(base + "description.md").decode("utf-8")
        description = description.replace("# Chinese\n", "# 中国星空 · 观象中文显示\n", 1)
        description += (
            "\n## Guanxiang display customization\n\n"
            "中文原名显示，补全星名编号；三垣总名锚在代表星附近，垣墙沿用原有连线。"
            "这些总名是显示标注，星官连线与宿度分界需要分别理解。\n\n"
            f"Upstream revision: [{revision}](https://github.com/{UPSTREAM}/tree/{revision}/chinese).\n"
            "Original authors and CC BY-SA attribution are retained above.\n"
        )
        (target / "description.md").write_text(description, encoding="utf-8")
        for image in ("hunxiang.webp", "suzhouskxt.webp"):
            (target / image).write_bytes(read_url(base + image))
    print("Source revision:", revision)
    print("Asterisms:", len(data["constellations"]))
    print("Native star-name entries:", sum(len(names) for names in data["common_names"].values()))
    print("Original star connections preserved; review git diff before publishing.")


if __name__ == "__main__":
    main()
