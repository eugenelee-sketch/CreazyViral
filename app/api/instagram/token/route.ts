import { NextResponse } from "next/server";
import { ACCOUNT_PROFILES } from "@/lib/accounts";
import { instagramIdentity, isInstagramToken } from "@/lib/instagram";
import { sb, sbConfigured } from "@/lib/sb";

export const dynamic = "force-dynamic";

// 계정 주인이 Meta 앱 화면(2. Generate access tokens)에서 뽑은 토큰을 붙여 넣는 곳.
// 카톡 등으로 토큰을 주고받지 않게 하려는 길. 토큰으로 그 계정을 실제로 읽어 보고, 버튼의 계정과 같을 때만 저장한다.
// 토큰 값은 응답·로그에 내보내지 않는다.
const KNOWN_IG_IDS = (process.env.META_IG_ACCOUNT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export async function POST(req: Request) {
  const back = (status: string) => {
    const url = new URL("/accounts", process.env.INSTAGRAM_APP_ORIGIN?.trim() || req.url);
    url.searchParams.set("instagram", status);
    const res = NextResponse.redirect(url, 303);
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  if (!sbConfigured()) return back("failed");

  const form = await req.formData().catch(() => null);
  const account = ACCOUNT_PROFILES.find(({ id }) => id === form?.get("account"));
  const token = String(form?.get("token") ?? "").trim().replace(/\s+/g, "");
  if (!account || !token || token.length > 2048 || !/^[A-Za-z0-9_.|-]+$/.test(token)) return back("token_invalid");

  try {
    let identity: Awaited<ReturnType<typeof instagramIdentity>> | null = null;
    if (isInstagramToken(token)) {
      identity = await instagramIdentity(token);
    } else {
      // 페이스북식 토큰(EAA…)은 /me가 인스타 계정이 아니므로 알려진 인스타 ID로 읽어 본다
      for (const igId of KNOWN_IG_IDS) {
        try {
          const a = await instagramIdentity(token, igId);
          if (a.username?.toLowerCase() === account.handle.toLowerCase()) { identity = a; break; }
        } catch {}
      }
    }
    if (!identity) return back("token_invalid");
    if (identity.username?.toLowerCase() !== account.handle.toLowerCase()) return back("account_mismatch");

    // Instagram 장기 토큰은 60일. 대시보드에서 뽑은 토큰의 정확한 만료는 알 수 없어 60일로 두고, 수집 때 20일 미만이면 갱신을 시도한다.
    const expiresAt = isInstagramToken(token) ? new Date(Date.now() + 60 * 86400_000).toISOString() : null;
    await sb("ig_accounts", {
      method: "PATCH", params: { handle: `eq.${account.handle}` }, prefer: "return=minimal",
      body: { status: "connected", token_expires_at: expiresAt, ig_user_id: identity.user_id ?? identity.id ?? null, followers: identity.followers_count ?? null },
    });
    await sb("ig_tokens", {
      method: "POST", params: { on_conflict: "handle" },
      prefer: "resolution=merge-duplicates,return=minimal",
      body: { handle: account.handle, token, expires_at: expiresAt, updated_at: new Date().toISOString() },
    });
    console.info(`[instagram] token saved for ${account.handle}`);
    return back("token_saved");
  } catch (error) {
    console.error(`[instagram] token save failed for ${account.handle}: ${error instanceof Error ? error.message : "error"}`);
    return back("token_invalid");
  }
}
