"""
Independent reference implementation of the case-study formula, used to cross-check
the TypeScript code (tests/unit/golden.test.ts).

    wants = X_base_demand - price_sensitivity * (price - base_price)
    sales = min(seats, max(0, wants))

Reads data/seasonal_forecast.csv and data/routes.csv with pandas and writes
tests/fixtures/golden.json.

Usage (from the project root):
    python -I scripts/make_golden.py [forecast.csv] [routes.csv] [out.json]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
QUANTILE_COL = re.compile(r"^(0\.\d+)_base_demand$")


def price_points(route: pd.Series) -> list[tuple[str, float]]:
    base = float(route["base_price"])
    return [
        ("price_min", float(route["price_min"])),
        ("base_minus_1000", base - 1000),
        ("base_price", base),
        ("base_plus_777", base + 777),
        ("price_max", float(route["price_max"])),
        ("zero", 0.0),
        ("fifty_thousand", 50000.0),
    ]


def main() -> None:
    forecast_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "seasonal_forecast.csv"
    routes_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "data" / "routes.csv"
    out_path = Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / "tests" / "fixtures" / "golden.json"

    forecast = pd.read_csv(forecast_path, dtype={"route": str, "date": str})
    routes = pd.read_csv(routes_path, dtype={"route": str}).set_index("route")

    qcols = sorted(
        ((float(m.group(1)), c) for c in forecast.columns if (m := QUANTILE_COL.match(c))),
        key=lambda x: x[0],
    )
    assert any(q == 0.5 for q, _ in qcols), "no 0.5_base_demand column"

    cases = []
    for _, row in forecast.iterrows():
        route = routes.loc[row["route"]]
        seats = float(row["seats"])
        sens = float(route["price_sensitivity"])
        base_price = float(route["base_price"])
        for label, price in price_points(route):
            wants = []
            sales = []
            for _, col in qcols:
                w = float(row[col]) - sens * (price - base_price)
                wants.append(w)
                sales.append(min(seats, max(0.0, w)))
            cases.append(
                {
                    "route": row["route"],
                    "date": row["date"],
                    "seats": seats,
                    "priceLabel": label,
                    "price": price,
                    "wants": wants,
                    "sales": sales,
                }
            )

    out = {
        "generator": "scripts/make_golden.py",
        "formula": "wants = X_base_demand - price_sensitivity * (price - base_price); sales = min(seats, max(0, wants))",
        "quantiles": [q for q, _ in qcols],
        "cases": cases,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases x {len(qcols)} quantiles to {out_path}")


if __name__ == "__main__":
    main()
