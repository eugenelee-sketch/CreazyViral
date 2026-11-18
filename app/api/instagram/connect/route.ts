import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { ACCOUNT_PROFILES } from "@/lib/accounts";
import { CALLBACK, instagramOAuthConfig, loginUrl, STATE_COOKIE } from "@/lib/instagramOAuth";

export async function GET(req: Request) {
  const config = instagramOAuthConfig();
  if (!config) return NextResponse.json({ error: "instagram_not_configured" }, { status: 503 });
  const account = ACCOUNT_PROFILES.find(({ id }) => id === new URL(req.url).searchParams.get("account"));
  if (!account) return NextResponse.json({ error: "invalid_account" }, { status: 400 });

  const state = randomBytes(32).toString("base64url");
  // Unified login이면 페이스북 로그인 창(config_id), 아니면 예전 인스타 로그인 창
  const response = NextResponse.redirect(loginUrl(config, state));
  response.cookies.set(STATE_COOKIE, `${state}.${account.id}`, {
    path: CALLBACK, maxAge: 600, httpOnly: true, secure: config.secure, sameSite: "lax",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
