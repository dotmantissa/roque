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
  PrepareResult,
  PriceResult,
  ReservesResult,
  VaultResult,
} from "./types";

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

export const api = {
  interpret(command: string, mode: Mode, user?: string) {
    return request<InterpretResult>("/interpret", {
      method: "POST",
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

  grant(input: {
    user: string;
    agentSigner: string;
    maxPerTradeUsd: string;
    maxDailyUsd: string;
    maxSlippageBps: string;
    validUntil: string;
    signature: string;
  }) {
    return request<{ txHash: string }>("/grant", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  execute(input: { id: string; user: string; slippageBps: number }) {
    return request<{ txHash: string; kind: "swap" | "limit" }>("/execute", {
      method: "POST",
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
};
