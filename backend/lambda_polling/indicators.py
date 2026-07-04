from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd


REQUIRED_OHLCV_COLUMNS = {"open", "high", "low", "close", "volume"}


@dataclass(frozen=True)
class IndicatorResult:
    metric: float
    signal: str

    def as_dict(self) -> dict[str, Any]:
        return {"metric": round(float(self.metric), 2), "signal": self.signal}


def _safe_int(value: Any, *, minimum: int, name: str) -> int:
    parsed = int(value)
    if parsed < minimum:
        raise ValueError(f"{name} must be greater than or equal to {minimum}")
    return parsed


def _safe_float(value: Any, *, minimum: float | None = None, name: str) -> float:
    parsed = float(value)
    if minimum is not None and parsed < minimum:
        raise ValueError(f"{name} must be greater than or equal to {minimum}")
    return parsed


def _ensure_frame(df: pd.DataFrame) -> pd.DataFrame:
    if df is None:
        raise ValueError("price data frame is required")
    if not isinstance(df, pd.DataFrame):
        raise TypeError("price data must be a pandas DataFrame")
    missing = REQUIRED_OHLCV_COLUMNS.difference(df.columns)
    if missing:
        raise ValueError(f"missing required columns: {sorted(missing)}")
    frame = df.copy()
    for column in REQUIRED_OHLCV_COLUMNS:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame.dropna(subset=list(REQUIRED_OHLCV_COLUMNS))


def _tier_score(df: pd.DataFrame, lookback: int) -> float:
    if len(df) < lookback:
        return 50.0

    window = df.tail(lookback)
    low_n = float(window["low"].min())
    high_n = float(window["high"].max())
    if np.isclose(high_n, low_n):
        return 50.0

    close = float(window["close"].iloc[-1])
    score = ((close - low_n) / (high_n - low_n)) * 100.0
    return float(np.clip(score, 0.0, 100.0))


