/**
 * The one door between the browser and Roque's server routes. Every call goes
 * through `request`, so a failure reads the same everywhere: the server sends a
 * plain `{ error }` on anything that went wrong, and we raise it as a real Error
 * with that message intact, ready to show a person. Paths are relative, so the
 * app talks to its own Next routes and there is no base url to misconfigure.
 */

import type {
  AcceptResult,
  ActivityResult,
  AgentInfo,
  CapabilityResult,
  EventOrder,
  ForkResult,
  InterpretResult,
  Mode,
  OrdersResult,
  Playbook,
  PlaybookLogEntry,
  PlaybookStep,
  PrepareResult,
  PriceResult,
  Proposal,
  ReservesResult,
  Share,
  VaultResult,
} from "./types";
import type { Account, WalletClient } from "viem";

/**
 * The request outlived its serverless function. Thrown rather than returned
 * because every caller must decide something: a consensus round that is still
 * running is a delay to wait out, and treating it as an error told people their
 * order had failed when it was going perfectly well.
 */
export class StillWorkingError extends Error {
  constructor() {
    super("That is taking longer than one request can stay open.");
    this.name = "StillWorkingError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();

  // Not everything that answers is our own route. A platform timeout or a
  // crashed function replies with an HTML or plain-text error page, and parsing
  // that as JSON used to throw "Unexpected token 'A'" -- which told the person
  // nothing and hid what had actually gone wrong. So the status is read first
  // and a body that will not parse is treated as no body at all.
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
      if (res.ok) {
        // A 200 that is not JSON is not something a caller can use.
        throw new Error("The server sent a reply this app could not read.");
      }
    }
  }

  if (!res.ok) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string") throw new Error(err);
    // A platform timeout is not a failure, it is a request that outlived its
    // function while the work carried on. Raised as its own type so a caller
    // can wait the work out instead of reporting a problem that is not one.
    if (res.status === 504 || res.status === 408) {
      throw new StillWorkingError();
    }
    throw new Error(
      res.status >= 500
        ? `The server could not finish that (${res.status}). Check transaction status before retrying.`
        : "Something went sideways. Try again.",
    );
  }
  return body as T;
}

type ShareKindInput = "event_order" | "playbook";

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

/**
 * Whether a usable wallet session is already in hand. The screens that read
 * private things, meaning the conditions you trade on, your playbooks and your inbox, ask
 * this before they start polling, so visiting a page never fires an unexpected
 * signature request. When it comes back false they show an unlock affordance and
 * the person decides when to sign.
 */
export function hasAutonomousSession(owner?: `0x${string}`): boolean {
  if (!owner || !autonomousSession) return false;
  const now = Math.floor(Date.now() / 1000);
  return (
    autonomousSession.owner.toLowerCase() === owner.toLowerCase() &&
    autonomousSession.expiresAt > now + 30
  );
}

