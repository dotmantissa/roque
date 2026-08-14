/**
 * Wallet-bound authentication for autonomous requests. A caller first asks for
 * a one-time challenge, signs the exact message with the vault owner's wallet,
 * then exchanges it for a short-lived opaque bearer token. Only a hash of that
 * token is stored, so a database read cannot mint an authenticated request.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifyMessage, type Hex } from "viem";
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

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issue a server-recorded nonce and the exact message the wallet must sign. */
export async function issueWalletChallenge(
  ownerRaw: `0x${string}`,
): Promise<WalletChallenge> {
  const owner = normalizeOwner(ownerRaw);
  const challengeId = randomUUID();
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const message = [
    "Roque autonomous access",
    "",
    "Sign this one-time challenge to authenticate autonomous requests.",
    "This does not authorize a trade or transaction.",
    "",
    `Wallet: ${owner}`,
    `Chain ID: ${deployedChainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join("\n");

  await q(
    `INSERT INTO auth_challenges
       (id, owner_address, nonce, message, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [challengeId, owner, nonce, message, expiresAt.toISOString()],
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
}): Promise<OwnerSession | null> {
  const owner = normalizeOwner(params.owner);
  const rows = await q<{
    owner_address: string;
    message: string;
    expires_at: string | Date;
    consumed_at: string | Date | null;
  }>(
    `SELECT owner_address, message, expires_at, consumed_at
       FROM auth_challenges WHERE id=$1`,
    [params.challengeId],
  );
  const challenge = rows[0];
  if (
    !challenge ||
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

  const consumed = await q<{ owner_address: string }>(
    `UPDATE auth_challenges SET consumed_at=now()
       WHERE id=$1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING owner_address`,
    [params.challengeId],
  );
  if (consumed.length !== 1) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await q(
    `INSERT INTO auth_sessions (token_hash, owner_address, expires_at)
     VALUES ($1, $2, $3)`,
    [tokenHash(token), owner, expiresAt.toISOString()],
  );

  return {
    token,
    owner,
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
  };
}

/** Resolve a live bearer token to the wallet that authenticated it. */
export async function authenticatedOwner(
  token: string | undefined,
): Promise<`0x${string}` | null> {
  if (!token || token.length > 256) return null;
  const rows = await q<{ owner_address: string }>(
    `SELECT owner_address FROM auth_sessions
       WHERE token_hash=$1 AND expires_at > now()`,
    [tokenHash(token)],
  );
  const owner = rows[0]?.owner_address;
  return owner ? (owner.toLowerCase() as `0x${string}`) : null;
}
