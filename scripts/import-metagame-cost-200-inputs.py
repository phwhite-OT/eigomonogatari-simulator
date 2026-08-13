"""Convert the user-supplied cost-200 environment workbook into static inputs.

The generated module deliberately contains names (rather than catalog IDs), so
the normal alias-aware resolver continues to audit abbreviations and variants.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import convert_workbook  # noqa: E402


ATTRIBUTES = [
    ["fire"],
    ["water"],
    ["wind"],
    ["fire", "water"],
    ["fire", "wind"],
    ["water", "wind"],
    ["fire", "water", "wind"],
]
ATTRIBUTE_LABELS = {"fire": "\u706b", "water": "\u6c34", "wind": "\u98a8"}
SOURCE_NAME = "\u30b3\u30b9\u30c8200.xlsx"
COLUMNS = ["A", "B", "C", "D", "E"]
# The workbook uses the common romanisation variant \u30aa\u30ba\u30cc, while the
# catalog entry is written \u304a\u3065\u306c.  Keep this explicit so the audit does
# not depend on a weak fuzzy match.
NAME_ALIASES = {
    "\u304a\u305a\u306c\u69d8\u30b5\u30de": "\u304a\u3065\u306c\u69d8",
    "\u30aa\u30ba\u30cc\u69d8\u30b5\u30de": "\u304a\u3065\u306c\u69d8",
    "Do\u306e\u9591\u96c5\u30fb\u30eb\u30fc\u30ab\u30f3\u30ac": "\u5475\u3005Do\u306e\u9591\u96c5\u30fb\u30eb\u30fc",
    "\u30b7\u30ac\u30fc\u306a\u304a\u304d": "\u30b7\u30ac\u30fc\u2606\u76f4\u54c9",
}
ENVIRONMENT_NAME_ALLOWED_ATTRIBUTES = {
    # The supplied fire-200 environment includes this water-wind character.
    # It remains an opponent in the environment, while generated fire decks
    # continue to use only characters that include the fire attribute.
    "fire:200": {
        "Do\u306e\u9591\u96c5\u30fb\u30eb\u30fc\u30ab\u30f3\u30ac": ["water", "wind"],
    },
}


def sheet_rows(reader, sheet_data):
    rows = []
    for row in list(sheet_data)[1:]:  # row one labels the five deck positions
        values = {
            convert_workbook.column_name(cell.attrib.get("r", "")): reader.cell_value(cell)
            for cell in row
        }
        rows.append([str(values.get(column) or "").strip() or None for column in COLUMNS])
    return rows


def environment_by_position(rows):
    return [
        [row[index] for row in rows if row[index]]
        for index in range(len(COLUMNS))
    ]


def input_id(attributes):
    return "all:200" if len(attributes) == 3 else f"{'-'.join(attributes)}:200"


def input_label(attributes):
    return f"{'・'.join(ATTRIBUTE_LABELS[attribute] for attribute in attributes)}・\u30b3\u30b9\u30c8200"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    reader = convert_workbook.WorkbookReader(args.input)
    sheets = list(reader.sheets())
    if len(sheets) != 14:
        raise ValueError(f"Expected 14 sheets (seven environments and seven examples), got {len(sheets)}")

    inputs = []
    for index, attributes in enumerate(ATTRIBUTES):
        environment_rows = sheet_rows(reader, sheets[index * 2][1])
        example_rows = [row for row in sheet_rows(reader, sheets[index * 2 + 1][1]) if any(row)]
        identifier = input_id(attributes)
        input_data = {
            "id": identifier,
            "label": input_label(attributes),
            "allowedAttributes": attributes,
            "totalCost": 200,
            "source": SOURCE_NAME,
            "environmentNamesByPosition": environment_by_position(environment_rows),
            "exampleDeckPatterns": example_rows,
            "nameAliases": NAME_ALIASES,
        }
        allowed_names = ENVIRONMENT_NAME_ALLOWED_ATTRIBUTES.get(identifier)
        if allowed_names:
            input_data["environmentNameAllowedAttributes"] = allowed_names
        inputs.append(input_data)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "// Generated from the user-supplied cost-200 environment workbook.\n"
        "export const METAGAME_V8_COST_200_INPUTS = Object.freeze(\n"
        f"  {json.dumps(inputs, ensure_ascii=False, indent=2)}\n"
        ");\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