/** Sign once, deliberately, so the private screens can read. */
export async function unlockAutonomousSession(
  owner: `0x${string}`,
  wallet: WalletClient,
): Promise<void> {
  await autonomousToken(wallet, owner);
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
    if (mode === "autonomous" || mode === "copilot") {
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
      headers: autonomousSession ? bearer(autonomousSession.token) : undefined,
      body: JSON.stringify(input),
    });
  },

  confirmSwap(id: string, txHash: string) {
    return request<{ ok: true }>("/swap/confirm", {
      method: "POST",
      headers: autonomousSession ? bearer(autonomousSession.token) : undefined,
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
    return request<ActivityResult>(`/activity/${user}`, { headers: autonomousSession && autonomousSession.owner.toLowerCase()===user.toLowerCase() ? bearer(autonomousSession.token) : undefined });
  },

  orders(user: string) {
    return request<OrdersResult>(`/orders/${user}`);
  },

  // ── Event orders ───────────────────────────────────────────
  //
  // Creating and screening are deliberately two calls. A verifiability screen is
  // a full consensus round and takes half a minute, so the order lands inert and
  // the screen runs after, with the UI free to say what it is waiting on.

  async createEventOrder(
    input: {
      user: `0x${string}`;
      condition: string;
      tokenIn: string;
      tokenOut: string;
      amount: string;
      amountIsPercent?: boolean;
      slippageBps?: number;
      expiresInDays?: number;
    },
    wallet: WalletClient,
  ) {
    const token = await autonomousToken(wallet, input.user);
    return request<{ order: EventOrder }>("/events", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(input),
    });
  },

  async screenEventOrder(id: string, user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ order: EventOrder }>("/events/screen", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ id }),
    });
  },

  async eventOrders(user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ orders: EventOrder[] }>(`/events/${user}`, { headers: bearer(token) });
  },

  /** Put a screened order live. This is the call that claims the vault money. */
  async armEventOrder(id: string, user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ order: EventOrder }>("/events/arm", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ id }),
    });
  },

  async cancelEventOrder(id: string, user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ order: EventOrder }>("/events/cancel", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ id }),
    });
  },

  // ── Playbooks ──────────────────────────────────────────────

  /**
   * Change a draft. Only a draft: an armed plan has money held against its
   * rungs, so the server refuses this rather than rewriting it under the hold.
   */
  async updatePlaybook(
    input: {
      id: string;
      user: `0x${string}`;
      name?: string;
      note?: string;
      steps?: unknown[];
      slippageBps?: number;
    },
    wallet: WalletClient,
  ) {
    const token = await autonomousToken(wallet, input.user);
    const { user: _user, ...patch } = input;
    return request<{ playbook: Playbook }>("/playbooks/update", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(patch),
    });
  },

  async createPlaybook(
    input: {
      user: `0x${string}`;
      name: string;
      note?: string;
      steps: unknown[];
      slippageBps?: number;
    },
    wallet: WalletClient,
  ) {
    const token = await autonomousToken(wallet, input.user);
    return request<{ playbook: Playbook }>("/playbooks", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(input),
    });
  },

  async armPlaybook(id: string, user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ playbook: Playbook }>("/playbooks/arm", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ id }),
    });
  },

  async playbooks(user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ playbooks: Playbook[] }>(`/playbooks/${user}`, { headers: bearer(token) });
  },

  async playbook(id: string, user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ playbook: Playbook; log: PlaybookLogEntry[] }>(
      `/playbooks/detail/${id}`,
      { headers: bearer(token) },
    );
  },

  async cancelPlaybook(id: string, user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ playbook: Playbook }>("/playbooks/cancel", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ id }),
    });
  },

  // ── Shares ─────────────────────────────────────────────────
  //
  // Reading is open, so no wallet is needed to follow a link. Publishing and
  // forking both act on an account, so both carry a session.

  share(slug: string) {
    return request<{ share: Share }>(`/shares/${slug}`);
  },

  recentShares() {
    return request<{ shares: Share[] }>("/shares/recent");
  },

  async myShares(user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ shares: Share[] }>(`/shares/mine/${user}`, { headers: bearer(token) });
  },

  async publishShare(
    input: { kind: ShareKindInput; id: string; title?: string; note?: string },
    user: `0x${string}`,
    wallet: WalletClient,
  ) {
    const token = await autonomousToken(wallet, user);
    return request<{ share: Share }>("/shares", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(input),
    });
  },

  async forkShare(
    input: {
      slug: string;
      user: `0x${string}`;
      amount?: string;
      amountIsPercent?: boolean;
      slippageBps?: number;
      expiresInDays?: number;
    },
    wallet: WalletClient,
  ) {
    const token = await autonomousToken(wallet, input.user);
    return request<ForkResult>("/shares/fork", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify(input),
    });
  },

  // ── Proposals ──────────────────────────────────────────────

  async proposals(user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ proposals: Proposal[] }>(`/proposals/${user}`, { headers: bearer(token) });
  },

  async refreshProposals(user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ filed: number; proposals: Proposal[] }>("/proposals/refresh", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ user }),
    });
  },

  async acceptProposal(id: string, user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<AcceptResult>("/proposals/accept", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ id }),
    });
  },

  async dismissProposal(id: string, user: `0x${string}`, wallet: WalletClient) {
    const token = await autonomousToken(wallet, user);
    return request<{ proposal: Proposal }>("/proposals/dismiss", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ id }),
    });
  },
};
