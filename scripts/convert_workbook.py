import argparse
import collections
import hashlib
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
ATTRIBUTES = ("fire", "water", "wind")
COLOR_ATTRIBUTES = {
    "FFFF4500": "fire",
    "FFADD8E6": "water",
    "FF00FF7F": "wind",
}
SHIFTED_COLUMNS = {
    "A": "T",
    "B": "U",
    "C": "V",
    "D": "W",
    "E": "X",
    "F": "Y",
    "G": "Z",
    "H": "AA",
    "I": "AB",
    "J": "AC",
    "K": "AD",
    "L": "AE",
    "M": "AF",
    "N": "AG",
    "O": "AH",
    "P": "AI",
    "Q": "AJ",
    "R": "AK",
}


def tag(namespace, name):
    return f"{{{namespace}}}{name}"


def column_name(reference):
    match = re.match(r"[A-Z]+", reference)
    return match.group(0) if match else ""


def number(value, fallback=0):
    if value in (None, ""):
        return fallback
    parsed = float(value)
    return int(parsed) if parsed.is_integer() else parsed


def first_integer(pattern, text, fallback=0):
    match = re.search(pattern, text or "")
    return int(match.group(1)) if match else fallback


JAPANESE_ATTRIBUTES = {"火": "fire", "水": "water", "風": "wind"}


def first_attribute(text):
    match = re.search(r"([火水風])属性", text or "")
    return JAPANESE_ATTRIBUTES.get(match.group(1)) if match else None


def skill_conditions(text):
    conditions = []
    ally_attributes = re.findall(r"([火水風])属性の味方", text or "")
    enemy_attributes = re.findall(r"([火水風])属性の(?:敵|攻撃)", text or "")
    for japanese in dict.fromkeys(ally_attributes):
        conditions.append({"type": "ally_attribute", "attribute": JAPANESE_ATTRIBUTES[japanese]})
    for japanese in dict.fromkeys(enemy_attributes):
        conditions.append({"type": "enemy_attribute", "attribute": JAPANESE_ATTRIBUTES[japanese]})
    return conditions


def support_target(category):
    if category.startswith("自身") or "かばう" in category:
        return "self"
    if category.startswith("リーダー") or "かわす" in category:
        return "leader"
    return "ally_all"


def parse_skill(category, text):
    category = str(category or "-")
    text = str(text or "なし")
    duration = max(1, first_integer(r"(\d+)ターン", text, 1))
    percent = first_integer(r"(\d+)%", text, 0)
    amount = first_integer(r"カウントを(\d+)", text, 0)
    hits = max(1, first_integer(r"(\d+)回連続", text, 1))
    attribute = first_attribute(text)
    effects = []
    conditions = skill_conditions(text)
    if "全属性" in text or re.search(r"[4４]属性", text):
        effects.extend({"attribute": value} for value in JAPANESE_ATTRIBUTES.values())
    elif attribute:
        effects.append({"attribute": attribute})

    if category == "-" or text == "なし":
        skill_type = "none"
        multiplier = 1
        roles = []
    elif "蘇生" in category:
        skill_type = "revive"
        multiplier = percent / 100
        roles = ["revive", "late_game"]
    elif "回復" in category:
        skill_type = "heal"
        multiplier = percent / 100
        roles = ["heal"]
    elif "短縮" in category:
        skill_type = "skill_reduction"
        multiplier = 1
        roles = ["skill_reduction", "setup"]
    elif "遅延" in category:
        skill_type = "delay"
        multiplier = 1
        roles = ["delay", "debuff"]
    elif "色変" in category:
        skill_type = "attribute_change"
        multiplier = 1
        roles = ["attribute_change", "setup"]
    elif "かばう" in category or "かわす" in category:
        skill_type = "attribute_guard" if "敵色" in category else "guard"
        multiplier = max(0, 1 - percent / 100)
        roles = ["attribute_guard" if skill_type == "attribute_guard" else "guard", "tank"]
    elif "防御" in category:
        skill_type = "damage_reduction"
        multiplier = max(0, 1 - percent / 100)
        roles = ["attribute_guard" if "敵色" in category else "guard", "tank"]
    elif "連続" in category:
        skill_type = "multi_hit_attack"
        multiplier = 1
        roles = ["multi_hit_attacker"]
    elif "全体" in category:
        skill_type = "aoe_attack"
        multiplier = 1
        roles = ["aoe_attacker"]
    elif "攻撃力Up" in category:
        skill_type = "attack_buff"
        multiplier = 1 + percent / 100
        roles = ["buff", "setup"]
    else:
        skill_type = "none"
        multiplier = 1
        roles = []

    if skill_type in {"multi_hit_attack", "aoe_attack", "attack_buff"}:
        roles.append("finisher" if duration <= 2 else "late_game")
    target = "enemy_one"
    target_count = 1
    if skill_type in {"attack_buff", "damage_reduction", "guard", "attribute_guard", "heal", "revive", "attribute_change"}:
        target = support_target(category)
        target_count = 5 if target == "ally_all" else 1
    elif skill_type == "aoe_attack":
        target = "enemy_all"
        target_count = 5
    elif category.startswith("全") or "全員" in category or "味方色" in category:
        target = "ally_all"
        target_count = 5

    return {
        "type": skill_type,
        "multiplier": multiplier,
        "hits": hits,
        "amount": amount,
        "target": target,
        "targetCount": target_count,
        "duration": duration,
        "priority": "normal",
        "conditions": conditions,
        "effects": effects,
    }, list(dict.fromkeys(roles))


