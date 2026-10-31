import type { ApiError } from "@orbit/shared";
import { NextResponse } from "next/server";
import { AgentError, errMsg } from "./agents";

export const json = <T>(data: T, status = 200) => NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
export const fail = (status: number, error: string, detail?: string) => json<ApiError>({ error, ...(detail ? { detail } : {}) }, status);

/** Wrap a handler so it never throws. */
export async function guard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AgentError) return json(e.body ?? ({ error: e.message } satisfies ApiError), e.status);
    console.error("[api]", e);
    return fail(500, "internal error", errMsg(e));
  }
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return ((await req.json()) ?? {}) as T;
  } catch {
    return {} as T;
  }
}

export const bearer = (req: Request): string | null => /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
