/**
 * One honest reading of the environment, shared by the relayer, the keeper and
 * the web app's server routes. Nothing here reaches for a secret at call time;
 * we read the process environment once, complain loudly if something important
 * is missing, and hand back a plain typed object everyone else can trust.
 *
 * The split matters: a handful of values are public and safe to ship to the
 * browser (an RPC url, the chain id). The rest are secrets and must never leave
 * the server. Keeping them in one file makes that boundary easy to see and hard
 * to cross by accident.
 */

import {privateKeyToAccount} from "viem/accounts";
import { deployedChainId, addresses } from "@roque/shared";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback = ""): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * A normalised private key. People paste keys with and without the 0x prefix and
 * viem is fussy about it, so we settle the question once, here.
 */
function normalizeKey(raw: string): `0x${string}` {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[a-fA-F0-9]{64}$/u.test(hex)) {
    throw new Error("A private key must be 32 bytes of hex, with or without a 0x prefix.");
  }
  return `0x${hex}` as `0x${string}`;
}

/** Values safe to expose to a browser. Everything here is already public chain data. */
export const publicEnv = {
  chainId: deployedChainId,
  sepoliaRpcUrl: optional("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
  genlayerRpcUrl: optional("GENLAYER_RPC_URL", "https://studio.genlayer.com/api"),
  genlayerContract: optional("GENLAYER_CONTRACT_ADDRESS"),
  privyAppId: optional("NEXT_PUBLIC_PRIVY_APP_ID"),
  apiUrl: optional("NEXT_PUBLIC_API_URL", "http://localhost:8787"),
  addresses,
} as const;

/**
 * Just the agent signer key. Signing an intent needs this and nothing else, so
 * it reads on its own rather than forcing a caller to satisfy the whole server
 * environment (database, relayer key) merely to produce a signature.
 */
export function agentSignerKey(): `0x${string}` {
  return normalizeKey(required("AGENT_SIGNER_PRIVATE_KEY"));
}

/**
 * Server only. Reading `serverEnv` from browser code will throw on the missing
 * secrets, which is the point: it should be impossible to leak these by import.
 */
export function serverEnv() {
  const production = process.env.NODE_ENV === "production";
  const latchRpcUrl = optional("LATCH_RPC_URL");
  const latchToken = optional("LATCH_TOKEN");
  const latchRequired = production || optional("LATCH_REQUIRED") === "true";
  if (Boolean(latchRpcUrl) !== Boolean(latchToken) || (latchRequired && !latchRpcUrl))
    throw new Error("Complete Latch configuration is required for relayer writes.");
  if (latchRpcUrl && new URL(latchRpcUrl).protocol !== "https:")
    throw new Error("Latch transport must use HTTPS.");
  const relayerKey = normalizeKey(production ? required("RELAYER_PRIVATE_KEY") : optional("RELAYER_PRIVATE_KEY") || required("DEPLOYER_PRIVATE_KEY"));
  if (production && (privateKeyToAccount(relayerKey).address.toLowerCase() === addresses.deployer.toLowerCase() || relayerKey === agentSignerKey() || (optional("DEPLOYER_PRIVATE_KEY") && relayerKey === normalizeKey(optional("DEPLOYER_PRIVATE_KEY")))))
    throw new Error("Production requires a dedicated relayer key.");
  const cronSecret = production ? required("CRON_SECRET") : optional("CRON_SECRET", "roque-local-cron");
  if (production && (cronSecret.length < 32 || cronSecret === "roque-local-cron"))
    throw new Error("Production cron credentials must contain at least 32 characters.");
  return {
    ...publicEnv,
    agentSignerKey: agentSignerKey(),
    // Production uses a dedicated, minimally funded gas payer distinct from
    // the administrator and the agent authorization signer.
    relayerKey,
    // Production requires complete Latch configuration. Denials and outages
    // propagate without direct-RPC fallback; hosted policy and audit retention
    // must be verified with provider evidence.
    latchRpcUrl,
    latchToken,
    latchRequired,
    databaseUrl: databaseUrl(),
    // A shared secret guarding the cron routes so only Vercel's scheduler, not
    // the open internet, can nudge the keeper and indexer.
    cronSecret,
    port: Number(optional("RELAYER_PORT", "8787")),
  };
}

export function databaseUrl(): string { return required("DATABASE_URL"); }

export function authOrigin(): string {
  const origin = new URL(optional("AUTH_ORIGIN", process.env.NODE_ENV === "production" ? required("AUTH_ORIGIN") : "http://localhost:3000"));
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:") throw new Error("AUTH_ORIGIN must use HTTPS.");
  return origin.origin;
}

export type ServerEnv = ReturnType<typeof serverEnv>;
