/**
 * The domain logic of Roque, sitting above the chain and the database and below
 * whatever serves HTTP. Both the standalone relayer and the web app's API routes
 * call into here, so the rules of the product live in one place rather than
 * being retyped per transport.
 *
 * The through line is the trust model. A request comes in as plain English. The
 * judgment layer reads it and the deterministic gate on-chain in GenLayer either
 * blesses a structured intent or refuses. If it is blessed, we quote it against
 * the live pool and hand the user something concrete to sign, or, in autonomous
 * mode, sign it as the agent within the capability they already granted. At no
 * point does a language model's opinion reach for funds directly.
 */

import { randomUUID } from "node:crypto";
import { parseUnits, formatUnits } from "viem";
import {
  addresses,
  tokenBySymbol,
  tokenSymbols,
  type TokenMeta,
} from "@roque/shared";
import { interpret, type Interpretation } from "./genlayer.js";
import { quoteSwap, minOutForSlippage } from "./quote.js";
import { ethUsd, tokenUsd, toTriggerPrice } from "./prices.js";
import {
  signSwapIntent,
  signLimitIntent,
  submitSwap,
  submitLimitOrder,
  freshNonce,
  agentSignerAddress,
  getCapability,
  vaultBalance,
  type SwapIntent,
  type LimitIntent,
} from "./intents.js";
import { q } from "./db/index.js";

// How long an agent-signed intent stays valid once minted. Short, because the
// relayer submits immediately; a stale intent is a liability, not a convenience.
const INTENT_TTL_SECONDS = 300;

// A resting limit order the agent opens lives for a week unless it fills or the
// user cancels. Long enough to be useful, short enough to not linger forever.
const LIMIT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export type Mode = "copilot" | "autonomous";

export interface InterpretResult {
  id: string;
  interpretation: Interpretation;
  quote?: {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    price: number;
    usdValue: number;
  };
  message: string;
}

/**
 * Resolve a percent-or-absolute amount into a concrete human-units string. For a
 * percent we need a base to take the percent of; in autonomous mode that base is
 * the user's vault balance of the input token, which is the only pool of funds
 * the agent may touch.
 */
async function resolveAmount(
  interp: Interpretation,
  tokenIn: TokenMeta,
  user: `0x${string}` | undefined,
  mode: Mode,
): Promise<string> {
  if (!interp.amountIsPercent) return interp.amount;

  const percent = Number(interp.amount);
  if (!Number.isFinite(percent) || percent <= 0) {
    throw new Error("A percentage amount needs a positive number.");
  }

  // A percent only means something against a balance. In autonomous mode we read
  // the vault; in copilot mode the frontend supplies the wallet balance, so a
  // bare percent without a base is asked to be made concrete there instead.
  if (mode === "autonomous" && user) {
    const raw = await vaultBalance(user, tokenIn.address);
    const base = Number(formatUnits(raw, tokenIn.decimals));
    const amount = (base * percent) / 100;
    return amount.toString();
  }

  throw new Error(
    "A percentage of your balance can only be resolved once a wallet is connected.",
  );
}

/**
 * Read a command, store it, and return an interpretation plus, when the intent
 * is a concrete market swap, a live quote. This is the first hop for both modes;
 * it decides nothing irreversible.
 */
