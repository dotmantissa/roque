"use client";

/**
 * The agent's working balance, and only that. In autonomous mode Roque may spend
 * from this vault and nowhere else, so a person decides here exactly how much
 * they are comfortable handing the agent to work with. Money moves in when they
 * deposit and out when they withdraw, both signed by them; the agent can trade
 * what is inside but can never pull more in or take any out. It is a walled
 * garden they hold the only gate to.
 *
 * Depositing is where a person reaches for real numbers, so the panel shows what
 * they actually hold in their wallet for the token they picked, and lets them
 * name the size either in tokens or in dollars. The dollar figure is converted
 * to a token amount against the same Chainlink price the rest of the app quotes,
 * so what they type is what the executor will value it at.
 */

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { ArrowDownToLine, ArrowUpFromLine, Vault, Wallet } from "lucide-react";
import { tokenList, requireToken } from "@roque/shared";
import type { VaultResult } from "@/lib/types";
import { useWallet } from "@/lib/useWallet";
import { useAppData } from "@/providers/AppData";
import { useToast } from "./Toaster";
import { depositToVault, withdrawFromVault } from "@/lib/chain";
import { formatAmount, formatUsd } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";

const EXPLORER = "https://sepolia.etherscan.io/tx/";

// Trim a JS number to a clean decimal string a token contract will accept, never
// showing more fraction digits than the token itself carries.
function trimAmount(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const fixed = value.toFixed(Math.min(decimals, 8));
  return fixed.replace(/\.?0+$/u, "");
}

