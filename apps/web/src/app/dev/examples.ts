export const discovery = `API="https://roque-dex.vercel.app"
curl --fail-with-body "$API/v1/health"
curl --fail-with-body "$API/v1/chains"
curl --fail-with-body "$API/v1/tokens?chainId=11155111"
curl --fail-with-body "$API/v1/openapi.json"`;

export const credentials = `# Run on your backend or in a private terminal. Requires Bash, curl and jq.
API="https://roque-dex.vercel.app"
ROQUE_API_KEY_FILE="/absolute/private/path/to/partner.key"
read -r ROQUE_API_KEY < "$ROQUE_API_KEY_FILE" || exit 1

# Set OWNER to the address selected in your user's wallet.
: "\${OWNER:?Set OWNER to your connected wallet address}"

curl --fail-with-body "$API/v1/auth/challenges" \\
  -H "X-API-Key: $ROQUE_API_KEY" \\
  -H "Content-Type: application/json" \\
  --data "$(jq -n --arg owner "$OWNER" '{owner:$owner,chainId:11155111}')" \\
  > challenge.json || exit 1

jq -r '.message' challenge.json`;

export const walletProof = `// In your browser app. challenge is the exact JSON returned by your backend.
import { createWalletClient, custom } from "viem";
import { sepolia } from "viem/chains";
import { validateWalletChallenge } from "@roque/sdk";
import type { EIP1193Provider } from "viem";

export async function signChallenge(
  provider: EIP1193Provider,
  challenge: { challengeId: string; message: string },
) {
  const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) });
  const [owner] = await wallet.requestAddresses();
  await wallet.switchChain({ id: sepolia.id });
  validateWalletChallenge(challenge.message, owner, "https://roque-dex.vercel.app");
  const signature = await wallet.signMessage({ account: owner, message: challenge.message });
  return { challengeId: challenge.challengeId, owner, signature };
}
// Send the returned object to your backend. Never send it an app private key.`;

export const session = `# OWNER and SIGNATURE come from signChallenge above.
: "\${SIGNATURE:?Set SIGNATURE to the wallet signature}"
CHALLENGE_ID="$(jq -r '.challengeId' challenge.json)"

SESSION_JSON="$(curl --fail-with-body "$API/v1/auth/sessions" \\
  -H "X-API-Key: $ROQUE_API_KEY" \\
  -H "Content-Type: application/json" \\
  --data "$(jq -n --arg challengeId "$CHALLENGE_ID" --arg owner "$OWNER" \\
    --arg signature "$SIGNATURE" '{challengeId:$challengeId,owner:$owner,signature:$signature}')")" \\
  || exit 1
WALLET_TOKEN="$(printf '%s' "$SESSION_JSON" | jq -er '.token')" || exit 1
# Keep this token private. All following calls use this wallet session and app key.`;

export const interpretation = `# Choose once per intended trade. Reuse it after timeouts; do not generate a new ID.
: "\${REQUEST_ID:=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')}"

INTENT_JSON="$(curl --fail-with-body "$API/v1/intents" \\
  -H "X-API-Key: $ROQUE_API_KEY" \\
  -H "Authorization: Bearer $WALLET_TOKEN" \\
  -H "Idempotency-Key: \${REQUEST_ID}:intent" \\
  -H "Content-Type: application/json" \\
  --data '{"command":"Swap 0.1 rUSDC for rWETH","chainId":11155111,"executionMode":"wallet","slippageBps":100}')" \\
  || exit 1
INTENT_ID="$(printf '%s' "$INTENT_JSON" | jq -er '.id')" || exit 1

# Poll the same intent. Stop on ready, rejected or failed.
for attempt in $(seq 1 150); do
  RESULT="$(curl --fail-with-body "$API/v1/intents/$INTENT_ID" \\
    -H "X-API-Key: $ROQUE_API_KEY" \\
    -H "Authorization: Bearer $WALLET_TOKEN")" || exit 1
  STATUS="$(printf '%s' "$RESULT" | jq -r '.status')"
  case "$STATUS" in
    ready) break ;;
    rejected|failed) printf '%s\\n' "$RESULT"; exit 1 ;;
  esac
  sleep 2
done
[ "$STATUS" = ready ] || { echo "Still pending: $INTENT_ID. Poll it again later."; exit 1; }`;

export const preparation = `QUOTE_JSON="$(curl --fail-with-body "$API/v1/quotes" \\
  -H "X-API-Key: $ROQUE_API_KEY" \\
  -H "Authorization: Bearer $WALLET_TOKEN" \\
  -H "Idempotency-Key: \${REQUEST_ID}:quote" \\
  -H "Content-Type: application/json" \\
  --data "$(jq -n --arg intentId "$INTENT_ID" '{intentId:$intentId}')")" || exit 1
QUOTE_ID="$(printf '%s' "$QUOTE_JSON" | jq -er '.quoteId')" || exit 1

curl --fail-with-body "$API/v1/swaps/prepare" \\
  -H "X-API-Key: $ROQUE_API_KEY" \\
  -H "Authorization: Bearer $WALLET_TOKEN" \\
  -H "Idempotency-Key: \${REQUEST_ID}:prepare" \\
  -H "Content-Type: application/json" \\
  --data "$(jq -n --arg quoteId "$QUOTE_ID" '{quoteId:$quoteId}')" \\
  > plan.json || exit 1

jq '{swapId,recipient,tokenInSymbol,tokenOutSymbol,amountInRaw,
  minAmountOutRaw,feeBps,priceImpactBps,expiresAt,steps}' plan.json`;

