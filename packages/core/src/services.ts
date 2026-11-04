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

import {percentageOf} from "./validation.js";
import { verifyWalletTrade, type WalletTrade } from "./settlement.js";
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
import { ethUsd, tokenUsd, toTriggerPrice, usdValueRaw } from "./prices.js";
import {
  signSwapIntent,
  signLimitIntent,
  submitSwap,
  submitLimitOrder,
  freshNonce,
  agentSignerAddress,
  getCapability,
  getCommitment,
  lockedBalance,
  vaultBalance,
  remainingDailyUsd,
  NO_COMMITMENT,
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
    // Free money only. "All of my rUSDC" from the chat cannot mean the part an
    // armed event order is standing on, because the executor would refuse it.
    const [raw, locked] = await Promise.all([
      vaultBalance(user, tokenIn.address),
      lockedBalance(user, tokenIn.address),
    ]);
    const free = raw > locked ? raw - locked : 0n;
    return formatUnits(percentageOf(free,interp.amount),tokenIn.decimals);
  }

  throw new Error(
    "A percentage of your balance can only be resolved once a wallet is connected.",
  );
}

/**
 * Render a float as a decimal string `parseUnits` will accept. Plain
 * `Number.prototype.toString` switches to exponent form for small values, and
 * `parseUnits("1e-7")` throws, so a percentage of a small balance would blow up
 * at the worst possible moment. Fixing the notation and trimming the tail keeps
 * the value exact to the token's own precision.
 */
function humanAmount(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("That works out to an amount too small to trade.");
  }
  const trimmed = value.toFixed(Math.min(decimals, 18)).replace(/0+$/u, "").replace(/\.$/u, "");
  if (trimmed === "" || Number(trimmed) === 0) {
    throw new Error("That works out to an amount too small to trade.");
  }
  return trimmed;
}

/** Everything a vault swap needs, once it has been proved allowed. */
export interface VaultSwapPlan {
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amount: string;
  amountInRaw: bigint;
  minOut: bigint;
  usdValue: bigint;
  slippageBps: number;
  /** The commitment this trade fulfils, or NO_COMMITMENT for a plain trade. */
  commitmentId: `0x${string}`;
}

/**
 * Prove a vault swap is allowed before anything is signed, and return the exact
 * numbers to sign. Every rule here is one the AgentExecutor enforces anyway, so
 * this adds no authority; what it adds is a readable sentence instead of an
 * opaque "execution reverted", and, for the background workers, the ability to
 * skip a fill that was certain to fail rather than pay gas to discover that.
 *
 * Anything that acts on a user's vault goes through here: the autonomous path a
 * person drives, and the event orders and playbooks the keeper drives. One gate
 * means the caps, the slippage ceiling and the signer check cannot drift apart
 * between the paths that a person watches and the paths that run unattended.
 */
