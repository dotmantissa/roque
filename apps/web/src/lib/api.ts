/**
 * The one door between the browser and Roque's server routes. Every call goes
 * through `request`, so a failure reads the same everywhere: the server sends a
 * plain `{ error }` on anything that went wrong, and we raise it as a real Error
 * with that message intact, ready to show a person. Paths are relative, so the
 * app talks to its own Next routes and there is no base url to misconfigure.
 */

import type {
  ActivityResult,
  AgentInfo,
  CapabilityResult,
  InterpretResult,
  Mode,
  OrdersResult,
  PrepareResult,
  PriceResult,
  ReservesResult,
  VaultResult,
} from "./types";
import type { Account, WalletClient } from "viem";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const message =
      typeof body?.error === "string" ? body.error : "Something went sideways. Try again.";
    throw new Error(message);
  }
  return body as T;
}

interface AuthChallenge {
  challengeId: string;
  message: string;
  expiresAt: number;
}

interface AuthSession {
  token: string;
  owner: `0x${string}`;
  expiresAt: number;
}

let autonomousSession: AuthSession | null = null;

async function autonomousToken(
  wallet: WalletClient,
  owner: `0x${string}`,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (
    autonomousSession &&
    autonomousSession.owner.toLowerCase() === owner.toLowerCase() &&
    autonomousSession.expiresAt > now + 30
  ) {
    return autonomousSession.token;
  }

  const challenge = await request<AuthChallenge>("/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ owner }),
  });
  const signature = await wallet.signMessage({
    account: owner as unknown as Account,
    message: challenge.message,
  });
  const session = await request<AuthSession>("/auth/session", {
    method: "POST",
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      owner,
      signature,
    }),
  });
  if (session.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("The wallet session was issued for a different owner.");
  }
  autonomousSession = session;
  return session.token;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export const api = {
  async interpret(
    command: string,
    mode: Mode,
    user?: `0x${string}`,
    wallet?: WalletClient,
  ) {
    let token: string | undefined;
    if (mode === "autonomous") {
      if (!user) throw new Error("Connect a wallet first.");
      if (!wallet) throw new Error("Reconnect your wallet to authenticate.");
      token = await autonomousToken(wallet, user);
    }
    return request<InterpretResult>("/interpret", {
      method: "POST",
      headers: token ? bearer(token) : undefined,
      body: JSON.stringify({ command, mode, user }),
    });
  },

  price() {
    return request<PriceResult>("/price");
  },

  reserves(a: string, b: string) {
    return request<ReservesResult>("/reserves", {
      method: "POST",
      body: JSON.stringify({ a, b }),
    });
  },

  prepareSwap(input: {
    id?: string;
    from: string;
    to: string;
    amount: string;
    slippageBps: number;
  }) {
    return request<PrepareResult>("/swap/prepare", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  confirmSwap(id: string, txHash: string) {
    return request<{ ok: true }>("/swap/confirm", {
      method: "POST",
      body: JSON.stringify({ id, txHash }),
    });
  },

  async grant(input: {
    user: `0x${string}`;
    agentSigner: string;
    maxPerTradeUsd: string;
    maxDailyUsd: string;
    maxSlippageBps: string;
    validUntil: string;
    signature: string;
  }, wallet: WalletClient) {
    const token = await autonomousToken(wallet, input.user);
    return request<{ txHash: string }>("/grant", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(input),
    });
  },

  async execute(
    input: { id: string; user: `0x${string}`; slippageBps: number },
    wallet: WalletClient,
  ) {
    const token = await autonomousToken(wallet, input.user);
    return request<{ txHash: string; kind: "swap" | "limit" }>("/execute", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(input),
    });
  },

  agent() {
    return request<AgentInfo>("/agent");
  },

  capability(user: string) {
    return request<CapabilityResult>(`/capability/${user}`);
  },

  vault(user: string) {
    return request<VaultResult>(`/vault/${user}`);
  },

  activity(user: string) {
    return request<ActivityResult>(`/activity/${user}`);
  },

  orders(user: string) {
    return request<OrdersResult>(`/orders/${user}`);
  },
};