export function VaultPanel({
  vault,
  loading,
  onSettled,
}: {
  vault: VaultResult | null;
  loading: boolean;
  onSettled: () => void;
}) {
  const wallet = useWallet();
  const toast = useToast();
  const { balances, prices } = useAppData();
  const [token, setToken] = useState<string>(tokenList[0]?.symbol ?? "rUSDC");
  const [denom, setDenom] = useState<"token" | "usd">("token");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);

  const vaultBalances = vault?.balances ?? {};
  const walletBalances = balances.data ?? {};
  const walletBal = Number(walletBalances[token] ?? 0);
  const price = Number(prices[token] ?? 0);

  // The token-denominated amount the buttons act on, derived from what was typed
  // and the unit it was typed in. A dollar figure is divided by the live price.
  const tokenAmountStr = useMemo(() => {
    const raw = amount.trim();
    if (!raw) return "";
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return "";
    if (denom === "token") return raw;
    if (price <= 0) return "";
    const meta = requireToken(token);
    return trimAmount(value / price, meta.decimals);
  }, [amount, denom, price, token]);

  // The same size expressed in the other unit, shown quietly under the field so
  // a person always sees both sides of the conversion before they commit.
  const equiv = useMemo(() => {
    const tokenAmt = Number(tokenAmountStr);
    if (!tokenAmt) return "";
    if (denom === "usd") return `${formatAmount(tokenAmountStr)} ${token}`;
    return price > 0 ? formatUsd(tokenAmt * price) : "price unavailable";
  }, [tokenAmountStr, denom, price, token]);

  // Show a token in the balance strip when it holds something, and always show
  // the one currently selected so the panel never looks empty while you work.
  const shown = useMemo(() => {
    return tokenList.filter(
      (t) => t.symbol === token || Number(vaultBalances[t.symbol] ?? 0) > 0,
    );
  }, [vaultBalances, token]);

  if (!wallet.connected) return null;

  const fillMax = () => {
    if (walletBal <= 0) return;
    const meta = requireToken(token);
    setDenom("token");
    setAmount(trimAmount(walletBal, meta.decimals));
  };

  const move = async (direction: "deposit" | "withdraw") => {
    const human = tokenAmountStr;
    if (!human || Number(human) <= 0) {
      if (denom === "usd" && price <= 0) {
        toast.info("No live price yet", "Switch to token units, or try again in a moment.");
      } else {
        toast.info("Name an amount first", "How much should move?");
      }
      return;
    }
    setBusy(direction);
    const verb = direction === "deposit" ? "Depositing" : "Withdrawing";
    const pending = toast.push({
      kind: "pending",
      title: `${verb} ${formatAmount(human)} ${token}`,
      detail: "Approve it in your wallet.",
    });
    try {
      const meta = requireToken(token);
      const { client, address } = await wallet.getClient();
      const raw = parseUnits(human, meta.decimals);
      const hash =
        direction === "deposit"
          ? await depositToVault(client, address, meta.address, raw)
          : await withdrawFromVault(client, address, meta.address, raw);
      toast.dismiss(pending);
      toast.success(
        direction === "deposit" ? "Funds are in the vault" : "Funds are back in your wallet",
        direction === "deposit" ? "Roque can trade with these now." : "Out of the agent's reach.",
        { href: `${EXPLORER}${hash}` },
      );
      setAmount("");
      onSettled();
    } catch (err) {
      toast.dismiss(pending);
      const message = (err as Error).message || "That move did not go through.";
      if (/rejected|denied/iu.test(message)) {
        toast.info("Waved off", "You turned that one down.");
      } else {
        toast.error("That move did not go through", message);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel card">
      <header className="panel-head">
        <span className="panel-title-icon">
          <Vault size={15} />
          <h3 className="panel-title">Agent vault</h3>
        </span>
      </header>

      <div className="vault-balances">
        {shown.map((t) => (
          <div key={t.symbol} className="vault-bal">
            <TokenIcon symbol={t.symbol} size={22} />
            <span className="tabular">
              {loading && !vault ? "—" : formatAmount(vaultBalances[t.symbol] ?? 0)}
            </span>
            <span className="vault-bal-sym">{t.symbol}</span>
          </div>
        ))}
      </div>

      <div className="vault-form">
        <div className="vault-row">
          <select
            className="token-select"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="Token to move"
          >
            {tokenList.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>

          <div className="vault-denom" role="group" aria-label="Amount unit">
            <button
              type="button"
              className={`vault-denom-btn ${denom === "token" ? "is-active" : ""}`}
              onClick={() => setDenom("token")}
            >
              {token}
            </button>
            <button
              type="button"
              className={`vault-denom-btn ${denom === "usd" ? "is-active" : ""}`}
              onClick={() => setDenom("usd")}
            >
              $
            </button>
          </div>
        </div>

        <div className="vault-input-wrap">
          <div className="vault-input-field">
            {denom === "usd" ? <span className="vault-input-prefix">$</span> : null}
            <input
              className={`vault-input tabular ${denom === "usd" ? "has-prefix" : ""}`}
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/gu, ""))}
            />
          </div>
          {equiv ? <span className="vault-equiv tabular">≈ {equiv}</span> : null}
        </div>

        <div className="vault-wallet">
          <span className="vault-wallet-label">
            <Wallet size={13} />
            In your wallet
          </span>
          <button type="button" className="vault-wallet-bal tabular" onClick={fillMax} title="Use your full balance">
            {balances.loading && !balances.data ? "—" : formatAmount(walletBal)} {token}
            <span className="vault-max">Max</span>
          </button>
        </div>

        <div className="vault-actions">
          <button
            className="btn btn-primary vault-btn"
            onClick={() => void move("deposit")}
            disabled={busy !== null}
          >
            {busy === "deposit" ? <span className="spinner" /> : <ArrowDownToLine size={16} />}
            Deposit
          </button>
          <button
            className="btn btn-ghost vault-btn"
            onClick={() => void move("withdraw")}
            disabled={busy !== null}
          >
            {busy === "withdraw" ? <span className="spinner" /> : <ArrowUpFromLine size={16} />}
            Withdraw
          </button>
        </div>
      </div>
    </section>
  );
}