export const sdk = `// Browser code, with /v1/* proxied by your own backend to Roque.
// Your proxy adds X-API-Key; the browser never receives that key.
import { RoqueClient, SubmittedTradeError, validatePlan } from "@roque/sdk";
import { createWalletClient, custom } from "viem";
import { sepolia } from "viem/chains";
import type { EIP1193Provider } from "viem";
import type { SwapPlan } from "@roque/shared";

export async function connectRoque(provider: EIP1193Provider) {
  const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) });
  const [owner] = await wallet.requestAddresses();
  await wallet.switchChain({ id: sepolia.id });
  const api = new RoqueClient(location.origin, {
    authOrigin: "https://roque-dex.vercel.app",
    onSubmitted: hash => {
      // Persist immediately so a timeout/reload cannot cause a second swap.
      localStorage.setItem("roque-last-submitted-hash", hash);
    },
  });
  await api.connect(owner, message => wallet.signMessage({ account: owner, message }));

  // These calls prepare a plan; they do not send tokens.
  async function prepareTrade(command: string, requestId: string) {
    const intent = await api.createIntent(command, requestId + ":intent", 100);
    for (let attempt = 0; attempt < 150; attempt++) {
      const result = await api.intent(intent.id);
      if (result.status === "ready") {
        const quote = await api.quote(intent.id, requestId + ":quote");
        const plan = await api.prepare(quote.quoteId, requestId + ":prepare");
        validatePlan(plan, owner);
        return plan; // Render the amounts, minimum receive, fees and expiry for review.
      }
      if (["failed", "rejected"].includes(result.status)) throw new Error(result.status);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error("Still pending. Resume polling intent " + intent.id);
  }

  // Call only from a separate explicit "Reviewed: sign" button.
  async function signReviewedTrade(plan: SwapPlan) {
    try {
      return await api.executeReviewedPlan(plan, wallet, owner);
    } catch (error) {
      if (error instanceof SubmittedTradeError) {
        // The swap was sent. Retry reporting this hash, never execute it again.
        await api.report(plan.swapId, error.txHash, "submission:" + plan.swapId);
        return error.txHash;
      }
      throw error;
    }
  }
  return { api, owner, prepareTrade, signReviewedTrade };
}
// Supply a stable crypto.randomUUID() per new trade; retain its ID across retries.
// After signing, poll api.swap(plan.swapId) until confirmed or reverted.`;

export const settlement = `SWAP_ID="$(jq -r '.swapId' plan.json)"
: "\${TX_HASH:?Set TX_HASH to the swap hash returned by your wallet}"

curl --fail-with-body "$API/v1/swaps/$SWAP_ID/submissions" \\
  -H "X-API-Key: $ROQUE_API_KEY" \\
  -H "Authorization: Bearer $WALLET_TOKEN" \\
  -H "Idempotency-Key: submission:$SWAP_ID" \\
  -H "Content-Type: application/json" \\
  --data "$(jq -n --arg txHash "$TX_HASH" '{txHash:$txHash}')"

# Repeat this GET until confirmed or reverted. A broadcast is not a completed trade.
curl --fail-with-body "$API/v1/swaps/$SWAP_ID" \\
  -H "X-API-Key: $ROQUE_API_KEY" \\
  -H "Authorization: Bearer $WALLET_TOKEN"

# Disconnect when this wallet is finished. No JSON body or Content-Type is needed.
curl --fail-with-body -X DELETE "$API/v1/auth/session" \\
  -H "X-API-Key: $ROQUE_API_KEY" \\
  -H "Authorization: Bearer $WALLET_TOKEN"`;

export const partner = `git clone https://github.com/dotmantissa/roque.git
cd roque
# Node.js >=22.13 and the workspace's pinned pnpm are required.
pnpm install --frozen-lockfile

# Bundle the browser SDK from source. @roque/sdk is a workspace package.
pnpm --filter @roque/core exec node -e 'const entry=require.resolve("tsx");const esbuild=require(require.resolve("esbuild",{paths:[entry]}));esbuild.build({entryPoints:["../../examples/partner-app/browser.ts"],bundle:true,format:"esm",platform:"browser",outfile:"../../examples/partner-app/sdk.js"})'

# Read your supplied key privately and export it only for the backend server.
ROQUE_API_KEY_FILE="/absolute/private/path/to/partner.key"
read -r ROQUE_API_KEY < "$ROQUE_API_KEY_FILE" || exit 1
export ROQUE_API_KEY
ROQUE_API_URL=https://roque-dex.vercel.app \\
ROQUE_AUTH_ORIGIN=https://roque-dex.vercel.app \\
node examples/partner-app/server.mjs
# Open http://localhost:3100 with a funded Sepolia wallet.`;

export const mcp = `Connector URL: https://roque-dex.vercel.app/mcp
Resource:      https://roque-dex.vercel.app/mcp
Discovery:     https://roque-dex.vercel.app/.well-known/oauth-protected-resource/mcp
OAuth server:  https://roque-dex.vercel.app/.well-known/oauth-authorization-server

Tools:
  roque_list_tokens
  roque_quote_swap
  roque_prepare_swap
  roque_request_approval
  roque_get_swap_status`;
