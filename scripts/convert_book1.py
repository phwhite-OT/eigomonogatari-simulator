import convert_workbook


def safe_number(value, fallback=0):
    if value in (None, "", "-"):
        return fallback
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return int(parsed) if parsed.is_integer() else parsed


convert_workbook.number = safe_number


if __name__ == "__main__":
    convert_workbook.main()
