import { z } from "zod";
import { tokenSymbols } from "@roque/shared";

export const decimal = z.string().max(78).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
export const rawAmount = z.string().max(78).regex(/^(?:0|[1-9]\d*)$/u)
  .refine((s) => BigInt(s) < 2n ** 256n, "Amount exceeds uint256.");
export const interpretationSchema = z.object({
  ok: z.boolean(), kind: z.enum(["swap", "limit", "unknown"]),
  action: z.enum(["buy", "sell", "swap"]).optional(),
  tokenIn: z.string().max(20), tokenOut: z.string().max(20),
  amount: z.string().max(78), amountIsPercent: z.boolean(),
  triggerPrice: z.string().max(78), triggerAbove: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().max(500), error: z.string().max(500),
  requestId: z.string().max(128).optional(), creator: z.string().max(100).optional(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict().superRefine((v, ctx) => {
  if (!v.ok) return;
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (v.kind === "unknown" || v.confidence === "low") fail("Uncertain interpretation.");
  if (!tokenSymbols.includes(v.tokenIn as typeof tokenSymbols[number]) ||
      !tokenSymbols.includes(v.tokenOut as typeof tokenSymbols[number]) || v.tokenIn === v.tokenOut)
    fail("Unsupported pair.");
  if (!decimal.safeParse(v.amount).success || !Number.isFinite(Number(v.amount)) || Number(v.amount) <= 0)
    fail("Invalid amount.");
  if (v.amountIsPercent && Number(v.amount) > 100) fail("Invalid percentage.");
  if (v.kind === "limit" && (!decimal.safeParse(v.triggerPrice).success || Number(v.triggerPrice) <= 0 ||
      ![v.tokenIn, v.tokenOut].includes("rWETH"))) fail("Unsupported conditional trade.");
});

export const adjudicationSchema = z.object({
  met: z.boolean(), confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string().max(500), requestId: z.string().max(128).optional(),
  creator: z.string().max(100).optional(), inputHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict().refine((v) => !v.met || v.confidence === "high", "Positive judgments require high confidence.");