export async function interpretCommand(params: {
  user?: `0x${string}`;
  mode: Mode;
  command: string;
}): Promise<InterpretResult> {
  const id = randomUUID();

  await q(
    `INSERT INTO intents (id, user_address, mode, command, status)
     VALUES ($1, $2, $3, $4, 'interpreting')`,
    [id, params.user ?? "", params.mode, params.command],
  );

  const context = await buildContext();
  let interp: Interpretation;
  try {
    interp = await interpret(id, params.command, context);
  } catch (err) {
    await setStatus(id, "failed", { error: (err as Error).message });
    throw err;
  }

  if (!interp.ok) {
    await q(
      `UPDATE intents SET status='rejected', kind=$2, reason=$3, error=$4,
         interpretation=$5, updated_at=now() WHERE id=$1`,
      [id, interp.kind, interp.reason, interp.error, JSON.stringify(interp)],
    );
    return {
      id,
      interpretation: interp,
      message: interp.error || "That did not read as a trade Roque can make.",
    };
  }

  const tokenIn = tokenBySymbol(interp.tokenIn);
  const tokenOut = tokenBySymbol(interp.tokenOut);
  if (!tokenIn || !tokenOut) {
    await setStatus(id, "rejected", { error: "interpreter named an unknown token" });
    return {
      id,
      interpretation: interp,
      message: "That names a token Roque does not trade.",
    };
  }

  // Persist the parsed fields regardless of kind, so history is complete.
  await q(
    `UPDATE intents SET status='ready', kind=$2, token_in=$3, token_out=$4,
       amount=$5, amount_is_percent=$6, trigger_price=$7, trigger_above=$8,
       confidence=$9, reason=$10, interpretation=$11, updated_at=now() WHERE id=$1`,
    [
      id,
      interp.kind,
      interp.tokenIn,
      interp.tokenOut,
      interp.amount,
      interp.amountIsPercent,
      interp.triggerPrice || null,
      interp.triggerAbove,
      interp.confidence,
      interp.reason,
      JSON.stringify(interp),
    ],
  );

  // A quote only makes sense for a market swap; a limit order quotes at fill
  // time, not now. We still preview the notional for a limit using its amount.
  let quote: InterpretResult["quote"];
  try {
    if (!interp.amountIsPercent) {
      const quoted = await quoteSwap(interp.tokenIn, interp.tokenOut, interp.amount);
      // Value the input side in dollars off its own Chainlink feed, exactly the
      // way the executor will, so the preview and the on-chain cap agree.
      const unitUsd = await tokenUsd(interp.tokenIn);
      const usd = Number(interp.amount) * unitUsd;
      quote = {
        tokenIn: interp.tokenIn,
        tokenOut: interp.tokenOut,
        amountIn: quoted.amountIn,
        amountOut: quoted.amountOut,
        price: quoted.price,
        usdValue: usd,
      };
    }
  } catch {
    // A missing quote is not fatal to interpretation; the sign step will quote
    // again and fail loudly there if the pool truly cannot serve the trade.
  }

  return {
    id,
    interpretation: interp,
    quote,
    message: interp.reason || "Ready when you are.",
  };
}

/**
 * Build the small context bag the interpreter may use as a hint. It can never
 * widen the token set; it just helps the model read numbers and sides correctly.
 */
async function buildContext(): Promise<Record<string, unknown>> {
  try {
    const price = await ethUsd();
    return { ethUsd: price.usd, tokens: tokenSymbols };
  } catch {
    return { tokens: tokenSymbols };
  }
}

/**
 * Prepare an unsigned swap for copilot mode: the user signs and sends this from
 * their own wallet, so we hand back the exact router arguments and a fresh quote
 * with the slippage floor already computed. No agent signature is involved.
 */
export async function prepareCopilotSwap(params: {
  id?: string;
  fromSymbol: string;
  toSymbol: string;
  amount: string;
  slippageBps: number;
}): Promise<{
  router: `0x${string}`;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountInRaw: string;
  minAmountOutRaw: string;
  amountOut: string;
}> {
  const quoted = await quoteSwap(params.fromSymbol, params.toSymbol, params.amount);
  const minOut = minOutForSlippage(quoted.amountOutRaw, params.slippageBps);
  return {
    router: addresses.router,
    tokenIn: quoted.tokenIn,
    tokenOut: quoted.tokenOut,
    amountInRaw: quoted.amountInRaw.toString(),
    minAmountOutRaw: minOut.toString(),
    amountOut: quoted.amountOut,
  };
}

/**
 * Autonomous mode. Turn a ready interpretation into an agent-signed intent and
 * submit it to Sepolia. Every hard limit is enforced on-chain in the executor;
 * here we do the friendly pre-checks so a doomed submission fails with a clear
 * message instead of an opaque revert, and we never sign what the capability
 * plainly forbids.
 */
