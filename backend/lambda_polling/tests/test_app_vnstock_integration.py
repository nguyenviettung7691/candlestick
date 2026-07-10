from __future__ import annotations

from pathlib import Path
import types
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import (  # noqa: E402
    _VnstockRateLimiter,
    _call_quote_history_method,
    _fetch_history_frame,
    _fetch_live_data,
    _fetch_live_data_with_history,
    _normalize_ohlcv_frame,
    _register_vnstock_api_key,
    _serialize_history_bars,
)


def _sample_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "time": pd.date_range("2026-01-01", periods=3, freq="D"),
            "open": [100.0, 101.0, 102.0],
            "high": [101.0, 102.0, 103.0],
            "low": [99.0, 100.0, 101.0],
            "close": [100.5, 101.5, 102.5],
            "volume": [1000, 1100, 1200],
        }
    )


def test_fetch_history_frame_uses_quote_api_engine() -> None:
    calls: list[tuple[str, str]] = []
    history_calls: list[dict[str, object]] = []

    class FakeQuote:
        def __init__(self, *, symbol: str, source: str, show_log: bool) -> None:
            calls.append((symbol, source))

        def history(self, **kwargs: object) -> pd.DataFrame:
            history_calls.append(kwargs)
            assert "interval" in kwargs or "period" in kwargs
            return _sample_frame()

    engine = {
        "mode": "quote_api",
        "quote_class": FakeQuote,
    }

    result = _fetch_history_frame(engine, "FPT")

    assert not result.empty
    assert calls == [("FPT", "VCI")]
    assert len(history_calls) == 1
    assert set(["open", "high", "low", "close", "volume"]).issubset(result.columns)


def test_fetch_history_frame_uses_unified_ui_market_engine() -> None:
    equity_calls: list[str] = []
    ohlcv_calls: list[dict[str, object]] = []

    class EquityAccessor:
        def ohlcv(self, **kwargs: object) -> pd.DataFrame:
            ohlcv_calls.append(kwargs)
            return pd.DataFrame(
                {
                    "Date": pd.date_range("2026-01-01", periods=3, freq="D"),
                    "Open": [100.0, 101.0, 102.0],
                    "High": [101.0, 102.0, 103.0],
                    "Low": [99.0, 100.0, 101.0],
                    "Close": [100.5, 101.5, 102.5],
                    "Volume": [1000, 1100, 1200],
                }
            )

    class FakeMarket:
        def equity(self, *, symbol: str) -> EquityAccessor:
            equity_calls.append(symbol)
            return EquityAccessor()

    engine = {
        "mode": "unified_ui_market",
        "market_class": FakeMarket,
    }

    result = _fetch_history_frame(engine, "FPT")

    assert not result.empty
    assert equity_calls == ["FPT"]
    assert len(ohlcv_calls) == 1
    assert "time" in result.columns
    assert set(["open", "high", "low", "close", "volume"]).issubset(result.columns)


def test_fetch_history_frame_prefers_market_quote_history() -> None:
    class QuoteComponent:
        def history(self, **kwargs: object) -> pd.DataFrame:
            assert "interval" in kwargs or "period" in kwargs
            return _sample_frame()

    class MarketObject:
        quote = QuoteComponent()

    class Engine:
        def stock(self, *, symbol: str, source: str) -> MarketObject:
            assert symbol == "HPG"
            assert source == "VCI"
            return MarketObject()

    result = _fetch_history_frame(Engine(), "HPG")

    assert not result.empty


def test_fetch_live_data_handles_market_without_trading_history(monkeypatch) -> None:
    class QuoteComponent:
        def history(self, **_kwargs: object) -> pd.DataFrame:
            return _sample_frame()

    class MarketObject:
        quote = QuoteComponent()

    class Engine:
        def stock(self, *, symbol: str, source: str) -> MarketObject:
            return MarketObject()

    monkeypatch.setattr(
        "app._build_live_packet",
        lambda ticker, _df: {
            "symbol": ticker,
            "price": 123.45,
            "mtf_score": 0.0,
            "mtf_signal": "NEUTRAL",
            "ls_ratio": 0.0,
            "ls_signal": "NEUTRAL",
            "z_score": 0.0,
            "z_signal": "NEUTRAL",
            "trend_delta": 0.0,
            "trend_signal": "NEUTRAL",
        },
    )

    live_data = _fetch_live_data(["VCB"], Engine())

    assert "VCB" in live_data
    assert live_data["VCB"]["symbol"] == "VCB"


def test_fetch_live_data_with_history_returns_history_series(monkeypatch) -> None:
    class QuoteComponent:
        def history(self, **_kwargs: object) -> pd.DataFrame:
            return _sample_frame()

    class MarketObject:
        quote = QuoteComponent()

    class Engine:
        def stock(self, *, symbol: str, source: str) -> MarketObject:
            return MarketObject()

    monkeypatch.setattr(
        "app._build_live_packet",
        lambda ticker, _df: {
            "symbol": ticker,
            "price": 123.45,
            "mtf_score": 0.0,
            "mtf_signal": "NEUTRAL",
            "ls_ratio": 0.0,
            "ls_signal": "NEUTRAL",
            "z_score": 0.0,
            "z_signal": "NEUTRAL",
            "trend_delta": 0.0,
            "trend_signal": "NEUTRAL",
        },
    )

    live_data, history_by_symbol = _fetch_live_data_with_history(["VCB"], Engine())

    assert "VCB" in live_data
    assert "VCB" in history_by_symbol
    assert len(history_by_symbol["VCB"]) == 3
    assert history_by_symbol["VCB"][0]["time"] > 0


