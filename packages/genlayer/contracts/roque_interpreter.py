# v0.1.0
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import re


# The ten assets Roque settles on Sepolia, by their on-chain symbols. Every
# tradable token carries the r prefix because they are Roque's own minted test
# tokens, each pinned to a real Chainlink feed. Nothing outside this set is ever
# allowed to leave the contract as a valid intent, no matter what the language
# model says. This is the hard line: the model reads English, but this tuple
# decides what counts as a real token.
KNOWN_TOKENS = (
    "rUSDC",
    "rUSDT",
    "rDAI",
    "rWETH",
    "rWBTC",
    "rLINK",
    "rSNX",
    "rFORTH",
    "rEURC",
    "rPAXG",
)

# The three dollar stablecoins in the set. Used only to phrase a trade as a buy,
# a sell, or a plain swap for the human-readable summary; it changes nothing
# about what the contract permits.
STABLES = ("rUSDC", "rUSDT", "rDAI")

# The one asset whose USD price the OrderBook actually watches. Resting limit
# orders are gated on the ETH/USD Chainlink feed the book was deployed against,
# so a limit only has a coherent trigger when ether is one side of the trade.
# Market swaps have no such restriction; they work across all forty-five pairs.
TRIGGER_TOKEN = "rWETH"

# How the interpreter maps the loose words people actually type onto the ten
# canonical symbols above. Applied deterministically, after the model answers,
# so a hallucinated ticker cannot slip through. The keys are upper-cased because
# that is how a symbol arrives here after normalisation; both the bare ticker a
# person types ("eth", "gold") and the canonical form the model is asked to emit
# ("rWETH") resolve to the same token.
TOKEN_ALIASES = {
    # Dollar stables. "USD", "dollar" and the like default to rUSDC, the
    # canonical dollar; rUSDT and rDAI are their own tokens and never collapse
    # into it.
    "RUSDC": "rUSDC",
    "USDC": "rUSDC",
    "USD": "rUSDC",
    "USDCOIN": "rUSDC",
    "DOLLAR": "rUSDC",
    "DOLLARS": "rUSDC",
    "STABLE": "rUSDC",
    "STABLECOIN": "rUSDC",
    "RUSDT": "rUSDT",
    "USDT": "rUSDT",
    "TETHER": "rUSDT",
    "RDAI": "rDAI",
    "DAI": "rDAI",
    # Ether, which almost everyone calls ETH even though the pool holds WETH.
    "RWETH": "rWETH",
    "WETH": "rWETH",
    "ETH": "rWETH",
    "ETHER": "rWETH",
    "ETHEREUM": "rWETH",
    "WRAPPEDETH": "rWETH",
    "WRAPPEDETHER": "rWETH",
    # Bitcoin, likewise usually said as BTC.
    "RWBTC": "rWBTC",
    "WBTC": "rWBTC",
    "BTC": "rWBTC",
    "XBT": "rWBTC",
    "BITCOIN": "rWBTC",
    "WRAPPEDBTC": "rWBTC",
    "WRAPPEDBITCOIN": "rWBTC",
    # The rest, ticker and full name both.
    "RLINK": "rLINK",
    "LINK": "rLINK",
    "CHAINLINK": "rLINK",
    "RSNX": "rSNX",
    "SNX": "rSNX",
    "SYNTHETIX": "rSNX",
    "RFORTH": "rFORTH",
    "FORTH": "rFORTH",
    "AMPLEFORTH": "rFORTH",
    "REURC": "rEURC",
    "EURC": "rEURC",
    "EUR": "rEURC",
    "EURO": "rEURC",
    "EUROS": "rEURC",
    "EUROC": "rEURC",
    "EUROCOIN": "rEURC",
    "RPAXG": "rPAXG",
    "PAXG": "rPAXG",
    "PAXGOLD": "rPAXG",
    "GOLD": "rPAXG",
    "XAU": "rPAXG",
}

# A short, human line for each token so the prompt can teach the model the set
# without a wall of text. Order matches KNOWN_TOKENS.
_TOKEN_BLURB = {
    "rUSDC": "a US dollar stablecoin",
    "rUSDT": "Tether, a US dollar stablecoin",
    "rDAI": "Dai, a US dollar stablecoin",
    "rWETH": "wrapped ether, which people call ETH or ether",
    "rWBTC": "wrapped bitcoin, which people call BTC",
    "rLINK": "Chainlink's LINK token",
    "rSNX": "Synthetix's SNX token",
    "rFORTH": "Ampleforth's FORTH token",
    "rEURC": "a euro stablecoin, said as EUR or euros",
    "rPAXG": "Pax Gold, a token backed by an ounce of gold",
}

