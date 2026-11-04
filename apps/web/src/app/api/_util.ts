/**
 * The glue between Next's request objects and Roque's transport agnostic
 * handlers. The handlers in @roque/core know nothing about Next; they take a
 * plain object and either return data or throw an ApiError with a status. This
 * turns one into the other, so every route reads as a single line and they all
 * fail the same way: a clean JSON `{ error }` with the right code, never a stack.
 */

import { NextResponse } from "next/server";
import {QuotaError,admitTransport} from "@roque/core/admission";
import {ZodError} from "zod";
import {PublicApiError} from "@roque/core/public-api";
import { ApiError } from "@roque/core/api";

// These routes touch node:crypto, the Neon driver and the agent signer, so they
// must run on the Node runtime rather than the edge.
export const runtime = "nodejs";

export async function run<T>(fn: () => Promise<T> | T): Promise<NextResponse> {
  try {
    admitTransport("next-api");
    const data = await fn();
    return NextResponse.json(data);
  } catch (err) {
    if(err instanceof PublicApiError) return NextResponse.json({error:{code:err.code,message:err.message}},{status:err.status});
    if(err instanceof ZodError) return NextResponse.json({error:"Invalid request fields."},{status:400});
    if(err instanceof QuotaError) return NextResponse.json({error:"Request quota exceeded."},{status:429,headers:{"Retry-After":"60"}});
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Unexpected error.";
    // Log the real thing server side; hand the caller something calm.
    console.error("[api]", message);
    return NextResponse.json({ error: "The request could not be completed. Check transaction status before retrying." }, { status: 500 });
  }
}

/** Parse a JSON body without throwing on an empty one. */
export async function body(req: Request): Promise<unknown> {
  const reader=req.body?.getReader();if(!reader)return {};
  let text="",size=0;const decoder=new TextDecoder();
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new ApiError(413,"Request body is too large.");}text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();
  try{return JSON.parse(text);}catch{throw new ApiError(400,"Invalid JSON body.");}
}

/** Pull an opaque owner-session token from a standard Authorization header. */
export function bearerToken(req: Request): string | undefined {
  const match = req.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/u);
  return match?.[1];
}
