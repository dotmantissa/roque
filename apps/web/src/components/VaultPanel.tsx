"use client";

/**
 * The agent's working balance, and only that. In autonomous mode Roque may spend
 * from this vault and nowhere else, so a person decides here exactly how much
 * they are comfortable handing the agent to work with. Money moves in when they
 * deposit and out when they withdraw, both signed by them; the agent can trade
 * what is inside but can never pull more in or take any out. It is a walled
 * garden they hold the only gate to.
 */

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { ArrowDownToLine, ArrowUpFromLine, Vault } from "lucide-react";
import { tokenList, requireToken } from "@roque/shared";
import type { VaultResult } from "@/lib/types";
import { useWallet } from "@/lib/useWallet";
import { useToast } from "./Toaster";
import { depositToVault, withdrawFromVault } from "@/lib/chain";
import { formatAmount } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";

const EXPLORER = "https://sepolia.etherscan.io/tx/";

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
  const [token, setToken] = useState<string>(tokenList[0]?.symbol ?? "rUSDC");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);

  const balances = vault?.balances ?? {};

  // Show a token in the balance strip when it holds something, and always show
  // the one currently selected so the panel never looks empty while you work.
  const shown = useMemo(() => {
    return tokenList.filter(
      (t) => t.symbol === token || Number(balances[t.symbol] ?? 0) > 0,
    );
  }, [balances, token]);

  if (!wallet.connected) return null;

  const move = async (direction: "deposit" | "withdraw") => {
    const human = amount.trim();
    if (!human || Number(human) <= 0) {
      toast.info("Name an amount first", "How much should move?");
      return;
    }
    setBusy(direction);
    const verb = direction === "deposit" ? "Depositing" : "Withdrawing";
    const pending = toast.push({
      kind: "pending",
      title: `${verb} ${human} ${token}`,
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
              {loading && !vault ? "—" : formatAmount(balances[t.symbol] ?? 0)}
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

          <input
            className="vault-input tabular"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/gu, ""))}
          />
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