export async function executeAutonomous(params: {
  id: string;
  user: `0x${string}`;
  slippageBps: number;
}): Promise<{ txHash: `0x${string}`; kind: "swap" | "limit" }> {
  const rows = await q<Record<string, unknown>>(`SELECT * FROM intents WHERE id=$1`, [
    params.id,
  ]);
  const record = rows[0];
  if (!record) throw new Error("No such intent.");

  const interp = record.interpretation as Interpretation;
  if (!interp || !interp.ok) throw new Error("That intent is not something I can act on.");

  const tokenIn = tokenBySymbol(interp.tokenIn);
  const tokenOut = tokenBySymbol(interp.tokenOut);
  if (!tokenIn || !tokenOut) throw new Error("Unknown token in intent.");

  // The capability must exist, be live, and name our agent signer. Reading it
  // first lets us refuse politely rather than burn gas on a sure revert.
  const cap = await getCapability(params.user);
  if (!cap) throw new Error("You have not granted the agent a capability yet.");
  if (cap.revoked) throw new Error("Your agent capability is revoked.");
  if (cap.agentSigner.toLowerCase() !== agentSignerAddress().toLowerCase()) {
    throw new Error("Your capability names a different agent signer.");
  }

  const amountStr = await resolveAmount(interp, tokenIn, params.user, "autonomous");
  const amountInRaw = parseUnits(amountStr, tokenIn.decimals);

  // Enough vaulted funds to cover it.
  const bal = await vaultBalance(params.user, tokenIn.address);
  if (bal < amountInRaw) {
    throw new Error(
      `Your vault holds ${formatUnits(bal, tokenIn.decimals)} ${tokenIn.symbol}, which is short of this trade.`,
    );
  }

  const quoted = await quoteSwap(interp.tokenIn, interp.tokenOut, amountStr);
  const minOut = minOutForSlippage(
    quoted.amountOutRaw,
    Math.min(params.slippageBps, Number(cap.maxSlippageBps)),
  );
  const now = Math.floor(Date.now() / 1000);
  const nonce = await freshNonce(params.user);

  if (interp.kind === "limit") {
    const price = interp.triggerPrice ? Number(interp.triggerPrice) : (await ethUsd()).usd;
    const intent: LimitIntent = {
      user: params.user,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountInRaw,
      minAmountOut: minOut,
      triggerPrice: toTriggerPrice(price),
      triggerAbove: interp.triggerAbove,
      expiry: BigInt(now + LIMIT_EXPIRY_SECONDS),
      nonce,
      deadline: BigInt(now + INTENT_TTL_SECONDS),
    };
    const sig = await signLimitIntent(intent);
    const txHash = await submitLimitOrder(intent, sig);
    await setStatus(params.id, "submitted", { tx_hash: txHash });
    return { txHash, kind: "limit" };
  }

  const intent: SwapIntent = {
    user: params.user,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn: amountInRaw,
    minAmountOut: minOut,
    nonce,
    deadline: BigInt(now + INTENT_TTL_SECONDS),
  };
  const sig = await signSwapIntent(intent);
  const txHash = await submitSwap(intent, sig);
  await setStatus(params.id, "submitted", { tx_hash: txHash });
  return { txHash, kind: "swap" };
}

/** Mark an intent's status, optionally stamping a tx hash or error. */
export async function setStatus(
  id: string,
  status: string,
  extra: { tx_hash?: string; error?: string } = {},
): Promise<void> {
  await q(
    `UPDATE intents SET status=$2, tx_hash=COALESCE($3, tx_hash),
       error=COALESCE($4, error), updated_at=now() WHERE id=$1`,
    [id, status, extra.tx_hash ?? null, extra.error ?? null],
  );
}

/** Record that a copilot transaction the user sent has been broadcast. */
export async function attachTxHash(id: string, txHash: string): Promise<void> {
  await setStatus(id, "submitted", { tx_hash: txHash });
}

/** The recent intent history for a user, newest first. */
export async function intentHistory(user: string, limit = 25) {
  return q(
    `SELECT id, mode, command, status, kind, token_in, token_out, amount,
            reason, error, tx_hash, created_at
       FROM intents WHERE LOWER(user_address)=LOWER($1) ORDER BY created_at DESC LIMIT $2`,
    [user, limit],
  );
}

/** The recent on-chain trade history for a user, newest first. */
export async function tradeHistory(user: string, limit = 25) {
  return q(
    `SELECT kind, token_in, token_out, amount_in, amount_out, usd_value,
            order_id, price, tx_hash, block_number, block_time
       FROM trades WHERE LOWER(user_address)=LOWER($1) ORDER BY block_number DESC LIMIT $2`,
    [user, limit],
  );
}
