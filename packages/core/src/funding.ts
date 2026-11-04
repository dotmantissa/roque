/**
 * Can the vault actually pay for this?
 *
 * Every unattended trade Roque makes, an event order that fires or a playbook
 * rung that comes due, spends from `AgentExecutor.vaultBalance[user][token]`
 * and from nowhere else. The connected wallet is not touched, because the agent
 * has no authority over it. That is a good property right up until someone
 * writes an order against money the agent cannot reach, at which point the
 * order is not resting, it is broken: it arms, it waits, the condition comes
 * true, and the fill fails on a balance check the person was never shown.
 *
 * `preflightVaultSwap` already refuses that fill. This module moves the same
 * refusal forward to the moment the person signs, which is the only moment they
 * can do anything about it. The rule is deliberately the narrow one the user
 * asked for: enough for *that* trade, judged per leg, not a portfolio model.
 *
 * What the balance means is the subtle part. A vault balance is not the same as
 * spendable money once orders can rest for a fortnight: an armed event order has
 * already promised part of it. So the figure this gate compares against is the
 * balance minus what the executor is holding for commitments, which is what
 * stops one deposit from backing two orders that each believe they can spend it.
 *
 * That subtraction used to be a sum over a table, and the table was advisory.
 * It is `AgentExecutor.lockedBalance` now, which is the same number the contract
 * will refuse a withdrawal or an unrelated trade against. So this gate and the
 * on-chain refusal cannot drift apart: being short here means being short there.
 *
 * The arithmetic is pure and the chain read is one thin wrapper over it, so the
 * interesting part, which legs the vault is even on the hook for, is testable
 * without a node.
 */

import { formatUnits, parseUnits } from "viem";
import { tokenBySymbol, type TokenMeta } from "@roque/shared";
import { vaultSnapshot } from "./intents.js";

/**
 * One trade's claim on the vault. `where` names it in the refusal: a standalone
 * event order calls itself "This order", a playbook rung calls itself "Step 2".
 */
export interface FundingLeg {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent?: boolean;
  where: string;
}

/** What one token owes across every leg that draws it from the vault. */
export interface FundingNeed {
  symbol: string;
  /** Absolute units the vault must already hold, summed across legs. */
  raw: bigint;
  /** True when some leg spends a percentage, which needs a non-zero balance. */
  needsSome: boolean;
  /** The `where` labels of the legs that put this token on the hook. */
  where: string[];
}

function requireToken(symbol: string): TokenMeta {
  const token = tokenBySymbol(symbol);
  if (!token) throw new Error(`Unknown token ${symbol}.`);
  return token;
}

/**
 * Work out what the vault has to be holding *now* for a list of legs to be
 * payable, in the order they will run.
 *
 * The subtlety is the second rung of a ladder. "Buy rWETH with rUSDC, then sell
 * that rWETH back" is a perfectly good plan to write while holding no rWETH at
 * all, because the first rung is what creates it. So a leg whose input token an
 * earlier leg produces is not the vault's problem and is skipped. Everything
 * else is: two rungs that each spend 100 rUSDC straight from the vault need 200
 * sitting there, not 100 twice.
 *
 * A percentage leg cannot be summed, since its size is decided at fire time
 * against whatever the balance is then, so all it asks is that the balance not be
 * zero, since a percentage of nothing is nothing.
 */
export function vaultFundingNeeds(legs: FundingLeg[]): FundingNeed[] {
  const produced = new Set<string>();
  const needs = new Map<string, FundingNeed>();

  for (const leg of legs) {
    const tokenIn = requireToken(leg.tokenIn);
    const tokenOut = requireToken(leg.tokenOut);

    if (!produced.has(tokenIn.symbol) || !leg.amountIsPercent) {
      let need = needs.get(tokenIn.symbol);
      if (!need) {
        need = { symbol: tokenIn.symbol, raw: 0n, needsSome: false, where: [] };
        needs.set(tokenIn.symbol, need);
      }
      if (leg.amountIsPercent) {
        need.needsSome = true;
      } else {
        need.raw += parseUnits(leg.amount, tokenIn.decimals);
      }
      if (!need.where.includes(leg.where)) need.where.push(leg.where);
    }

    produced.add(tokenOut.symbol);
  }

  return [...needs.values()];
}

/**
 * The sentence a person reads when their vault is short.
 *
 * `free` is what is actually spendable and `hold` is what resting orders have
 * already promised. When something is held the sentence says so, because "your
 * vault holds 600" is confusing to somebody looking at a balance of 1,000, and
 * the missing 400 needs naming, along with how to get it back.
 */
function shortfall(
  need: FundingNeed,
  free: bigint,
  token: TokenMeta,
  hold: bigint,
): string {
  const who = need.where.join(" and ");
  const have = formatUnits(free, token.decimals);
  const because =
    hold > 0n
      ? ` ${formatUnits(hold, token.decimals)} ${token.symbol} is already committed to orders that have not fired yet; cancel one to free it.`
      : "";
  if (need.raw === 0n) {
    return `${who} spends a share of your ${token.symbol}, and your vault has none free. Move some ${token.symbol} into the vault on the autonomous screen first.${because}`;
  }
  return `${who} needs ${formatUnits(need.raw, token.decimals)} ${token.symbol} and your vault has ${have} free. Move the difference into the vault on the autonomous screen, or trade a smaller size.${because}`;
}

/**
 * Refuse the whole thing unless the vault covers every leg that draws on it.
 *
 * Fail closed on purpose. If the balance cannot be read we do not sign, because
 * "we could not check" is not "it is fine", and the cost of being wrong here is
 * an order that looks live and can never fill.
 *
 * It is also no longer the last word. Arming writes an on-chain hold, and the
 * contract applies this same arithmetic before it will take one. This gate just
 * gets there first, with a sentence instead of a revert.
 */
export async function assertVaultFunds(
  user: `0x${string}`,
  legs: FundingLeg[],
): Promise<void> {
  const needs = vaultFundingNeeds(legs);
  if (needs.length === 0) return;

  // Addresses reach this codebase in whatever case the browser had them in and
  // are lowercased at each boundary that cares. The chain read is such a
  // boundary: viem rejects a mixed-case address that is not a valid checksum,
  // and a funding gate that throws "invalid address" instead of a verdict is
  // worse than no gate.
  //
  // One snapshot rather than a read per needed token. It pulls every token
  // whether or not this order touches them, which sounds wasteful and is not:
  // the whole thing is a single multicall, so the alternative is several round
  // trips to fetch less.
  const owner = user.toLowerCase() as `0x${string}`;
  const snapshot = await vaultSnapshot(owner);

  const problems: string[] = [];
  for (const need of needs) {
    const token = requireToken(need.symbol);
    const state = snapshot.get(token.symbol) ?? { balance: 0n, locked: 0n, available: 0n };
    // Money already promised to a resting order is not money this one can
    // spend. The executor floors this the same way, for the same reason: a
    // negative figure would read as a credit.
    if (state.available < need.raw || (need.needsSome && state.available === 0n)) {
      problems.push(shortfall(need, state.available, token, state.locked));
    }
  }

  if (problems.length > 0) throw new Error(problems.join(" · "));
}
