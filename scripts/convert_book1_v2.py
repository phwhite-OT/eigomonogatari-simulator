import argparse
import collections
import hashlib
import json
from pathlib import Path

import convert_workbook
from convert_book1 import safe_number


convert_workbook.number = safe_number


def convert(input_path):
    reader = convert_workbook.WorkbookReader(input_path)
    records = []
    for sheet_name, sheet_data in reader.sheets():
        if sheet_data is None:
            continue
        for row in sheet_data.findall(convert_workbook.tag(convert_workbook.MAIN_NS, "row")):
            row_number = int(row.attrib.get("r", 0))
            values = {}
            styles = {}
            for cell in row.findall(convert_workbook.tag(convert_workbook.MAIN_NS, "c")):
                column = convert_workbook.column_name(cell.attrib.get("r", ""))
                values[column] = reader.cell_value(cell)
                styles[column] = int(cell.attrib.get("s", 0))
            primary = convert_workbook.make_record(reader, sheet_name, row_number, values, styles)
            if primary:
                records.append(primary)
            shifted = convert_workbook.make_record(
                reader,
                sheet_name,
                row_number,
                values,
                styles,
                shifted=True,
            )
            if shifted:
                records.append(shifted)

    unique = collections.OrderedDict()
    for record in records:
        key = (
            record["name"],
            tuple(record["attributes"]),
            record["cost"],
            record["hp"],
            record["pow"],
            record["skillTurn"],
            record["skillName"],
            record["skillCategory"],
        )
        if key in unique:
            existing = unique[key]
            existing.setdefault("sources", [existing.pop("source")]).append(record["source"])
            continue
        unique[key] = record

    characters = []
    for key, record in unique.items():
        digest_source = json.dumps(key, ensure_ascii=False, separators=(",", ":"))
        digest = hashlib.sha1(digest_source.encode("utf-8")).hexdigest()[:12]
        record["id"] = f"em-{digest}"
        characters.append(record)
    return characters, {
        "sourceRows": len(records),
        "uniqueCharacters": len(characters),
        "mergedExactDuplicates": len(records) - len(characters),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    characters, summary = convert(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    convert_workbook.write_javascript(args.output, characters, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