# A plain decimal amount like "100" or "0.5". No leading sign, no exponent, no
# thousands separators. Kept as a string end to end so the contract never
# touches a float, which the GenVM forbids anyway.
_AMOUNT_RE = re.compile(r"^\d+(\.\d+)?$")


class RoqueInterpreter(gl.Contract):
    """
    Turns a sentence of plain English into a structured trade Roque can act on.

    A person types "swap 100 USDC for ETH", "move 500 dai into gold", or "buy
    link if it dips below 12" and this contract returns a tidy object: what to
    sell, what to buy, how much, and, for a resting order, the price that should
    wake it up. The language model does the reading. It never does the deciding.
    Every field it proposes is run back through deterministic checks here, and
    anything that does not line up with the ten tokens Roque actually trades is
    thrown out with a reason.

    Worth being blunt about the trust story: this contract holds no money and
    signs nothing. Its answer is a suggestion the off-chain relayer picks up,
    turns into a signed intent, and submits to Sepolia, where the real caps live.
    So a wrong interpretation here cannot move funds on its own. Even so it earns
    its keep by refusing to emit nonsense, which keeps the relayer honest and the
    user unsurprised.
    """

    # request id -> interpretation JSON, so the relayer can read the result back.
    interpretations: TreeMap[str, str]
    # request id -> adjudication JSON, for the subjective "did this happen yet"
    # questions a price feed can never answer.
    adjudications: TreeMap[str, str]

    def __init__(self) -> None:
        pass

    # ─────────────────────────────────────────────────────────────
    # Interpretation: English -> structured intent
    # ─────────────────────────────────────────────────────────────

    @gl.public.write
    def interpret(self, request_id: str, command: str, context_json: str) -> None:
        """
        Read a trading instruction and store the structured version of it.

        `context_json` is an optional hint bag the relayer fills in, for example
        the live prices or which balances the user holds. It only ever informs
        the reading; it can never widen what tokens are allowed. Returns None on
        purpose and stashes the answer, which keeps the simulator from tripping
        over return serialisation on the nondet path.
        """
        canonical = command.strip()

        def read_intent() -> str:
            prompt = self._build_prompt(canonical, context_json)
            raw = gl.nondet.exec_prompt(prompt)
            candidate = self._extract_json(raw)
            result = self._validate_and_normalize(candidate, canonical)
            return json.dumps(result, sort_keys=True)

        # Validators each read the sentence independently; they only agree if
        # they land on the same trade. Comparing the normalised object, not the
        # model's raw prose, means small wording differences do not break
        # consensus while a genuine disagreement about the trade still does.
        consensus = gl.eq_principle.prompt_comparative(
            read_intent,
            """
            Compare the two JSON trade intents. Consider them equal only when
            kind, tokenIn, tokenOut, amount, amountIsPercent, triggerAbove and a
            triggerPrice within one percent all match. Return one of the matching
            objects when they agree.
            """,
        )

        stored = self._safe_store(consensus, canonical)
        self.interpretations[request_id] = stored

    def _build_prompt(self, command: str, context_json: str) -> str:
        token_lines = "\n".join(f"- {sym}: {_TOKEN_BLURB[sym]}" for sym in KNOWN_TOKENS)
        return f"""
You translate a person's trading request into strict JSON for Roque, a small
exchange. Roque trades exactly these ten tokens and nothing else. Use the symbol
on the left verbatim in your answer:
{token_lines}

Optional context from the app, treat only as a hint, never as permission to use
other tokens:
{context_json}

The request:
"{command}"

Decide the following and answer with ONLY a JSON object, no prose, no code
fences:
{{
  "kind": "swap" | "limit" | "unknown",
  "tokenIn": "<one of the ten symbols above>",
  "tokenOut": "<one of the ten symbols above>",
  "amount": "<decimal number as a string, e.g. 100 or 0.5>",
  "amountIsPercent": true | false,
  "triggerPrice": "<ETH price in USD as a string, limit orders only, else empty>",
  "triggerAbove": true | false,
  "confidence": "high" | "medium" | "low",
  "reason": "<one short human sentence explaining the trade>"
}}

Rules:
- "swap" means do it now. "limit" means wait for a price. If it is neither a
  buy nor a sell, use "unknown".
- tokenIn is what the person gives up, tokenOut is what they receive. "Buy X
  with Y" means tokenIn Y and tokenOut X. "Sell X for Y" means tokenIn X and
  tokenOut Y. "Swap X to Y" means tokenIn X and tokenOut Y.
- "half", "all", "25 percent" set amountIsPercent true and amount the number
  only ("50", "100", "25").
- Resting limit orders track ether's dollar price only, so use "limit" solely
  when rWETH is one of the two tokens. For any other pair use "swap". For a
  limit, triggerPrice is that ETH/USD price, triggerAbove is true when the order
  should fire as the price rises ("if it goes above", "when it hits") and false
  when it should fire as the price falls ("if it drops below", "buy the dip").
- Never invent a token. If the request names something outside the ten symbols
  above, use kind "unknown".
""".strip()

    def _extract_json(self, raw: str) -> dict:
        """Pull a JSON object out of whatever the model returned, forgivingly."""
        if not isinstance(raw, str):
            return {}
        text = raw.replace("```json", "").replace("```", "").strip()
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            pass
        # Last resort: grab the first {...} block and try again.
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                parsed = json.loads(text[start : end + 1])
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}
        return {}

    def _normalize_token(self, value) -> str:
        """Map a loose token word onto a canonical symbol, or '' if unknown."""
        if not isinstance(value, str):
            return ""
        key = value.strip().upper()
        # Tolerate bridged-token notation like "USDC.e".
        if key.endswith(".E"):
            key = key[:-2]
        return TOKEN_ALIASES.get(key, "")

    def _validate_and_normalize(self, candidate: dict, command: str) -> dict:
        """
        The deterministic gate. Takes the model's proposed object and returns a
        clean intent only if every field survives scrutiny. This is where a
        confused or manipulated model gets caught, so it deliberately trusts
        nothing and re-derives what it safely can.
        """
        reject = {
            "ok": False,
            "kind": "unknown",
            "tokenIn": "",
            "tokenOut": "",
            "amount": "",
            "amountIsPercent": False,
            "triggerPrice": "",
            "triggerAbove": False,
            "confidence": "low",
            "reason": "",
            "error": "",
        }

        if not isinstance(candidate, dict):
            reject["error"] = "model returned no usable object"
            return reject

        kind = str(candidate.get("kind", "unknown")).strip().lower()
        if kind not in ("swap", "limit"):
            reject["error"] = "not a recognisable buy or sell"
            reject["reason"] = str(candidate.get("reason", ""))[:200]
            return reject

        token_in = self._normalize_token(candidate.get("tokenIn"))
        token_out = self._normalize_token(candidate.get("tokenOut"))
        if token_in == "" or token_out == "":
            reject["error"] = "names a token Roque does not trade"
            return reject
        if token_in == token_out:
            reject["error"] = "cannot trade a token for itself"
            return reject
        if token_in not in KNOWN_TOKENS or token_out not in KNOWN_TOKENS:
            reject["error"] = "token outside the allowed set"
            return reject

        amount = str(candidate.get("amount", "")).strip().replace(",", "")
        if not _AMOUNT_RE.match(amount):
            reject["error"] = "amount is missing or not a plain number"
            return reject
        # A pure-zero amount is never a real order.
        if re.match(r"^0(\.0+)?$", amount):
            reject["error"] = "amount is zero"
            return reject

        is_percent = bool(candidate.get("amountIsPercent", False))
        if is_percent and not self._percent_in_range(amount):
            reject["error"] = "percent must be between 0 and 100"
            return reject

        trigger_price = ""
        trigger_above = bool(candidate.get("triggerAbove", False))
        if kind == "limit":
            # The book only knows ether's price, so a limit is only coherent when
            # ether is one side of the trade. Everything else becomes a plain
            # swap suggestion rather than an order that could never trigger.
            if TRIGGER_TOKEN not in (token_in, token_out):
                reject["error"] = (
                    "resting orders track ether's price, so a limit needs rWETH "
                    "on one side; try a market swap for this pair"
                )
                return reject
            trigger_price = str(candidate.get("triggerPrice", "")).strip().replace(",", "")
            if not _AMOUNT_RE.match(trigger_price) or re.match(r"^0(\.0+)?$", trigger_price):
                reject["error"] = "limit order needs a positive trigger price"
                return reject

        return {
            "ok": True,
            "kind": kind,
            "action": self._derive_action(token_in, token_out),
            "tokenIn": token_in,
            "tokenOut": token_out,
            "amount": amount,
            "amountIsPercent": is_percent,
            "triggerPrice": trigger_price,
            "triggerAbove": trigger_above,
            "confidence": self._clean_confidence(candidate.get("confidence")),
            "reason": str(candidate.get("reason", ""))[:200],
            "error": "",
        }

    def _derive_action(self, token_in: str, token_out: str) -> str:
        """
        Phrase the trade for the human summary, derived from the tokens rather
        than trusting the model's own label. Spending a stable to get an asset
        reads as a buy, the reverse as a sell, and anything else, asset to asset
        or stable to stable, is just a swap.
        """
        in_stable = token_in in STABLES
        out_stable = token_out in STABLES
        if in_stable and not out_stable:
            return "buy"
        if out_stable and not in_stable:
            return "sell"
        return "swap"

    def _percent_in_range(self, amount: str) -> bool:
        """True when 0 < amount <= 100, checked without ever building a float."""
        if "." in amount:
            whole, frac = amount.split(".", 1)
        else:
            whole, frac = amount, ""
        # Strip a harmless trailing-zero fraction so "100.0" reads as 100.
        frac_nonzero = frac.strip("0") != ""
        try:
            whole_int = int(whole)
        except Exception:
            return False
        if whole_int > 100:
            return False
        if whole_int == 100 and frac_nonzero:
            return False
        if whole_int == 0 and not frac_nonzero:
            return False
        return True

    def _clean_confidence(self, value) -> str:
        c = str(value).strip().lower() if value is not None else ""
        return c if c in ("high", "medium", "low") else "medium"

    def _safe_store(self, consensus_json: str, command: str) -> str:
        """Guard the store against a consensus blob that will not parse."""
        try:
            parsed = json.loads(consensus_json)
            if isinstance(parsed, dict):
                return json.dumps(parsed, sort_keys=True)
        except Exception:
            pass
        return json.dumps(
            {
                "ok": False,
                "kind": "unknown",
                "error": "validators could not agree on a reading",
                "reason": "",
            },
            sort_keys=True,
        )

    # ─────────────────────────────────────────────────────────────
    # Adjudication: the questions a price feed cannot answer
    # ─────────────────────────────────────────────────────────────

    @gl.public.write
    def adjudicate(self, request_id: str, condition: str, evidence_json: str) -> None:
        """
        Rule on a subjective condition, the kind Chainlink will never settle, for
        example "sell if the news turns clearly bearish on ether". The relayer
        gathers evidence off-chain, passes it in, and this contract returns a
        plain yes or no with a short reason. Same trust story as everything else
        here: it decides nothing on its own, it only advises the relayer.
        """
        cond = condition.strip()

        def judge() -> str:
            prompt = f"""
You are a careful, sceptical adjudicator for a trading assistant. Decide whether
the condition below is clearly met by the evidence. Lean towards "not met" when
the evidence is thin, stale, or ambiguous; a false "met" can cost someone money.

Condition:
"{cond}"

Evidence (JSON gathered by the app):
{evidence_json}

Answer with ONLY this JSON, no prose:
{{ "met": true | false, "confidence": "high" | "medium" | "low",
   "rationale": "<one or two short sentences>" }}
""".strip()
            raw = gl.nondet.exec_prompt(prompt)
            candidate = self._extract_json(raw)
            met = bool(candidate.get("met", False))
            confidence = self._clean_confidence(candidate.get("confidence"))
            rationale = str(candidate.get("rationale", ""))[:300]
            return json.dumps(
                {"met": met, "confidence": confidence, "rationale": rationale},
                sort_keys=True,
            )

        consensus = gl.eq_principle.prompt_comparative(
            judge,
            """
            Compare the two verdicts. They agree only when the boolean "met" is
            identical. Return either matching object when they agree.
            """,
        )

        try:
            parsed = json.loads(consensus)
            stored = json.dumps(parsed, sort_keys=True) if isinstance(parsed, dict) else "{}"
        except Exception:
            stored = json.dumps(
                {"met": False, "confidence": "low", "rationale": "no agreement"},
                sort_keys=True,
            )
        self.adjudications[request_id] = stored

    # ─────────────────────────────────────────────────────────────
    # Views
    # ─────────────────────────────────────────────────────────────

    @gl.public.view
    def get_interpretation(self, request_id: str) -> str:
        if request_id in self.interpretations:
            return self.interpretations[request_id]
        return "{}"

    @gl.public.view
    def get_adjudication(self, request_id: str) -> str:
        if request_id in self.adjudications:
            return self.adjudications[request_id]
        return "{}"
