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
import { createHash } from "node:crypto";
import { TransactionStatus } from "genlayer-js/types";
import { interpretationSchema, adjudicationSchema } from "./validation.js";
import { publicEnv } from "./env.js";

export interface Interpretation {
  ok: boolean;
  kind: "swap" | "limit" | "unknown";
  action?: "buy" | "sell" | "swap";
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
 * Production keeps a stable caller so immutable jobs retain identity across replicas.
 * Local development may use a generated account.
 */
function client(): GLClient {
  if (!_client) {
    const key=process.env.GENLAYER_CALLER_PRIVATE_KEY;
    if(process.env.NODE_ENV === "production"&&!key) throw new Error("GENLAYER_CALLER_PRIVATE_KEY is required for durable job identity.");
    const account = createAccount(key as `0x${string}` || generatePrivateKey());
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

/** Changed evidence has its own immutable result; identical retries retain identity. */
export function boundRequestId(id:string,operation:string,text:string,context:string):string {
  return createHash("sha256").update(JSON.stringify([id,operation,text,context])).digest("hex");
}

function parseBoundResult(raw: unknown, operation: "interpret" | "adjudicate", requestId: string, text: string, context: string) {
  if (typeof raw !== "string" || raw.length > 20000) throw new Error("Invalid GenLayer result.");
  const result = JSON.parse(raw);
  const expectedHash = createHash("sha256").update(JSON.stringify([operation, text, context])).digest("hex");
  if (result.requestId !== requestId || result.inputHash !== expectedHash ||
      result.creator?.toLowerCase() !== client().account?.address.toLowerCase())
    throw new Error("GenLayer result identity mismatch.");
  return result;
}

/**
 * studionet is a shared dev network reached over the public internet, and its
 * RPC occasionally drops a cold connection with a transient "fetch failed" or an
 * IPv6 connect timeout, the same class of hiccup Neon shows. A write that runs
 * the model across validators is expensive to lose to a flaky socket, so we give
 * the network call a few attempts before surfacing the error. Writes are keyed by
 * requestId and the contract overwrites in place, so a retry never duplicates.
 *
 * This is for the short calls only: a submit and a read. Waiting for consensus
 * has its own deadline-bounded loop below, because retrying a long poll by
 * restarting it is how you build something that cannot finish.
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

/**
 * How long we will wait for a receipt, in total, whatever goes wrong while
 * waiting. Sized to sit comfortably inside the 300s a serverless route gets,
 * with room for the evidence gathering and the database writes around it.
 */
const RECEIPT_BUDGET_MS = 200_000;

/**
 * Wait for a consensus round to land, under one deadline.
 *
 * This used to be `withRetry` wrapped around a thirty-poll wait, which is a
 * worse idea than it looks: the inner wait is itself allowed two minutes, and a
 * dropped socket at minute two started the whole two minutes again, up to four
 * times. Eight minutes of waiting inside a function that is killed at five is
 * not a retry policy, it is a guarantee of never finishing.
 *
 * So the budget is counted once, from the top, and every failure in between is
 * just another reason to poll again. There is no error from "is this mined yet"
 * that is worth giving up on earlier than the deadline, which is why this
 * catches everything rather than sorting errors into transient and fatal.
 */
async function waitForReceipt(
  gl: GLClient,
  // Taken as whatever writeContract returned, so the GenLayer SDK's own hash
  // type flows through rather than being restated and drifting from it.
  hash: Parameters<GLClient["waitForTransactionReceipt"]>[0]["hash"],
  what: string,
  budgetMs = RECEIPT_BUDGET_MS,
): Promise<unknown> {
  const deadline = Date.now() + budgetMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const receipt = await gl.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED, retries: 8, interval: 3000 });
      if (receipt.status !== TransactionStatus.FINALIZED) throw new Error("Consensus is not final.");
      if (receipt.txExecutionResult === 2 || receipt.txExecutionResultName === "FINISHED_WITH_ERROR" || receipt.consensus_data?.leader_receipt?.some(r => r.error || r.execution_result === "ERROR")) throw new Error("Consensus execution failed.");
      return receipt;
    } catch (err) {
      lastErr = err;
      if (Date.now() >= deadline) break;
      await sleep(2000);
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message.split("\n")[0] : String(lastErr);
  throw new Error(
    `GenLayer ${what} did not reach consensus within ${Math.round(budgetMs / 1000)}s: ${detail}`,
  );
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

  const contextJson = JSON.stringify(context);
  requestId = boundRequestId(requestId,"interpret",command,contextJson);
  const txHash = await withRetry("interpret submit", () =>
    gl.writeContract({
      address,
      functionName: "interpret",
      args: [requestId, command, contextJson],
      value: 0n,
    }),
  );

  await waitForReceipt(gl, txHash, "interpret");

  const raw = await withRetry("interpret read", () =>
    gl.readContract({
      address,
      functionName: "get_interpretation",
      args: [requestId],
    }),
  );

  return interpretationSchema.parse(parseBoundResult(raw, "interpret", requestId, command, contextJson));
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
  return interpretationSchema.parse(typeof raw === "string" ? JSON.parse(raw) : null);
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

  const evidenceJson = JSON.stringify(evidence);
  requestId = boundRequestId(requestId,"adjudicate",condition,evidenceJson);
  const txHash = await withRetry("adjudicate submit", () =>
    gl.writeContract({
      address,
      functionName: "adjudicate",
      args: [requestId, condition, evidenceJson],
      value: 0n,
    }),
  );

  await waitForReceipt(gl, txHash, "adjudicate");

  const raw = await withRetry("adjudicate read", () =>
    gl.readContract({
      address,
      functionName: "get_adjudication",
      args: [requestId],
    }),
  );

  return adjudicationSchema.parse(parseBoundResult(raw, "adjudicate", requestId, condition, evidenceJson));
}
