#!/usr/bin/env python3
"""Convert Alina's Google Sheets availability tab to a public size-only feed."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import urllib.request
from collections import defaultdict
from pathlib import Path


SHEET_PREFIXES = {
    "jesusloversбеж": ("jesus-lovers-club-men", "бежевый"),
    "jesusloversсиний": ("jesus-lovers-club-men", "синий"),
    "jesusloversнебесный": ("jesus-lovers-club-women", "небесный"),
    "jesusloversтравяной": ("jesus-lovers-club-men", "травяной"),
    "jesusloversкрасный": ("jesus-lovers-club-men", "красный"),
    "oduvanchikрозовый": ("oduvanchik", "розовый"),
    "oduvanchikнебесный": ("oduvanchik", "небесный"),
    "барашеккофе": ("shepherd-women", "кофе"),
    "барашекизумруд": ("shepherd-men", "изумруд"),
    "onlyjesusчерный": ("only-jesus", "чёрный"),
    "onlyjesusтравяной": ("only-jesus", "травяной"),
    "childofgodборд": ("child-of-god", "белый"),
    "lovebut": ("love-like-jesus", "травяной"),
    "jesusislordгорчица": ("jesus-is-lord-women", "горчичный"),
    "богестьлюбовьмолоко": ("bog-est-lubov-men", "молочный"),
    "nameграфит": ("name", "графитовый"),
    "nameбордо": ("name", "бордовый"),
    "nameмолоко": ("name", "белый"),
    "praiseчерныйфутб": ("praise-tee", "чёрный"),
    "praiseчерныйлонг": ("praise-long-women", "чёрный"),
    "praiseсинийлонг": ("praise-long-men", "синий"),
    "wins": ("wins", "чёрный"),
    "byjesusлонг": ("by-jesus", "тёмно-синий"),
    "пластырь": ("jesus-healed", "белый"),
    "saved": ("saved", "бордовый"),
    "богестьлюбовьроз": ("bog-est-lubov-women", "розовый"),
}

SIZE_ORDER = {size: index for index, size in enumerate(("XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "OS"))}
SIZE_LOOKALIKE = str.maketrans({"Х": "X", "х": "x", "М": "M", "м": "m", "С": "S", "с": "s", "Л": "L", "л": "l"})


def normalize(value: str) -> str:
    value = value.strip().casefold().replace("ё", "е")
    value = re.sub(r"[^a-z0-9а-я]+", "", value)
    if value.endswith("xxl"):
        value = value[:-3] + "2xl"
    return value


def normalize_size(value: str) -> str:
    value = value.strip().translate(SIZE_LOOKALIKE).upper().replace("XXL", "2XL")
    return value


def stock_article_prefix(article: str, size: str) -> str | None:
    match = re.search(r"[_\s-]+([^_\s-]+)$", article.strip())
    if not match or normalize_size(match.group(1)) != normalize_size(size):
        return None
    return normalize(article[: match.start()])


def parse_stock(csv_text: str) -> dict[str, object]:
    reader = csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff")))
    headers = {str(name).strip(): name for name in (reader.fieldnames or [])}
    required = {"Артикул_размера", "Размер", "Общий остаток"}
    missing = required - headers.keys()
    if missing:
        raise ValueError(f"Наличие CSV missing columns: {', '.join(sorted(missing))}")

    sizes: dict[tuple[str, str], set[str]] = defaultdict(set)
    for row in reader:
        article = (row.get(headers["Артикул_размера"]) or "").strip()
        size = normalize_size(row.get(headers["Размер"]) or "")
        raw_quantity = (row.get(headers["Общий остаток"]) or "").strip()
        if not article or not size or not raw_quantity:
            continue
        try:
            quantity = int(float(raw_quantity.replace(",", ".")))
        except ValueError:
            continue

        prefix = stock_article_prefix(article, size)
        if prefix is None:
            continue
        target = SHEET_PREFIXES.get(prefix)
        if target is None:
            continue
        if quantity > 0:
            sizes[target].add(size)

    managed = sorted({f"{slug}|{normalize(tone)}" for slug, tone in SHEET_PREFIXES.values()})
    availability: dict[str, dict[str, list[str]]] = defaultdict(dict)
    for (slug, tone), available_sizes in sizes.items():
        availability[slug][tone] = sorted(available_sizes, key=lambda size: SIZE_ORDER.get(size, 999))

    if not sizes:
        raise ValueError("No mapped positive stock rows found; refusing to publish empty availability")
    return {
        "schemaVersion": 1,
        "managedVariants": managed,
        "availableSizes": dict(availability),
    }


def fetch_csv(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "GOEL-stock-sync/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8-sig")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv-file", type=Path, help="Read a CSV fixture instead of the Google Sheet")
    parser.add_argument("--output", type=Path, required=True, help="Output path for sanitized JSON")
    args = parser.parse_args()

    if args.csv_file:
        csv_text = args.csv_file.read_text(encoding="utf-8-sig")
    else:
        url = os.environ.get("GODDEROB_STOCK_CSV_URL", "").strip()
        if not url:
            raise SystemExit("Set the GODDEROB_STOCK_CSV_URL repository secret")
        csv_text = fetch_csv(url)

    stock = parse_stock(csv_text)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(stock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote sizes for {len(stock['availableSizes'])} product variants; no unit counts exported.")


if __name__ == "__main__":
    main()