export async function preflightVaultSwap(params: {
  user: `0x${string}`;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amount: string;
  amountIsPercent?: boolean;
  slippageBps: number;
  /** Set when this trade is the fulfilment of a commitment it may spend. */
  commitmentId?: `0x${string}`;
}): Promise<VaultSwapPlan> {
  const { user, tokenIn, tokenOut } = params;
  const commitmentId = params.commitmentId ?? NO_COMMITMENT;

  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) {
    throw new Error("A trade needs two different tokens.");
  }

  // The capability must exist, be live, and name our agent signer. Reading it
  // first lets us refuse politely rather than burn gas on a sure revert.
  const cap = await getCapability(user);
  if (!cap) throw new Error("You have not granted the agent a capability yet.");
  if (cap.revoked) throw new Error("Your agent capability is revoked.");
  if (cap.agentSigner.toLowerCase() !== agentSignerAddress().toLowerCase()) {
    throw new Error("Your capability names a different agent signer.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(cap.validUntil) <= now) {
    throw new Error("Your agent capability has expired.");
  }

  // What this particular trade may spend, which is not the same as the balance.
  // Part of a vault can be committed to orders that have not fired, and the
  // executor will refuse to move that part for anything else. A trade standing
  // on its own gets the free half. A trade fulfilling a commitment gets the free
  // half plus its own hold, which is exactly the rule the contract applies, so
  // the sentence here and the on-chain refusal cannot disagree.
  const [bal, locked] = await Promise.all([
    vaultBalance(user, tokenIn.address),
    lockedBalance(user, tokenIn.address),
  ]);
  let ownHold = 0n;
  if (commitmentId !== NO_COMMITMENT) {
    const commitment = await getCommitment(commitmentId);
    if (
      !commitment.active ||
      commitment.user.toLowerCase() !== user.toLowerCase() ||
      commitment.token.toLowerCase() !== tokenIn.address.toLowerCase()
    ) {
      throw new Error("The hold behind this order is gone, so it cannot spend it.");
    }
    ownHold = commitment.amount;
  }
  const free = bal > locked ? bal - locked : 0n;
  const spendable = free + ownHold;

  let amount = params.amount;
  if (params.amountIsPercent) {
    const percent = Number(params.amount);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      throw new Error("A percentage amount has to be between 0 and 100.");
    }
    amount = formatUnits(percentageOf(spendable,params.amount),tokenIn.decimals);
  }

  const amountInRaw = parseUnits(amount, tokenIn.decimals);
  if (amountInRaw <= 0n) throw new Error("That amount is too small to trade.");
  if (spendable < amountInRaw) {
    const committed = locked - ownHold;
    const because =
      committed > 0n
        ? ` ${formatUnits(committed, tokenIn.decimals)} of it is committed to orders that have not fired yet.`
        : "";
    throw new Error(
      `Your vault has ${formatUnits(spendable, tokenIn.decimals)} ${tokenIn.symbol} free, which is short of this trade.${because}`,
    );
  }

  // The two dollar ceilings, in the order the contract applies them.
  const usdValue = await usdValueRaw(tokenIn.address, amountInRaw);
  if (usdValue > cap.maxPerTradeUsd) {
    throw new Error(
      `This trade ($${Number(formatUnits(usdValue, 18)).toFixed(2)}) exceeds your per-trade limit of $${Number(formatUnits(cap.maxPerTradeUsd, 18)).toFixed(2)}.`,
    );
  }
  const remaining = await remainingDailyUsd(user);
  if (usdValue > remaining) {
    throw new Error(
      `This trade ($${Number(formatUnits(usdValue, 18)).toFixed(2)}) exceeds the $${Number(formatUnits(remaining, 18)).toFixed(2)} left on your daily limit.`,
    );
  }

  // The user's slippage preference never loosens the ceiling they granted.
  const slippageBps = Math.min(params.slippageBps, Number(cap.maxSlippageBps));
  const quoted = await quoteSwap(tokenIn.symbol, tokenOut.symbol, amount);
  const minOut = minOutForSlippage(quoted.amountOutRaw, slippageBps);

  return { tokenIn, tokenOut, amount, amountInRaw, minOut, usdValue, slippageBps, commitmentId };
}

/**
 * Sign and submit a plan that `preflightVaultSwap` already cleared. Split from
 * the preflight so a caller can hold a claim, a database row or a step cursor
 * between proving a trade allowed and actually sending it.
 */
