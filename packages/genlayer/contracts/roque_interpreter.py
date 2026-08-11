# v0.1.0
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import re


# The only assets Roque settles on Sepolia. The interpreter treats "ETH" and
# "ether" as WETH because that is what the pool actually holds. Nothing outside
# this set is ever allowed to leave the contract as a valid intent, no matter
# what the language model says. This is the hard line: the model reads English,
# but this set decides what counts as a real token.
KNOWN_TOKENS = ("USDC", "WETH")

# How the interpreter maps the loose words people actually type onto the two
# canonical symbols above. Applied deterministically, after the model answers,
# so a hallucinated ticker cannot slip through.
TOKEN_ALIASES = {
    "USDC": "USDC",
    "USD": "USDC",
    "USDT": "USDC",
    "DOLLAR": "USDC",
    "DOLLARS": "USDC",
    "STABLE": "USDC",
    "STABLECOIN": "USDC",
    "WETH": "WETH",
    "ETH": "WETH",
    "ETHER": "WETH",
    "ETHEREUM": "WETH",
}

# A plain decimal amount like "100" or "0.5". No leading sign, no exponent, no
# thousands separators. Kept as a string end to end so the contract never
# touches a float, which the GenVM forbids anyway.
_AMOUNT_RE = re.compile(r"^\d+(\.\d+)?$")


class RoqueInterpreter(gl.Contract):
    """
    Turns a sentence of plain English into a structured trade Roque can act on.

    A person types "swap 100 USDC for ETH" or "buy ether if it dips below 2400"
    and this contract returns a tidy object: what to sell, what to buy, how much,
    and, for a resting order, the price that should wake it up. The language model
    does the reading. It never does the deciding. Every field it proposes is run
    back through deterministic checks here, and anything that does not line up
    with the two tokens Roque actually trades is thrown out with a reason.

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
        the live ETH price or which balances the user holds. It only ever informs
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
        return f"""
You translate a person's trading request into strict JSON for a small exchange
that only trades two assets: USDC (a dollar stablecoin) and WETH (wrapped ether,
which people usually just call ETH or ether).

Optional context from the app, treat only as a hint, never as permission to use
other tokens:
{context_json}

The request:
"{command}"

Decide the following and answer with ONLY a JSON object, no prose, no code
fences:
{{
  "kind": "swap" | "limit" | "unknown",
  "tokenIn": "USDC" | "WETH",
  "tokenOut": "USDC" | "WETH",
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
- Buying ETH means tokenIn USDC and tokenOut WETH. Selling ETH is the reverse.
- "half", "all", "25 percent" set amountIsPercent true and amount the number
  only ("50", "100", "25").
- For a limit, triggerAbove is true when the order should fire as the price
  rises ("if it goes above", "when it hits") and false when it should fire as
  the price falls ("if it drops below", "buy the dip").
- Never invent a token. If the request names something that is not USDC or WETH,
  use kind "unknown".
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
            trigger_price = str(candidate.get("triggerPrice", "")).strip().replace(",", "")
            if not _AMOUNT_RE.match(trigger_price) or re.match(r"^0(\.0+)?$", trigger_price):
                reject["error"] = "limit order needs a positive trigger price"
                return reject

        # Derive the action from the tokens rather than trusting the model to
        # keep its own story straight. Buying ether is anything that ends in WETH.
        action = "buy" if token_out == "WETH" else "sell"

        return {
            "ok": True,
            "kind": kind,
            "action": action,
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
