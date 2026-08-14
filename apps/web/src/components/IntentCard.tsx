"use client";

/**
 * One turn of the conversation, made concrete. The interpreter has already read
 * the person's words into a structured intent; this card shows them exactly what
 * that means as a trade, quotes it against the live pool, and offers the one
 * button that fits the mode. In copilot mode that button asks their own wallet to
 * sign; in autonomous mode it hands the intent to Roque, who signs within the
 * capability they granted. A trade the interpreter could not make shows up here
 * too, as a plain, unbothered refusal rather than a dead end.
 */
import { useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleSlash,
  LineChart,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { InterpretResult, Mode, SettleState } from "@/lib/types";
import { useWallet } from "@/lib/useWallet";
import { useToast } from "./Toaster";
import { api } from "@/lib/api";
import { walletBalances, copilotSwap, copilotLimitOrder } from "@/lib/chain";
import { resolveConcreteAmount, buildLimitOrder } from "@/lib/orders";
import { formatAmount, formatUsd, formatPrice } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";
import { ChartModal } from "./ChartModal";

const EXPLORER = "https://sepolia.etherscan.io/tx/";

function isRejection(message: string): boolean {
  return /rejected|denied|declined|user cancel/iu.test(message);
}

export function IntentCard({
  result,
  mode,
  ethUsd,
  balances,
  prices,
  canAutonomous,
  slippageBps,
  settleState,
  txHash,
  onSettle,
  onSettled,
}: {
  result: InterpretResult;
  mode: Mode;
  ethUsd: number;
  balances: Record<string, number> | null;
  prices: Record<string, number>;
  canAutonomous: boolean;
  slippageBps: number;
  settleState: SettleState;
  txHash: string | null;
  onSettle: (patch: { settleState?: SettleState; txHash?: string | null }) => void;
  onSettled?: () => void;
}) {
  const wallet = useWallet();
  const toast = useToast();
  // How far this card has got is owned by the turn in shared app data, not by
  // local state, so a trade that already settled stays settled after the route
  // unmounts and mounts again. This card reads it and reports transitions up.
  const state = settleState;
  // A synchronous latch so a double click in the same tick cannot fire two
  // signatures before the state flips to "working" and the button goes away.
  const runningRef = useRef(false);
  const [chartOpen, setChartOpen] = useState(false);

  const interp = result.interpretation;
  const quote = result.quote;
  const isLimit = interp.kind === "limit";

  // A refusal, or a command that did not read as a trade. No action, no drama.
  if (!interp.ok || interp.kind === "unknown") {
    return (
      <div className="intent-card intent-card-refused animate-rise">
        <div className="intent-refused-icon">
          <CircleSlash size={18} />
        </div>
        <div>
          <p className="intent-refused-title">Roque held off on that one</p>
          <p className="intent-refused-body">{result.message}</p>
        </div>
      </div>
    );
  }

  const concretePreview = (): string | null => {
    if (!interp.amountIsPercent) return interp.amount;
    if (!balances) return null;
    try {
      return resolveConcreteAmount(interp, balances);
    } catch {
      return null;
    }
  };

  const run = async () => {
    if (!wallet.connected || !wallet.address) {
      wallet.login();
      return;
    }
    // Only ever from a standing start. Once it is working, done, or failed the
    // action is spent; the card shows a status instead of a button, and this
    // latch guards the sliver of time before that first render lands.
    if (runningRef.current || state !== "idle") return;
    runningRef.current = true;
    onSettle({ settleState: "working" });
    const pending = toast.push({
      kind: "pending",
      title: mode === "autonomous" ? "Roque is on it" : "Waiting on your wallet",
      detail:
        mode === "autonomous"
          ? "Signing the intent and sending it to Sepolia."
          : "Approve the trade in your wallet to send it.",
    });

    try {
      let hash: string;

      if (mode === "autonomous") {
        const { client } = await wallet.getClient();
        const res = await api.execute(
          { id: result.id, user: wallet.address, slippageBps },
          client,
        );
        hash = res.txHash;
      } else {
        const { client, address } = await wallet.getClient();
        const amount = interp.amountIsPercent
          ? resolveConcreteAmount(interp, balances ?? (await walletBalances(address)))
          : interp.amount;

        if (isLimit) {
          const order = buildLimitOrder(interp, amount, ethUsd, prices, slippageBps);
          hash = await copilotLimitOrder(client, address, order);
        } else {
          const prep = await api.prepareSwap({
            id: result.id,
            from: interp.tokenIn,
            to: interp.tokenOut,
            amount,
            slippageBps,
          });
          hash = await copilotSwap(client, address, {
            router: prep.router,
            tokenIn: prep.tokenIn,
            amountInRaw: prep.amountInRaw,
            tokenOut: prep.tokenOut,
            minAmountOutRaw: prep.minAmountOutRaw,
          });
        }
        await api.confirmSwap(result.id, hash);
      }

      toast.dismiss(pending);
      onSettle({ settleState: "done", txHash: hash });
      toast.success(
        isLimit ? "Order is resting on-chain" : "Trade landed",
        isLimit ? "Roque will fill it the moment your price prints." : "Settled on Sepolia.",
        { href: `${EXPLORER}${hash}` },
      );
      onSettled?.();
    } catch (err) {
      toast.dismiss(pending);
      const message = (err as Error).message || "That did not go through.";
      if (isRejection(message)) {
        // A wallet rejection is not a signature: nothing was sent, so the trade
        // is still on offer. Fall back to idle so it can be signed once, later.
        onSettle({ settleState: "idle" });
        toast.info("No worries, waved off", "You turned that signature down. Nothing was sent.");
      } else {
        // A real failure after submitting is terminal; the card will not offer
        // to sign the same intent a second time.
        onSettle({ settleState: "failed" });
        toast.error("That trade did not go through", message);
      }
    } finally {
      runningRef.current = false;
    }
  };
  const preview = concretePreview();
  const outLabel = interp.tokenOut;
  const inLabel = interp.tokenIn;
  const chartPrice = prices[outLabel] ?? (outLabel === "rWETH" ? ethUsd : undefined);

  const actionLabel = (): string => {
    if (mode === "autonomous") return isLimit ? "Let Roque rest this order" : "Let Roque trade this";
    if (!wallet.connected) return "Connect to sign";
    return isLimit ? "Place this order" : "Sign and swap";
  };

  const statusLabel = (): string => {
    if (state === "working") return mode === "autonomous" ? "Roque is trading…" : "Submitting…";
    if (state === "done") return isLimit ? "Order placed" : "Trade done";
    return "Didn't go through";
  };

  // The button only exists in the idle state; a percent trade still needs a
  // resolvable base, and autonomous still needs a live capability.
  const idleDisabled =
    (mode === "autonomous" && !canAutonomous) ||
    (interp.amountIsPercent && !preview && wallet.connected);

  return (
    <div className="intent-card animate-rise">
      <div className="intent-head">
        <span className={`intent-kind intent-kind-${isLimit ? "limit" : "swap"}`}>
          {isLimit ? <TrendingUp size={13} /> : <Sparkles size={13} />}
          {isLimit ? "Limit order" : "Market swap"}
        </span>
        <span className={`intent-confidence conf-${interp.confidence}`}>
          {interp.confidence} confidence
        </span>
        {chartPrice && chartPrice > 0 ? (
          <button
            type="button"
            className="intent-chart-btn"
            onClick={() => setChartOpen(true)}
            aria-label={`View ${outLabel} USD price chart`}
          >
            <LineChart size={13} />
            View Chart
          </button>
        ) : null}
      </div>

      <div className="intent-flow">
        <div className="intent-leg">
          <TokenIcon symbol={inLabel} size={30} />
          <div className="intent-leg-text">
            <span className="intent-leg-amount tabular">
              {preview ? formatAmount(preview) : interp.amountIsPercent ? `${interp.amount}%` : formatAmount(interp.amount)}
            </span>
            <span className="intent-leg-symbol">{inLabel}</span>
          </div>
        </div>

        <div className="intent-arrow">
          <ArrowRight size={20} />
        </div>

        <div className="intent-leg intent-leg-out">
          <TokenIcon symbol={outLabel} size={30} />
          <div className="intent-leg-text">
            <span className="intent-leg-amount tabular">
              {quote ? formatAmount(quote.amountOut) : "market"}
            </span>
            <span className="intent-leg-symbol">{outLabel}</span>
          </div>
        </div>
      </div>

      {isLimit ? (
        <div className="intent-trigger">
          {interp.triggerAbove ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          <span>
            Fires when ETH is {interp.triggerAbove ? "at or above" : "at or below"}{" "}
            <strong className="tabular">${formatPrice(Number(interp.triggerPrice) || ethUsd)}</strong>
          </span>
        </div>
      ) : quote ? (
        <div className="intent-quote">
          <span className="intent-quote-cell">
            <span className="intent-quote-label">Rate</span>
            <span className="tabular">1 {inLabel} = {formatAmount(quote.price)} {outLabel}</span>
          </span>
          <span className="intent-quote-divider" />
          <span className="intent-quote-cell">
            <span className="intent-quote-label">Notional</span>
            <span className="tabular">{formatUsd(quote.usdValue)}</span>
          </span>
          <span className="intent-quote-divider" />
          <span className="intent-quote-cell">
            <span className="intent-quote-label">Max slippage</span>
            <span className="tabular">{(slippageBps / 100).toFixed(2)}%</span>
          </span>
        </div>
      ) : null}

      {interp.reason ? <p className="intent-reason">{interp.reason}</p> : null}

      {mode === "autonomous" && !canAutonomous ? (
        <div className="intent-guard">
          <ShieldCheck size={14} />
          Grant Roque a capability first, then it can sign this for you.
        </div>
      ) : null}

      <div className="intent-foot">
        {state === "done" && txHash ? (
          <a
            className="intent-tx"
            href={`${EXPLORER}${txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View on Etherscan
            <ArrowRight size={14} />
          </a>
        ) : (
          <span className="intent-mode-note">
            {mode === "autonomous"
              ? "Roque signs this within your limits"
              : "You sign this from your own wallet"}
          </span>
        )}
        {state === "idle" ? (
          <button className="btn btn-primary intent-action" onClick={run} disabled={idleDisabled}>
            {actionLabel()}
          </button>
        ) : (
          <span className={`intent-status intent-status-${state}`} role="status" aria-live="polite">
            {state === "working" ? <span className="spinner" /> : null}
            {state === "done" ? <Check size={15} /> : null}
            {state === "failed" ? <AlertTriangle size={15} /> : null}
            {statusLabel()}
          </span>
        )}
      </div>

      {chartOpen ? (
        <ChartModal
          pair={`${outLabel}/USD`}
          price={chartPrice ?? 0}
          onClose={() => setChartOpen(false)}
        />
      ) : null}
    </div>
  );
}
