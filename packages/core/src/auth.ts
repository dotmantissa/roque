/**
 * Wallet-bound authentication for autonomous requests. A caller first asks for
 * a one-time challenge, signs the exact message with the vault owner's wallet,
 * then exchanges it for a short-lived opaque bearer token. Only a hash of that
 * token is stored, so a database read cannot mint an authenticated request.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifyMessage, getAddress, type Hex } from "viem";
import { authOrigin } from "./env.js";
import { deployedChainId } from "@roque/shared";
import { q } from "./db/index.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;

export interface WalletChallenge {
  challengeId: string;
  message: string;
  expiresAt: number;
}

export interface OwnerSession {
  token: string;
  owner: `0x${string}`;
  expiresAt: number;
}

function normalizeOwner(owner: `0x${string}`): `0x${string}` {
  return owner.toLowerCase() as `0x${string}`;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issue a server-recorded nonce and the exact message the wallet must sign. */
export async function issueWalletChallenge(
  ownerRaw: `0x${string}`,
  context: { clientId: string; scopes: string[] } = { clientId: "first-party", scopes: ["first-party"] },
): Promise<WalletChallenge> {
  const owner = normalizeOwner(ownerRaw);
  const challengeId = randomUUID();
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const message = [
    `${new URL(authOrigin()).host} wants you to sign in with your Ethereum account:`,
    getAddress(owner),
    "",
    `Connect to Roque (${context.clientId}). This does not authorize a trade or transaction.`,
    "",
    `URI: ${authOrigin()}`,
    "Version: 1",
    `Chain ID: ${deployedChainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
    `Request ID: ${challengeId}`,
  ].join("\n");

  await q(
    `INSERT INTO auth_challenges
       (id, owner_address, nonce, message, expires_at, client_id, audience, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [challengeId, owner, nonce, message, expiresAt.toISOString(), context.clientId, authOrigin(), context.scopes],
  );

  return {
    challengeId,
    message,
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
  };
}

/**
 * Verify and atomically consume a challenge, then mint an owner-bound session.
 * Returning null deliberately folds unknown, expired, replayed and badly signed
 * challenges into one authentication failure.
 */
export async function completeWalletChallenge(params: {
  challengeId: string;
  owner: `0x${string}`;
  signature: Hex;
  clientId?: string;
}): Promise<OwnerSession | null> {
  const owner = normalizeOwner(params.owner);
  const rows = await q<{
    owner_address: string;
    message: string;
    expires_at: string | Date;
    consumed_at: string | Date | null;
    client_id: string; audience: string; scopes: string[];
  }>(
    `SELECT owner_address, message, expires_at, consumed_at, client_id, audience, scopes
       FROM auth_challenges WHERE id=$1`,
    [params.challengeId],
  );
  const challenge = rows[0];
  if (
    !challenge ||
    challenge.client_id !== (params.clientId ?? "first-party") || challenge.audience !== authOrigin() ||
    challenge.owner_address.toLowerCase() !== owner ||
    challenge.consumed_at ||
    new Date(challenge.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }

  const valid = await verifyMessage({
    address: owner,
    message: challenge.message,
    signature: params.signature,
  }).catch(() => false);
  if (!valid) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const consumed = await q(
    `WITH consumed AS (UPDATE auth_challenges SET consumed_at=now()
       WHERE id=$1 AND consumed_at IS NULL AND expires_at > now() AND client_id=$5 AND audience=$6
       RETURNING owner_address, client_id, audience, scopes)
     INSERT INTO auth_sessions (token_hash, owner_address, expires_at, client_id, audience, scopes)
     SELECT $2, owner_address, $3, client_id, audience, scopes FROM consumed WHERE owner_address=$4 RETURNING owner_address`,
    [params.challengeId, tokenHash(token), expiresAt.toISOString(), owner, params.clientId ?? "first-party", authOrigin()],
  );
  if (consumed.length !== 1) return null;

  return {
    token,
    owner,
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
  };
}

/** Resolve a live bearer token to the wallet that authenticated it. */
export async function authenticatedOwner(
  token: string | undefined,
  clientId = "first-party",
): Promise<`0x${string}` | null> {
  if (!token || token.length > 256) return null;
  const rows = await q<{ owner_address: string }>(
    `SELECT owner_address FROM auth_sessions
       WHERE token_hash=$1 AND expires_at > now() AND revoked_at IS NULL AND client_id=$2 AND audience=$3`,
    [tokenHash(token), clientId, authOrigin()],
  );
  const owner = rows[0]?.owner_address;
  return owner ? (owner.toLowerCase() as `0x${string}`) : null;
}

export async function revokeSession(token: string): Promise<void> {
  await q("UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1", [tokenHash(token)]);
}