class WorkbookReader:
    def __init__(self, path):
        self.archive = zipfile.ZipFile(path)
        self.shared_strings = self._read_shared_strings()
        self.style_fills, self.fills = self._read_styles()
        self.workbook = ET.fromstring(self.archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(self.archive.read("xl/_rels/workbook.xml.rels"))
        self.targets = {
            relationship.attrib["Id"]: relationship.attrib["Target"]
            for relationship in relationships.findall(tag(PACKAGE_REL_NS, "Relationship"))
        }

    def _read_shared_strings(self):
        if "xl/sharedStrings.xml" not in self.archive.namelist():
            return []
        root = ET.fromstring(self.archive.read("xl/sharedStrings.xml"))
        return [
            "".join(node.text or "" for node in item.iter(tag(MAIN_NS, "t")))
            for item in root.findall(tag(MAIN_NS, "si"))
        ]

    def _read_styles(self):
        root = ET.fromstring(self.archive.read("xl/styles.xml"))
        fills = []
        for fill in root.find(tag(MAIN_NS, "fills")):
            pattern = fill.find(tag(MAIN_NS, "patternFill"))
            foreground = pattern.find(tag(MAIN_NS, "fgColor")) if pattern is not None else None
            fills.append(dict(foreground.attrib) if foreground is not None else {})
        style_fills = {
            index: int(style.attrib.get("fillId", 0))
            for index, style in enumerate(root.find(tag(MAIN_NS, "cellXfs")))
        }
        return style_fills, fills

    def cell_value(self, cell):
        cell_type = cell.attrib.get("t")
        value = cell.find(tag(MAIN_NS, "v"))
        if cell_type == "inlineStr":
            inline = cell.find(tag(MAIN_NS, "is"))
            return "" if inline is None else "".join(
                node.text or "" for node in inline.iter(tag(MAIN_NS, "t"))
            )
        if value is None:
            return None
        if cell_type == "s":
            return self.shared_strings[int(value.text)]
        if cell_type == "b":
            return value.text == "1"
        return value.text

    def fill_color(self, style_id):
        fill_id = self.style_fills.get(style_id, 0)
        if fill_id >= len(self.fills):
            return None
        return self.fills[fill_id].get("rgb")

    def sheets(self):
        for sheet in self.workbook.find(tag(MAIN_NS, "sheets")):
            target = self.targets[sheet.attrib[tag(OFFICE_REL_NS, "id")]].lstrip("/")
            path = target if target.startswith("xl/") else f"xl/{target}"
            root = ET.fromstring(self.archive.read(path))
            yield sheet.attrib["name"], root.find(tag(MAIN_NS, "sheetData"))


def attributes_from_styles(reader, styles, first_column="A", second_column="B"):
    colors = [reader.fill_color(styles.get(first_column, 0)), reader.fill_color(styles.get(second_column, 0))]
    if "FFFFFFFF" in colors:
        return list(ATTRIBUTES)
    attributes = [COLOR_ATTRIBUTES[color] for color in colors if color in COLOR_ATTRIBUTES]
    return list(dict.fromkeys(attributes))


def make_record(reader, sheet_name, row_number, values, styles, shifted=False):
    if shifted:
        values = {target: values.get(source) for target, source in SHIFTED_COLUMNS.items()}
        styles = {target: styles.get(source, 0) for target, source in SHIFTED_COLUMNS.items()}
    name = values.get("C")
    if not name or name == "名前":
        return None
    attributes = attributes_from_styles(reader, styles)
    if not attributes:
        return None
    hp = number(values.get("J") or values.get("F"))
    power = number(values.get("K") or values.get("G"))
    cost = number(values.get("D"))
    skill, role_tags = parse_skill(values.get("P"), values.get("O"))
    source_suffix = "b" if shifted else ""
    return {
        "source": {"sheet": sheet_name, "row": f"{row_number}{source_suffix}"},
        "name": str(name),
        "attributes": attributes,
        "cost": cost,
        "hp": hp,
        "pow": power,
        "baseHp": number(values.get("F")),
        "basePow": number(values.get("G")),
        "maxLevel": number(values.get("I") or values.get("E")),
        "limitBreak": number(values.get("H")),
        "rarity": str(values.get("Q") or "unknown"),
        "region": sheet_name,
        "owned": True,
        "pvpTier": "normal",
        "allowedPositions": [1, 2, 3, 4, 5],
        "preferredPositions": [1, 2, 3, 4, 5],
        "positionRule": "free",
        "skillTurn": number(values.get("N")),
        "maxUses": 2,
        "skill": skill,
        "skillName": str(values.get("O") or "なし"),
        "skillCategory": str(values.get("P") or "-"),
        "roleTags": role_tags,
        "notes": str(values.get("R") or ""),
    }


def convert(input_path):
    reader = WorkbookReader(input_path)
    records = []
    for sheet_name, sheet_data in reader.sheets():
        if sheet_data is None:
            continue
        for row in sheet_data.findall(tag(MAIN_NS, "row")):
            row_number = int(row.attrib.get("r", 0))
            values = {}
            styles = {}
            for cell in row.findall(tag(MAIN_NS, "c")):
                column = column_name(cell.attrib.get("r", ""))
                values[column] = reader.cell_value(cell)
                styles[column] = int(cell.attrib.get("s", 0))
            primary = make_record(reader, sheet_name, row_number, values, styles)
            if primary:
                records.append(primary)
            shifted = make_record(reader, sheet_name, row_number, values, styles, shifted=True)
            if shifted:
                records.append(shifted)

    unique = collections.OrderedDict()
    differing_skill_duplicates = []
    for record in records:
        key = (record["name"], record["cost"], record["hp"], record["pow"])
        if key in unique:
            existing = unique[key]
            existing.setdefault("sources", [existing.pop("source")]).append(record["source"])
            if existing["skillName"] != record["skillName"]:
                differing_skill_duplicates.append(record["name"])
            continue
        unique[key] = record

    characters = []
    for key, record in unique.items():
        digest = hashlib.sha1("|".join(map(str, key)).encode("utf-8")).hexdigest()[:12]
        record["id"] = f"em-{digest}"
        characters.append(record)
    return characters, {
        "sourceRows": len(records),
        "uniqueCharacters": len(characters),
        "mergedDuplicates": len(records) - len(characters),
        "differingSkillDuplicates": sorted(set(differing_skill_duplicates)),
    }


def write_javascript(path, characters, summary):
    serialized = json.dumps(characters, ensure_ascii=False, separators=(",", ":"))
    content = (
        "// Generated from Book1.xlsx by scripts/convert_workbook.py.\n"
        f"export const WORKBOOK_DATA_SUMMARY = Object.freeze({json.dumps(summary, ensure_ascii=False, separators=(',', ':'))});\n"
        f"export const WORKBOOK_CHARACTERS = Object.freeze({serialized});\n"
    )
    path.write_text(content, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    characters, summary = convert(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_javascript(args.output, characters, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
