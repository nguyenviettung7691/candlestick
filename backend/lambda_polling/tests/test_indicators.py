from __future__ import annotations

from pathlib import Path
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from indicators import (  # noqa: E402
    calculate_atrm,
    calculate_ls_dvp,
    calculate_mr_zsb,
    calculate_mtf_scoring,
)


def make_ohlcv(closes: list[float], *, volume: float = 100.0) -> pd.DataFrame:
    rows = []
    for idx, close in enumerate(closes):
        rows.append(
            {
                "time": pd.Timestamp("2026-01-01") + pd.Timedelta(days=idx),
                "open": close - 0.6,
                "high": close + 1.0,
                "low": close - 1.0,
                "close": close,
                "volume": volume,
            }
        )
    return pd.DataFrame(rows)


def test_indicator_output_shape_contract() -> None:
    frame = make_ohlcv([100 + i * 0.5 for i in range(80)])

    mtf = calculate_mtf_scoring(frame, frame.tail(20), frame.tail(10), {})
    ls_dvp = calculate_ls_dvp(frame, {})
    zsb = calculate_mr_zsb(frame, {})
    atrm = calculate_atrm(frame, {})

    for result in (mtf, ls_dvp, zsb, atrm):
        assert set(result.keys()) == {"metric", "signal"}
        assert isinstance(result["metric"], float)
        assert isinstance(result["signal"], str)


def test_mtf_confidence_adjusted_weights_discount_sparse_tiers() -> None:
    df_1d = make_ohlcv([100 + i * 2 for i in range(30)])
    df_1w_sparse = make_ohlcv([100, 101, 102, 103, 104])
    df_1m_sparse = make_ohlcv([100, 99, 98, 97, 96])

    confidence_discounted = calculate_mtf_scoring(df_1d, df_1w_sparse, df_1m_sparse, {"lookback": 14})
    no_discount = calculate_mtf_scoring(
        df_1d,
        df_1w_sparse,
        df_1m_sparse,
        {"lookback": 14, "confidence_power": 0.0},
    )

    assert confidence_discounted["metric"] > no_discount["metric"]


def test_mtf_rejects_zero_total_weight() -> None:
    frame = make_ohlcv([100 + i for i in range(20)])
    with pytest.raises(ValueError, match="non-zero"):
        calculate_mtf_scoring(
            frame,
            frame,
            frame,
            {"w_1d": 0, "w_1w": 0, "w_1m": 0},
        )


def test_ls_dvp_requires_body_vs_atr_not_only_volume_spike() -> None:
    base = make_ohlcv([100 + (i % 2) * 0.1 for i in range(25)], volume=100)
    base.loc[24, "volume"] = 600
    base.loc[24, "open"] = 100.0
    base.loc[24, "close"] = 100.05
    base.loc[24, "high"] = 101.0
    base.loc[24, "low"] = 99.0

    result = calculate_ls_dvp(base, {"volume_ma": 20, "shock_threshold": 2.0, "min_body_atr": 0.25})

    assert result["metric"] > 2.0
    assert result["signal"] == "NEUTRAL"


def test_ls_dvp_emits_accumulation_when_volume_and_body_conditions_hit() -> None:
    frame = make_ohlcv([100 + (i % 3) * 0.2 for i in range(25)], volume=100)
    frame.loc[24, "volume"] = 700
    frame.loc[24, "open"] = 99.5
    frame.loc[24, "close"] = 101.2
    frame.loc[24, "high"] = 102.0
    frame.loc[24, "low"] = 99.0

    result = calculate_ls_dvp(frame, {"volume_ma": 20, "shock_threshold": 2.0, "min_body_atr": 0.25})

    assert result["signal"] == "SHOCK_ACCUMULATION"


def test_mr_zsb_uses_prior_window_for_baseline() -> None:
    closes = [98.0, 99.0, 100.0, 101.0, 102.0, 108.0]
    frame = make_ohlcv(closes)

    result = calculate_mr_zsb(frame, {"ma_period": 5, "robust": False, "entry_z": 2.0})

    baseline = np.array(closes[:-1])
    center = baseline.mean()
    scale = baseline.std(ddof=0)
    expected = (closes[-1] - center) / scale

    assert result["metric"] == round(float(np.clip(expected, -6.0, 6.0)), 2)
    assert result["signal"] == "SELL_OVERBOUGHT"


def test_mr_zsb_handles_insufficient_history_neutral() -> None:
    frame = make_ohlcv([100, 101, 102, 103, 104])
    result = calculate_mr_zsb(frame, {"ma_period": 10})
    assert result == {"metric": 0.0, "signal": "NEUTRAL"}


def test_atrm_dead_zone_maps_to_neutral() -> None:
    frame = make_ohlcv([100 + i * 0.01 for i in range(60)])
    result = calculate_atrm(frame, {"fast_ema": 12, "slow_ema": 26, "min_delta_bps": 500.0})

    assert abs(result["metric"]) < 500.0
    assert result["signal"] == "NEUTRAL"


def test_atrm_rejects_invalid_period_relationship() -> None:
    frame = make_ohlcv([100 + i * 0.2 for i in range(40)])
    with pytest.raises(ValueError, match="fast_ema"):
        calculate_atrm(frame, {"fast_ema": 26, "slow_ema": 26})
