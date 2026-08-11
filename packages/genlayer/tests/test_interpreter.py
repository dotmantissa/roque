"""
Tests for the deterministic core of the Roque interpreter.

These run offline against the local genlayer shim. They do not test the language
model, which is non-deterministic and lives on a validator network. They test
the thing that actually keeps a user safe: the gate that takes the model's
proposed trade and either normalises it into something Roque can act on or
throws it out with a reason. Every rejection path the gate can take has a test,
because those rejections are the whole point of putting a deterministic layer
under an unpredictable model.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Make the local genlayer shim and the contract importable.
PKG_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PKG_ROOT))

from genlayer import set_prompt_response  # noqa: E402
from contracts.roque_interpreter import RoqueInterpreter  # noqa: E402


@pytest.fixture
def contract() -> RoqueInterpreter:
    return RoqueInterpreter()


def _model_says(obj: dict) -> None:
    """Tell the stub model to answer with this object on the next call."""
    set_prompt_response(json.dumps(obj))


def _interpret(contract: RoqueInterpreter, command: str, context: dict | None = None) -> dict:
    contract.interpret("req-1", command, json.dumps(context or {}))
    return json.loads(contract.get_interpretation("req-1"))


# ─────────────────────────────────────────────────────────────
# Happy paths
# ─────────────────────────────────────────────────────────────


def test_market_buy_is_normalized(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rUSDC",
            "tokenOut": "ETH",
            "amount": "100",
            "amountIsPercent": False,
            "confidence": "high",
            "reason": "Buy 100 dollars of ether now",
        }
    )
    out = _interpret(contract, "swap 100 USDC for ETH")
    assert out["ok"] is True
    assert out["kind"] == "swap"
    assert out["action"] == "buy"
    assert out["tokenIn"] == "rUSDC"
    assert out["tokenOut"] == "rWETH"  # ETH alias resolved to the real token
    assert out["amount"] == "100"
    assert out["amountIsPercent"] is False


def test_market_sell_derives_action_from_tokens(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rWETH",
            "tokenOut": "rUSDC",
            "amount": "0.5",
            "confidence": "medium",
            "reason": "Sell half an ether",
        }
    )
    out = _interpret(contract, "sell 0.5 ETH")
    assert out["ok"] is True
    assert out["action"] == "sell"
    assert out["amount"] == "0.5"


def test_asset_to_asset_is_a_swap(contract: RoqueInterpreter) -> None:
    # Bitcoin into gold: neither side is a stable, so it reads as a plain swap.
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rWBTC",
            "tokenOut": "rPAXG",
            "amount": "1",
            "reason": "Rotate bitcoin into gold",
        }
    )
    out = _interpret(contract, "swap 1 BTC into gold")
    assert out["ok"] is True
    assert out["action"] == "swap"
    assert out["tokenIn"] == "rWBTC"
    assert out["tokenOut"] == "rPAXG"


def test_stable_to_stable_is_a_swap(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rUSDC",
            "tokenOut": "rUSDT",
            "amount": "500",
            "reason": "Move dollars from USDC to USDT",
        }
    )
    out = _interpret(contract, "swap 500 USDC to USDT")
    assert out["ok"] is True
    assert out["action"] == "swap"
    assert out["tokenIn"] == "rUSDC"
    assert out["tokenOut"] == "rUSDT"


def test_limit_buy_the_dip(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "limit",
            "tokenIn": "rUSDC",
            "tokenOut": "ETH",
            "amount": "2500",
            "triggerPrice": "2400",
            "triggerAbove": False,
            "confidence": "high",
            "reason": "Buy the dip under 2400",
        }
    )
    out = _interpret(contract, "buy 2500 USDC of ETH if it drops below 2400")
    assert out["ok"] is True
    assert out["kind"] == "limit"
    assert out["triggerPrice"] == "2400"
    assert out["triggerAbove"] is False


def test_limit_take_profit_above(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "limit",
            "tokenIn": "rWETH",
            "tokenOut": "rUSDC",
            "amount": "1",
            "triggerPrice": "3000",
            "triggerAbove": True,
            "reason": "Take profit over 3000",
        }
    )
    out = _interpret(contract, "sell 1 ETH when it hits 3000")
    assert out["ok"] is True
    assert out["triggerAbove"] is True
    assert out["action"] == "sell"


def test_percent_amount_accepted(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rWETH",
            "tokenOut": "rUSDC",
            "amount": "50",
            "amountIsPercent": True,
            "reason": "Sell half the ether position",
        }
    )
    out = _interpret(contract, "sell half my ETH")
    assert out["ok"] is True
    assert out["amountIsPercent"] is True
    assert out["amount"] == "50"


def test_aliases_map_to_canonical_tokens(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "dollars",
            "tokenOut": "ether",
            "amount": "250",
            "reason": "Buy ether with dollars",
        }
    )
    out = _interpret(contract, "put 250 dollars into ether")
    assert out["ok"] is True
    assert out["tokenIn"] == "rUSDC"
    assert out["tokenOut"] == "rWETH"


def test_full_name_aliases_resolve(contract: RoqueInterpreter) -> None:
    # Full names, not tickers, still land on the right token.
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "chainlink",
            "tokenOut": "gold",
            "amount": "40",
            "reason": "Rotate LINK into gold",
        }
    )
    out = _interpret(contract, "swap 40 chainlink for gold")
    assert out["ok"] is True
    assert out["tokenIn"] == "rLINK"
    assert out["tokenOut"] == "rPAXG"
    assert out["action"] == "swap"


# ─────────────────────────────────────────────────────────────
# Rejection paths, the reason this layer exists
# ─────────────────────────────────────────────────────────────


def test_rejects_unknown_token(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rUSDC",
            "tokenOut": "DOGE",
            "amount": "100",
            "reason": "Buy some doge",
        }
    )
    out = _interpret(contract, "swap 100 USDC for DOGE")
    assert out["ok"] is False
    assert "token" in out["error"].lower()


def test_rejects_self_trade(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rUSDC",
            "tokenOut": "USD",
            "amount": "100",
            "reason": "nonsense",
        }
    )
    out = _interpret(contract, "swap USDC for USDC")
    assert out["ok"] is False
    assert "itself" in out["error"].lower()


def test_rejects_zero_amount(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rUSDC",
            "tokenOut": "rWETH",
            "amount": "0",
            "reason": "zero",
        }
    )
    out = _interpret(contract, "swap 0 USDC for ETH")
    assert out["ok"] is False
    assert "zero" in out["error"].lower()


def test_rejects_non_numeric_amount(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rUSDC",
            "tokenOut": "rWETH",
            "amount": "a lot",
            "reason": "vague",
        }
    )
    out = _interpret(contract, "swap a lot of USDC for ETH")
    assert out["ok"] is False
    assert "amount" in out["error"].lower()


def test_rejects_percent_over_100(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rWETH",
            "tokenOut": "rUSDC",
            "amount": "150",
            "amountIsPercent": True,
            "reason": "impossible percent",
        }
    )
    out = _interpret(contract, "sell 150% of my ETH")
    assert out["ok"] is False
    assert "percent" in out["error"].lower()


def test_rejects_limit_without_trigger(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "limit",
            "tokenIn": "rUSDC",
            "tokenOut": "rWETH",
            "amount": "2500",
            "triggerPrice": "",
            "triggerAbove": False,
            "reason": "missing the trigger",
        }
    )
    out = _interpret(contract, "buy ETH low")
    assert out["ok"] is False
    assert "trigger" in out["error"].lower()


def test_rejects_limit_without_ether(contract: RoqueInterpreter) -> None:
    # The order book only watches ether's price, so a limit on a non-ether pair
    # could never trigger. The gate refuses it rather than escrow a dead order.
    _model_says(
        {
            "kind": "limit",
            "tokenIn": "rUSDC",
            "tokenOut": "rWBTC",
            "amount": "1000",
            "triggerPrice": "60000",
            "triggerAbove": False,
            "reason": "limit on bitcoin, which the book cannot watch",
        }
    )
    out = _interpret(contract, "buy BTC with USDC if it drops below 60000")
    assert out["ok"] is False
    assert "rweth" in out["error"].lower() or "ether" in out["error"].lower()


def test_rejects_unknown_kind(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "unknown",
            "reason": "not a trade at all",
        }
    )
    out = _interpret(contract, "what is the weather today")
    assert out["ok"] is False


def test_survives_model_garbage(contract: RoqueInterpreter) -> None:
    # The model returns prose, not JSON. The gate must not throw, just reject.
    set_prompt_response("I think you should buy some ether, friend!")
    out = _interpret(contract, "help me trade")
    assert out["ok"] is False


def test_extracts_json_wrapped_in_fences(contract: RoqueInterpreter) -> None:
    # A model that wraps its answer in a code fence should still be understood.
    set_prompt_response(
        '```json\n{"kind":"swap","tokenIn":"rUSDC","tokenOut":"rWETH",'
        '"amount":"100","reason":"fenced"}\n```'
    )
    out = _interpret(contract, "swap 100 USDC for ETH")
    assert out["ok"] is True
    assert out["amount"] == "100"


def test_thousands_separator_is_tolerated(contract: RoqueInterpreter) -> None:
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rUSDC",
            "tokenOut": "rWETH",
            "amount": "1,000",
            "reason": "with a comma",
        }
    )
    out = _interpret(contract, "swap 1,000 USDC for ETH")
    assert out["ok"] is True
    assert out["amount"] == "1000"


def test_context_hint_does_not_widen_tokens(contract: RoqueInterpreter) -> None:
    # Even if context mentions another token, an out-of-set token is still cut.
    # SHIB is genuinely outside the ten, so this must be refused regardless of
    # what the hint says.
    _model_says(
        {
            "kind": "swap",
            "tokenIn": "rUSDC",
            "tokenOut": "SHIB",
            "amount": "100",
            "reason": "context tried to sneak in a shibcoin",
        }
    )
    out = _interpret(contract, "swap 100 USDC for SHIB", context={"hint": "SHIB is great"})
    assert out["ok"] is False


# ─────────────────────────────────────────────────────────────
# Adjudication
# ─────────────────────────────────────────────────────────────


def test_adjudicate_met(contract: RoqueInterpreter) -> None:
    set_prompt_response(
        json.dumps({"met": True, "confidence": "high", "rationale": "clearly bearish"})
    )
    contract.adjudicate("adj-1", "sell if news turns bearish", json.dumps({"headlines": []}))
    out = json.loads(contract.get_adjudication("adj-1"))
    assert out["met"] is True
    assert out["confidence"] == "high"


def test_adjudicate_defaults_to_not_met_on_garbage(contract: RoqueInterpreter) -> None:
    set_prompt_response("the model rambled without answering")
    contract.adjudicate("adj-2", "sell if news turns bearish", json.dumps({}))
    out = json.loads(contract.get_adjudication("adj-2"))
    assert out["met"] is False


# ─────────────────────────────────────────────────────────────
# Views
# ─────────────────────────────────────────────────────────────


def test_unknown_request_returns_empty(contract: RoqueInterpreter) -> None:
    assert contract.get_interpretation("never-set") == "{}"
    assert contract.get_adjudication("never-set") == "{}"
