/**
 * Roque's link to its judgment layer. The GenLayer intelligent contract reads a
 * sentence of plain English and hands back a structured, validated trade intent,
 * or a plain refusal. This module is the only place the rest of the backend
 * talks to it, so the shape of a GenLayer call lives in exactly one spot.
 *
 * A word on trust, because it is the whole point of splitting the system this
 * way: nothing GenLayer returns can move money. Its answer is a suggestion. The
 * relayer turns a valid suggestion into a signed intent and submits it to
 * Sepolia, where the real dollar caps live and the actual tokens sit. So a wrong
 * or even malicious interpretation here is bounded by what the user already
 * allowed on-chain. GenLayer proposes; Sepolia decides.
 */

import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet, testnetAsimov } from "genlayer-js/chains";
import { publicEnv } from "./env.js";

export interface Interpretation {
  ok: boolean;
  kind: "swap" | "limit" | "unknown";
  action?: "buy" | "sell";
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent: boolean;
  triggerPrice: string;
  triggerAbove: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  error: string;
}

export interface Adjudication {
  met: boolean;
  confidence: "high" | "medium" | "low";
  rationale: string;
}

type GLClient = ReturnType<typeof createClient>;

let _client: GLClient | undefined;

function pickChain() {
  // studionet is the gasless dev network the interpreter is deployed to today.
  // Point at testnet by giving the rpc a bradbury/asimov host once we graduate.
  return publicEnv.genlayerRpcUrl.includes("studio") ? studionet : testnetAsimov;
}

/**
 * A GenLayer client. Reads need no funded identity, so we spin up a throwaway
 * account; the interpreter never checks who is asking, only what was asked.
 */
function client(): GLClient {
  if (!_client) {
    const account = createAccount(generatePrivateKey());
    _client = createClient({ chain: pickChain(), account });
  }
  return _client;
}

function contractAddress(): `0x${string}` {
  const addr = publicEnv.genlayerContract;
  if (!addr) {
    throw new Error(
      "GENLAYER_CONTRACT_ADDRESS is not set. Deploy the interpreter with packages/genlayer/scripts/deploy.py first.",
    );
  }
  return addr as `0x${string}`;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * studionet is a shared dev network reached over the public internet, and its
 * RPC occasionally drops a cold connection with a transient "fetch failed" or an
 * IPv6 connect timeout, the same class of hiccup Neon shows. A write that runs
 * the model across validators is expensive to lose to a flaky socket, so we give
 * the network call a few attempts before surfacing the error. Writes are keyed by
 * requestId and the contract overwrites in place, so a retry never duplicates.
 */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === 3) break;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(
    `GenLayer ${what} failed after retries: ${lastErr instanceof Error ? lastErr.message.split("\n")[0] : String(lastErr)}`,
  );
}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|timeout|socket/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REFUSAL: Interpretation = {
  ok: false,
  kind: "unknown",
  tokenIn: "",
  tokenOut: "",
  amount: "",
  amountIsPercent: false,
  triggerPrice: "",
  triggerAbove: false,
  confidence: "low",
  reason: "",
  error: "the interpreter has not answered yet",
};

/**
 * Ask the interpreter to read a command, then wait for consensus and read the
 * stored result back. Writing is what runs the language model across validators;
 * the view call afterwards is how we retrieve what they agreed on.
 */
export async function interpret(
  requestId: string,
  command: string,
  context: Record<string, unknown> = {},
): Promise<Interpretation> {
  const gl = client();
  const address = contractAddress();

  const txHash = await withRetry("interpret submit", () =>
    gl.writeContract({
      address,
      functionName: "interpret",
      args: [requestId, command, JSON.stringify(context)],
      value: 0n,
    }),
  );

  await withRetry("interpret wait", () =>
    gl.waitForTransactionReceipt({ hash: txHash, retries: 30, interval: 4000 }),
  );

  const raw = await withRetry("interpret read", () =>
    gl.readContract({
      address,
      functionName: "get_interpretation",
      args: [requestId],
    }),
  );

  return parseJson<Interpretation>(raw, { ...REFUSAL, error: "no interpretation stored" });
}

/** Read back an interpretation without triggering a fresh model run. */
export async function readInterpretation(requestId: string): Promise<Interpretation> {
  const raw = await withRetry("read interpretation", () =>
    client().readContract({
      address: contractAddress(),
      functionName: "get_interpretation",
      args: [requestId],
    }),
  );
  return parseJson<Interpretation>(raw, REFUSAL);
}

/**
 * Ask the interpreter to rule on a subjective condition a price feed can never
 * answer, for example "sell if the news turns clearly bearish on ether". Same
 * advisory trust story: the verdict guides the relayer, it does not act.
 */
export async function adjudicate(
  requestId: string,
  condition: string,
  evidence: Record<string, unknown> = {},
): Promise<Adjudication> {
  const gl = client();
  const address = contractAddress();

  const txHash = await withRetry("adjudicate submit", () =>
    gl.writeContract({
      address,
      functionName: "adjudicate",
      args: [requestId, condition, JSON.stringify(evidence)],
      value: 0n,
    }),
  );

  await withRetry("adjudicate wait", () =>
    gl.waitForTransactionReceipt({ hash: txHash, retries: 30, interval: 4000 }),
  );

  const raw = await withRetry("adjudicate read", () =>
    gl.readContract({
      address,
      functionName: "get_adjudication",
      args: [requestId],
    }),
  );

  return parseJson<Adjudication>(raw, {
    met: false,
    confidence: "low",
    rationale: "no adjudication stored",
  });
}
