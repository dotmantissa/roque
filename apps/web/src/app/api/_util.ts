/**
 * The glue between Next's request objects and Roque's transport agnostic
 * handlers. The handlers in @roque/core know nothing about Next; they take a
 * plain object and either return data or throw an ApiError with a status. This
 * turns one into the other, so every route reads as a single line and they all
 * fail the same way: a clean JSON `{ error }` with the right code, never a stack.
 */

import { NextResponse } from "next/server";
import { ApiError } from "@roque/core/api";

// These routes touch node:crypto, the Neon driver and the agent signer, so they
// must run on the Node runtime rather than the edge.
export const runtime = "nodejs";

export async function run<T>(fn: () => Promise<T> | T): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Unexpected error.";
    // Log the real thing server side; hand the caller something calm.
    console.error("[api]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Parse a JSON body without throwing on an empty one. */
export async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