def _true_range(frame: pd.DataFrame) -> pd.Series:
    high = frame["high"].astype(float)
    low = frame["low"].astype(float)
    close = frame["close"].astype(float)
    prev_close = close.shift(1)
    tr_components = pd.concat([(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1)
    return tr_components.max(axis=1)


def calculate_mtf_scoring(
    df_1d: pd.DataFrame,
    df_1w: pd.DataFrame,
    df_1m: pd.DataFrame,
    params: dict[str, Any],
) -> dict[str, Any]:
    """
    Multi-Timeframe Scoring Framework.

    Formula: S_MTF = sum(w_t * ((C_t - L_n,t) / (H_n,t - L_n,t)) * 100)
    """

    frames = [(_ensure_frame(df_1d), "1d"), (_ensure_frame(df_1w), "1w"), (_ensure_frame(df_1m), "1m")]
    lookback = _safe_int(params.get("lookback", 14), minimum=1, name="lookback")
    confidence_power = _safe_float(params.get("confidence_power", 1.0), minimum=0.0, name="confidence_power")

    weights = {
        "1d": float(params.get("w_1d", 0.2)),
        "1w": float(params.get("w_1w", 0.3)),
        "1m": float(params.get("w_1m", 0.5)),
    }

    total_weight = sum(weights.values())
    if np.isclose(total_weight, 0.0):
        raise ValueError("at least one weight must be non-zero")

    # Discount tiers that do not have enough history so sparse data does not dominate the score.
    adjusted_weights: dict[str, float] = {}
    for frame, label in frames:
        base_weight = weights[label]
        confidence = min(len(frame) / lookback, 1.0)
        adjusted_weights[label] = base_weight * (confidence**confidence_power)

    adjusted_total = sum(adjusted_weights.values())
    if np.isclose(adjusted_total, 0.0):
        adjusted_weights = {label: weight / total_weight for label, weight in weights.items()}
    else:
        adjusted_weights = {label: weight / adjusted_total for label, weight in adjusted_weights.items()}

    weighted_score = sum(adjusted_weights[label] * _tier_score(frame, lookback) for frame, label in frames)
    final_score = float(np.clip(weighted_score, 0.0, 100.0))
    signal = "BUY" if final_score > 75 else "SELL" if final_score < 30 else "NEUTRAL"
    return IndicatorResult(metric=final_score, signal=signal).as_dict()


def calculate_ls_dvp(df_1d: pd.DataFrame, params: dict[str, Any]) -> dict[str, Any]:
    """
    Liquidity Shock & Delta Volume Profile.
    Tracks volume anomalies relative to a rolling average alongside spread direction.
    """

    frame = _ensure_frame(df_1d)
    lookback = _safe_int(params.get("volume_ma", 20), minimum=2, name="volume_ma")
    multiplier = _safe_float(params.get("shock_threshold", 2.0), minimum=0.1, name="shock_threshold")
    atr_period = _safe_int(params.get("atr_period", 14), minimum=2, name="atr_period")
    min_body_atr = _safe_float(params.get("min_body_atr", 0.25), minimum=0.0, name="min_body_atr")

    if len(frame) < lookback:
        return IndicatorResult(metric=1.0, signal="NEUTRAL").as_dict()

    vol_window = frame["volume"].tail(lookback)
    current_vol = float(vol_window.iloc[-1])
    ma_vol = float(vol_window.mean())
    vol_ratio = current_vol / ma_vol if ma_vol > 0 else 1.0

    vol_std = float(vol_window.std(ddof=0))
    vol_z = (current_vol - ma_vol) / vol_std if vol_std > 0 else 0.0

    tr = _true_range(frame)
    atr = float(tr.rolling(window=atr_period).mean().iloc[-1]) if len(frame) >= atr_period else 0.0

    close = float(frame["close"].iloc[-1])
    open_price = float(frame["open"].iloc[-1])
    body = abs(close - open_price)
    body_vs_atr = body / atr if atr > 0 else 0.0

    signal = "NEUTRAL"
    if vol_ratio >= multiplier and body_vs_atr >= min_body_atr and vol_z >= 1.0:
        signal = "SHOCK_ACCUMULATION" if close >= open_price else "SHOCK_DISTRIBUTION"

    return IndicatorResult(metric=vol_ratio, signal=signal).as_dict()


def calculate_mr_zsb(df_1d: pd.DataFrame, params: dict[str, Any]) -> dict[str, Any]:
    """
    Mean Reversion Z-Score Band.
    Measures standard deviations from the historical moving average.
    """

    frame = _ensure_frame(df_1d)
    period = _safe_int(params.get("ma_period", 50), minimum=5, name="ma_period")
    entry_z = _safe_float(params.get("entry_z", 2.0), minimum=0.5, name="entry_z")
    robust = bool(params.get("robust", True))

    if len(frame) <= period:
        return IndicatorResult(metric=0.0, signal="NEUTRAL").as_dict()

    close = frame["close"].astype(float)
    baseline_window = close.iloc[-(period + 1) : -1]
    current_close = float(close.iloc[-1])

    if robust:
        center = float(np.median(baseline_window))
        mad = float(np.median(np.abs(baseline_window - center)))
        scale = 1.4826 * mad
    else:
        center = float(baseline_window.mean())
        scale = float(baseline_window.std(ddof=0))

    z_score = (current_close - center) / scale if scale > 0 else 0.0
    z_score = float(np.clip(z_score, -6.0, 6.0))
    signal = "BUY_OVERSOLD" if z_score < -entry_z else "SELL_OVERBOUGHT" if z_score > entry_z else "NEUTRAL"
    return IndicatorResult(metric=z_score, signal=signal).as_dict()


def calculate_atrm(df_1d: pd.DataFrame, params: dict[str, Any]) -> dict[str, Any]:
    """
    Adaptive Trend Regime Matrix.
    Calculates the spread between fast and slow EMAs.
    """

    frame = _ensure_frame(df_1d)
    fast_period = _safe_int(params.get("fast_ema", 12), minimum=1, name="fast_ema")
    slow_period = _safe_int(params.get("slow_ema", 26), minimum=2, name="slow_ema")
    min_delta_bps = _safe_float(params.get("min_delta_bps", 8.0), minimum=0.0, name="min_delta_bps")
    if fast_period >= slow_period:
        raise ValueError("fast_ema must be less than slow_ema")

    if len(frame) < slow_period:
        return IndicatorResult(metric=0.0, signal="NEUTRAL").as_dict()

    close = frame["close"].astype(float)
    fast_ema = float(close.ewm(span=fast_period, adjust=False).mean().iloc[-1])
    slow_ema = float(close.ewm(span=slow_period, adjust=False).mean().iloc[-1])
    current_close = float(close.iloc[-1])
    if np.isclose(current_close, 0.0):
        return IndicatorResult(metric=0.0, signal="NEUTRAL").as_dict()

    delta_bps = ((fast_ema - slow_ema) / current_close) * 10_000.0
    if abs(delta_bps) < min_delta_bps:
        signal = "NEUTRAL"
    else:
        signal = "BULLISH_TREND" if delta_bps > 0 else "BEARISH_TREND"

    return IndicatorResult(metric=delta_bps, signal=signal).as_dict()