def test_serialize_history_bars_uses_configured_history_window(monkeypatch) -> None:
    monkeypatch.setattr("app.PRICE_HISTORY_SIZE", 100)
    monkeypatch.setattr("app.MIN_UI_HISTORY_BARS", 65)

    frame = pd.DataFrame(
        {
            "time": pd.date_range("2025-01-01", periods=120, freq="D"),
            "open": [100 + i for i in range(120)],
            "high": [101 + i for i in range(120)],
            "low": [99 + i for i in range(120)],
            "close": [100.5 + i for i in range(120)],
            "volume": [1000 + i for i in range(120)],
        }
    )

    bars = _serialize_history_bars(frame)

    assert len(bars) == 100
    assert set(["time", "open", "high", "low", "close"]).issubset(bars[0].keys())


def test_register_vnstock_api_key_uses_environment_value(monkeypatch) -> None:
    calls: list[str] = []

    fake_vnstock = types.ModuleType("vnstock")

    def register_user(*, api_key: str) -> None:
        calls.append(api_key)

    fake_vnstock.register_user = register_user  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "vnstock", fake_vnstock)
    monkeypatch.setenv("VNSTOCK_API_KEY", "vnstock_RANDOM_KEY")
    monkeypatch.setattr("app.VNSTOCK_API_KEY", "vnstock_RANDOM_KEY")

    _register_vnstock_api_key()

    assert calls == ["vnstock_RANDOM_KEY"]


def test_vnstock_rate_limiter_waits_after_per_minute_limit() -> None:
    class FakeClock:
        def __init__(self) -> None:
            self.now = 0.0
            self.sleep_calls: list[float] = []

        def monotonic(self) -> float:
            return self.now

        def sleep(self, seconds: float) -> None:
            self.sleep_calls.append(seconds)
            self.now += seconds

    clock = FakeClock()
    limiter = _VnstockRateLimiter(
        per_minute=2,
        per_hour=10,
        per_day=100,
        per_month=1000,
        time_func=clock.monotonic,
        sleep_func=clock.sleep,
    )

    limiter.acquire()
    limiter.acquire()
    limiter.acquire()

    assert len(clock.sleep_calls) == 1
    assert clock.sleep_calls[0] == 60.0


def test_vnstock_rate_limiter_waits_after_per_day_limit() -> None:
    class FakeClock:
        def __init__(self) -> None:
            self.now = 0.0
            self.sleep_calls: list[float] = []

        def monotonic(self) -> float:
            return self.now

        def sleep(self, seconds: float) -> None:
            self.sleep_calls.append(seconds)
            self.now += seconds

    clock = FakeClock()
    limiter = _VnstockRateLimiter(
        per_minute=100,
        per_hour=100,
        per_day=2,
        per_month=100,
        time_func=clock.monotonic,
        sleep_func=clock.sleep,
    )

    limiter.acquire()
    limiter.acquire()
    limiter.acquire()

    assert len(clock.sleep_calls) == 1
    assert clock.sleep_calls[0] == 86_400.0


def test_vnstock_rate_limiter_waits_after_per_month_limit() -> None:
    class FakeClock:
        def __init__(self) -> None:
            self.now = 0.0
            self.sleep_calls: list[float] = []

        def monotonic(self) -> float:
            return self.now

        def sleep(self, seconds: float) -> None:
            self.sleep_calls.append(seconds)
            self.now += seconds

    clock = FakeClock()
    limiter = _VnstockRateLimiter(
        per_minute=100,
        per_hour=100,
        per_day=100,
        per_month=2,
        time_func=clock.monotonic,
        sleep_func=clock.sleep,
    )

    limiter.acquire()
    limiter.acquire()
    limiter.acquire()

    assert len(clock.sleep_calls) == 1
    assert clock.sleep_calls[0] == 2_592_000.0


def test_call_quote_history_method_uses_rate_limiter(monkeypatch) -> None:
    class FakeLimiter:
        def __init__(self) -> None:
            self.calls = 0

        def acquire(self) -> None:
            self.calls += 1

    limiter = FakeLimiter()
    monkeypatch.setattr("app.VNSTOCK_RATE_LIMITER", limiter)

    result = _call_quote_history_method(lambda **_kwargs: _sample_frame(), ticker="FPT")

    assert not result.empty
    assert limiter.calls == 1


def test_normalize_ohlcv_frame_handles_datetime_index_and_aliases() -> None:
    frame = pd.DataFrame(
        {
            "Open": [100.0, 101.0, 102.0],
            "High": [101.0, 102.0, 103.0],
            "Low": [99.0, 100.0, 101.0],
            "Close": [100.5, 101.5, 102.5],
            "Vol": [1000, 1100, 1200],
        },
        index=pd.date_range("2026-02-01", periods=3, freq="D"),
    )

    normalized = _normalize_ohlcv_frame(frame)

    assert "time" in normalized.columns
    assert set(["open", "high", "low", "close", "volume"]).issubset(normalized.columns)
    assert not normalized.empty
