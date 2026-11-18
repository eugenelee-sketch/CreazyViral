import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ACCOUNT_PROFILES } from "@/lib/accounts";
import { CALLBACK, exchangeInstagramCode, exchangeMetaCode, instagramOAuthConfig, STATE_COOKIE } from "@/lib/instagramOAuth";
import { collectAll } from "@/lib/instagram";
import { sb } from "@/lib/sb";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const config = instagramOAuthConfig();
  if (!config) return NextResponse.json({ error: "instagram_not_configured" }, { status: 503 });

  const finish = (status: string, detail?: string) => {
    const url = new URL("/accounts", config.origin);
    url.searchParams.set("instagram", status);
    if (detail) url.searchParams.set("detail", detail.slice(0, 600));
    const response = NextResponse.redirect(url);
    response.cookies.set(STATE_COOKIE, "", {
      path: CALLBACK, maxAge: 0, httpOnly: true, secure: config.secure, sameSite: "lax",
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };

  const [expected, accountId] = (req.cookies.get(STATE_COOKIE)?.value ?? "").split(".");
  const account = ACCOUNT_PROFILES.find(({ id }) => id === accountId);
  const state = Buffer.from(req.nextUrl.searchParams.get("state") ?? "");
  if (!account || !expected || state.length !== Buffer.byteLength(expected) ||
      !timingSafeEqual(state, Buffer.from(expected))) return finish("invalid");
  if (req.nextUrl.searchParams.has("error")) return finish("cancelled");
  const code = req.nextUrl.searchParams.get("code");
  if (!code || code.length > 4096) return finish("invalid");

  if (config.mode === "meta") {
    // Unified login: 한 번 로그인으로 고른 인스타 계정이 전부 넘어온다. 우리 계정 3개 중 들어온 것만 저장한다.
    try {
      const { token, expiresAt, accounts } = await exchangeMetaCode(code, config);
      const now = new Date().toISOString();
      let saved = 0;
      for (const profile of ACCOUNT_PROFILES) {
        const a = accounts.find((x) => x.username?.toLowerCase() === profile.handle.toLowerCase());
        if (!a) continue;
        await sb("ig_accounts", {
          method: "PATCH", params: { handle: `eq.${profile.handle}` }, prefer: "return=minimal",
          body: { status: "connected", token_expires_at: expiresAt, ig_user_id: a.id, followers: a.followers_count ?? null },
        });
        await sb("ig_tokens", {
          method: "POST", params: { on_conflict: "handle" },
          prefer: "resolution=merge-duplicates,return=minimal",
          body: { handle: profile.handle, token, expires_at: expiresAt, updated_at: now },
        });
        saved++;
      }
      console.info(`[instagram] unified login: found ${accounts.length} account(s) [${accounts.map((a) => a.username).join(", ")}], saved ${saved}`);
      if (!saved) return finish("no_accounts", `찾은 계정: ${accounts.map((a) => a.username ?? a.id).join(", ") || "없음"}`);

      // 저장에서 끝내지 않고 바로 성과를 한 번 모아서, 실제로 숫자가 들어오는지 그 자리에서 보여 준다
      const results = await collectAll().catch((e) => [{ handle: "전체", ok: false, error: e instanceof Error ? e.message : "collect_failed" }]);
      const detail = results.map((r) =>
        "posts" in r && r.ok ? `@${r.handle}: 릴스 ${r.posts}개, 성과 ${r.snapshots}건 저장` : `@${r.handle}: ${r.error ?? "실패"}`,
      ).join(" / ");
      console.info(`[instagram] first collection: ${detail}`);
      return finish("connected", detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      console.error(`[instagram] unified login failed: ${message}`);
      return finish(message === "missing_permissions" ? "permissions" : "failed");
    }
  }

  try {
    const { token, identity, expiresAt } = await exchangeInstagramCode(code, config);
    if (identity.username?.toLowerCase() !== account.handle.toLowerCase()) return finish("account_mismatch");
    await sb("ig_tokens", {
      method: "POST", params: { on_conflict: "handle" },
      prefer: "resolution=merge-duplicates,return=minimal",
      body: { handle: account.handle, token, expires_at: expiresAt, updated_at: new Date().toISOString() },
    });
    await sb("ig_accounts", {
      method: "PATCH", params: { handle: `eq.${account.handle}` }, prefer: "return=minimal",
      body: {
        status: "connected", token_expires_at: expiresAt, ig_user_id: identity.user_id ?? identity.id ?? null,
        followers: identity.followers_count ?? null,
      },
    }).catch(() => {});
    return finish("connected");
  } catch (error) {
    return finish(error instanceof Error && error.message === "missing_permissions" ? "permissions" : "failed");
  }
}
