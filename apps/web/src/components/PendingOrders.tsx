"use client";

/**
 * The orders still resting on-chain, read live from the OrderBook rather than any
 * cached notebook. Both surfaces land here: an order the agent opened in autonomous
 * and one a person placed in copilot both belong to the same wallet, so both show
 * up, each tagged with the mode that made it. Every order carries one action, a
 * cancel the user signs from their own wallet, which returns the escrow to them.
 */

import { useState } from "react";
import { Hourglass, Bot, Hand, TrendingUp, TrendingDown, X } from "lucide-react";
import type { OpenOrder } from "@/lib/types";
import { useAppData } from "@/providers/AppData";
import { useWallet } from "@/lib/useWallet";
import { cancelLimitOrder } from "@/lib/chain";
import { formatAmount, formatPrice, formatDuration } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";
import { useToast } from "./Toaster";

const EXPLORER_TX = "https://sepolia.etherscan.io/tx/";

/** A short, human note on how long an order has left, or that it never expires. */
function expiryLabel(order: OpenOrder): string {
  if (order.expiry === 0) return "No expiry";
  if (order.expired) return "Expired";
  const left = order.expiry - Math.floor(Date.now() / 1000);
  return `Expires in ${formatDuration(left)}`;
}

function ModeChip({ mode }: { mode: OpenOrder["mode"] }) {
  if (mode === "autonomous") {
    return (
      <span className="order-mode mode-autonomous" title="Placed by Roque in autonomous mode">
        <Bot size={12} />
        Autonomous
      </span>
    );
  }
  if (mode === "copilot") {
    return (
      <span className="order-mode mode-copilot" title="Placed by you in copilot mode">
        <Hand size={12} />
        Copilot
      </span>
    );
  }
  return (
    <span className="order-mode mode-unknown" title="Mode could not be matched yet">
      Order
    </span>
  );
}

export function PendingOrders() {
  const { orders, refreshAll } = useAppData();
  const wallet = useWallet();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const list = orders.data?.orders ?? [];

  const cancel = async (order: OpenOrder) => {
    if (busyId) return;
    if (!wallet.connected) {
      wallet.login();
      return;
    }
    setBusyId(order.id);
    const pending = toast.push({
      kind: "pending",
      title: "Cancelling order",
      detail: "Approve the cancel in your wallet to reclaim the escrow.",
    });
    try {
      const { client, address } = await wallet.getClient();
      const hash = await cancelLimitOrder(client, address, order.id);
      toast.dismiss(pending);
      toast.success("Order cancelled", "Your escrow is back in your wallet.", {
        href: `${EXPLORER_TX}${hash}`,
      });
      refreshAll();
    } catch (err) {
      toast.dismiss(pending);
      const message = (err as Error).message || "That did not go through.";
      if (/rejected|denied|declined|user cancel/iu.test(message)) {
        toast.info("Left as is", "You waved off the cancel. The order is still resting.");
      } else {
        toast.error("Could not cancel that order", message);
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel card orders-panel">
      <header className="panel-head">
        <h3 className="panel-title">Pending orders</h3>
        {list.length > 0 ? <span className="orders-count tabular">{list.length}</span> : null}
      </header>

      <div className="orders-body">
        {orders.loading && !orders.data ? (
          <div className="feed-loading">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton" style={{ height: 72 }} />
            ))}
          </div>
        ) : list.length === 0 ? (
          <p className="feed-empty">No resting orders. A limit order you place shows up here until it fills or you cancel it.</p>
        ) : (
          <ul className="orders-list">
            {list.map((order) => (
              <li key={order.id} className="order-row animate-fade">
                <div className="order-row-top">
                  <ModeChip mode={order.mode} />
                  <span className={`order-expiry ${order.expired ? "is-expired" : ""}`}>
                    <Hourglass size={11} />
                    {expiryLabel(order)}
                  </span>
                </div>

                <div className="order-pair">
                  <TokenIcon symbol={order.tokenInSymbol} size={22} />
                  <span className="order-pair-text tabular">
                    {formatAmount(order.amountIn)} {order.tokenInSymbol}
                  </span>
                  <span className="order-pair-arrow">→</span>
                  <TokenIcon symbol={order.tokenOutSymbol} size={22} />
                  <span className="order-pair-text">{order.tokenOutSymbol}</span>
                </div>

                <div className="order-row-foot">
                  <span className="order-trigger tabular">
                    {order.triggerAbove ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    ETH {order.triggerAbove ? "≥" : "≤"} ${formatPrice(Number(order.triggerPrice))}
                  </span>
                  <button
                    className="order-cancel"
                    onClick={() => cancel(order)}
                    disabled={busyId === order.id}
                  >
                    {busyId === order.id ? (
                      <>
                        <span className="spinner" />
                        Cancelling
                      </>
                    ) : (
                      <>
                        <X size={13} />
                        Cancel
                      </>
                    )}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
