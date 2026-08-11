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
  if (hex.length !== 64) {
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
  return {
    ...publicEnv,
    agentSignerKey: agentSignerKey(),
    // The keeper and the grant relayer both need to pay gas on Sepolia. In this
    // deployment the deployer wallet doubles as that gas payer; a production
    // setup would use a dedicated, minimally funded hot wallet.
    relayerKey: normalizeKey(optional("RELAYER_PRIVATE_KEY") || required("DEPLOYER_PRIVATE_KEY")),
    // When both are present the relayer's Sepolia writes egress through a Latch
    // proxy instead of straight to the RPC: Latch injects the real provider key,
    // rate limits the channel and keeps a signed audit trail. Leave them unset
    // and the relayer talks to SEPOLIA_RPC_URL directly, exactly as before.
    latchRpcUrl: optional("LATCH_RPC_URL"),
    latchToken: optional("LATCH_TOKEN"),
    databaseUrl: required("DATABASE_URL"),
    // A shared secret guarding the cron routes so only Vercel's scheduler, not
    // the open internet, can nudge the keeper and indexer.
    cronSecret: optional("CRON_SECRET", "roque-local-cron"),
    port: Number(optional("RELAYER_PORT", "8787")),
  };
}

export type ServerEnv = ReturnType<typeof serverEnv>;