export async function executeVaultSwap(
  user: `0x${string}`,
  plan: VaultSwapPlan,
  operationId?:string,
): Promise<`0x${string}`> {
  const intent: SwapIntent = {
    user,
    tokenIn: plan.tokenIn.address,
    tokenOut: plan.tokenOut.address,
    amountIn: plan.amountInRaw,
    minAmountOut: plan.minOut,
    // Naming the commitment is what lets this trade reach the money the order
    // set aside, and what ends the hold in the same transaction that spends it.
    commitmentId: plan.commitmentId,
    nonce: await freshNonce(user),
    deadline: BigInt(Math.floor(Date.now() / 1000) + INTENT_TTL_SECONDS),
  };
  return submitSwap(intent, await signSwapIntent(intent),operationId);
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
  user: `0x${string}`;
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
  if (params.id) {
    const stored = await q(`UPDATE intents SET prepared_plan=$3::jsonb, updated_at=now()
      WHERE id=$1 AND LOWER(user_address)=LOWER($2) AND mode='copilot' AND status='ready' RETURNING id`,
      [params.id, params.user, JSON.stringify({tokenIn:quoted.tokenIn.address,tokenOut:quoted.tokenOut.address,
       amountInRaw:quoted.amountInRaw.toString(),minAmountOutRaw:minOut.toString(),recipient:params.user})]);
    if(stored.length!==1) throw new Error("Intent is inaccessible or no longer ready.");
  }
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

  const storedOwner = String(record.user_address ?? "");
  if (
    record.mode !== "autonomous" ||
    storedOwner.toLowerCase() !== params.user.toLowerCase()
  ) {
    throw new Error("That intent does not belong to this vault owner.");
  }

  const interp = record.interpretation as Interpretation;
  if (!interp || !interp.ok) throw new Error("That intent is not something I can act on.");

  const tokenIn = tokenBySymbol(interp.tokenIn);
  const tokenOut = tokenBySymbol(interp.tokenOut);
  if (!tokenIn || !tokenOut) throw new Error("Unknown token in intent.");

  // The percentage base is resolved here, against the interpretation, before the
  // shared gate sees a concrete figure.
  const { amountInRaw, minOut } = await preflightVaultSwap({
    user: params.user,
    tokenIn,
    tokenOut,
    amount: await resolveAmount(interp, tokenIn, params.user, "autonomous"),
    slippageBps: params.slippageBps,
  });
  const now = Math.floor(Date.now() / 1000);
  const nonce = await freshNonce(params.user);

  // Claim the persisted intent exactly once after all friendly pre-checks and
  // immediately before constructing and signing it. The conditional update is
  // the concurrency gate: two requests may do the reads above, but only one can
  // move this record from ready to signed.
  const claimed = await q<{ id: string }>(
    `UPDATE intents SET status='signed', updated_at=now()
       WHERE id=$1 AND LOWER(user_address)=LOWER($2)
         AND mode='autonomous' AND status='ready'
       RETURNING id`,
    [params.id, params.user],
  );
  if (claimed.length !== 1) {
    throw new Error("That intent has already been executed or is being processed.");
  }

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
      // A trade the person asked for now stands on its own, so it may only
      // reach free vault money. This is the hole the on-chain hold closes:
      // spending committed rUSDC here and withdrawing the rWETH it bought used
      // to be the way around a lock that only knew about rUSDC.
      commitmentId: NO_COMMITMENT,
      nonce,
      deadline: BigInt(now + INTENT_TTL_SECONDS),
    };
    const sig = await signLimitIntent(intent);
    const txHash = await submitLimitOrder(intent, sig,`intent:${params.id}`);
    await setStatus(params.id, "submitted", { tx_hash: txHash });
    return { txHash, kind: "limit" };
  }

  const intent: SwapIntent = {
    user: params.user,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn: amountInRaw,
    minAmountOut: minOut,
    commitmentId: NO_COMMITMENT,
    nonce,
    deadline: BigInt(now + INTENT_TTL_SECONDS),
  };
  const sig = await signSwapIntent(intent);
  const txHash = await submitSwap(intent, sig,`intent:${params.id}`);
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
export async function attachTxHash(id: string, txHash: string, owner: `0x${string}`): Promise<void> {
  const rows=await q<{prepared_plan: WalletTrade;tx_hash:string|null;status:string}>(
    "SELECT prepared_plan,tx_hash,status FROM intents WHERE id=$1 AND LOWER(user_address)=LOWER($2) AND mode='copilot'",[id,owner]);
  const record=rows[0];
  if(!record?.prepared_plan || !["ready","submitted","confirmed"].includes(record.status) || (record.tx_hash && record.tx_hash!==txHash))
    throw new Error("Intent is inaccessible, unprepared or already reported.");
  const settlement = await verifyWalletTrade(txHash as `0x${string}`,owner,record.prepared_plan);
  const saved=await q(`UPDATE intents SET tx_hash=$3,status=$4,updated_at=now()
    WHERE id=$1 AND LOWER(user_address)=LOWER($2) AND mode='copilot' AND status IN ('ready','submitted','confirmed')
      AND (tx_hash IS NULL OR tx_hash=$3) RETURNING id`,[id,owner,txHash,settlement.status === "confirmed" ? "confirmed" : "submitted"]);
  if(saved.length!==1) throw new Error("Conflicting transaction report.");
}

/** The recent intent history for a user, newest first. */
export async function intentHistory(user: string, limit = 25) {
  return q(
    `SELECT id, mode, command, status, kind, token_in, token_out, amount,
            amount_is_percent, reason, error, tx_hash, created_at
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
