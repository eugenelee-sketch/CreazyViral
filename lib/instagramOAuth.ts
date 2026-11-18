import { sbConfigured } from "./sb";
import { instagramIdentity, FB_GRAPH } from "./instagram";

export const STATE_COOKIE = "creazy_ig_oauth";
export const SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"];
// Unified login(페이스북 로그인 기반)에서 같은 두 권한의 이름
export const META_SCOPES = ["instagram_basic", "instagram_manage_insights"];
export const CALLBACK = "/api/instagram/callback";

/**
 * 연결 방식 두 가지.
 * - "meta": 2026-10 이후 만든 Meta 앱은 Instagram 로그인 대신 Unified login(Facebook Login for Business + config_id)만 쓸 수 있다.
 *   META_APP_ID(페이스북 앱 ID), META_APP_SECRET, META_CONFIG_ID가 있으면 이 방식.
 * - "instagram": 예전 앱의 Instagram 비즈니스 로그인. INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET.
 */
export function instagramOAuthConfig() {
  const origin = process.env.INSTAGRAM_APP_ORIGIN?.trim();
  if (!origin || !sbConfigured()) return null;
  const metaId = process.env.META_APP_ID?.trim();
  const metaSecret = process.env.META_APP_SECRET?.trim();
  const configId = process.env.META_CONFIG_ID?.trim();
  const igId = process.env.INSTAGRAM_APP_ID?.trim();
  const igSecret = process.env.INSTAGRAM_APP_SECRET?.trim();
  const meta = !!(metaId && metaSecret && configId);
  const appId = meta ? metaId : igId;
  const appSecret = meta ? metaSecret : igSecret;
  if (!appId || !appSecret) return null;
  try {
    const url = new URL(origin);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.origin !== origin || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) return null;
    return {
      mode: meta ? ("meta" as const) : ("instagram" as const),
      appId, appSecret, configId: meta ? configId! : null,
      origin, secure: url.protocol === "https:", redirectUri: origin + CALLBACK,
    };
  } catch {
    return null;
  }
}

export type OAuthConfig = NonNullable<ReturnType<typeof instagramOAuthConfig>>;

/** 로그인 창 주소 */
export function loginUrl(config: OAuthConfig, state: string): URL {
  if (config.mode === "meta") {
    const url = new URL("https://www.facebook.com/v27.0/dialog/oauth");
    url.search = new URLSearchParams({
      client_id: config.appId, redirect_uri: config.redirectUri, state,
      config_id: config.configId!, response_type: "code", override_default_response_type: "true",
    }).toString();
    return url;
  }
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: config.appId, redirect_uri: config.redirectUri, response_type: "code",
    scope: SCOPES.join(","), state, enable_fb_login: "0", force_authentication: "1",
  }).toString();
  return url;
}

export async function exchangeInstagramCode(code: string, config: OAuthConfig) {
  const short = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: config.appId, client_secret: config.appSecret, grant_type: "authorization_code",
      redirect_uri: config.redirectUri, code,
    }),
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
  });
  if (!short.ok) throw new Error("short_token_exchange");
  const result = await short.json();
  const access = result.data?.[0] ?? result;
  if (typeof access.access_token !== "string" || !access.access_token) throw new Error("invalid_short_token");
  const granted = access.permissions;
  if (granted != null) {
    const list = typeof granted === "string" ? granted.split(",").map((value) => value.trim()) : granted;
    if (!Array.isArray(list) || !SCOPES.every((scope) => list.includes(scope))) throw new Error("missing_permissions");
  }

  const exchange = new URL("https://graph.instagram.com/access_token");
  exchange.search = new URLSearchParams({
    grant_type: "ig_exchange_token", client_secret: config.appSecret, access_token: access.access_token,
  }).toString();
  const long = await fetch(exchange, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000) });
  if (!long.ok) throw new Error("long_token_exchange");
  const { access_token: token, expires_in: seconds } = await long.json();
  if (typeof token !== "string" || !token || !Number.isFinite(seconds) || seconds <= 0) throw new Error("invalid_long_token");
  const identity = await instagramIdentity(token);
  return { token, identity, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
}

type Json = Record<string, unknown>;

async function fbGet(path: string, params: Record<string, string>): Promise<Json> {
  const url = new URL(path.startsWith("http") ? path : `${FB_GRAPH}${path}`);
  url.search = new URLSearchParams(params).toString();
  const res = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
  const data = (await res.json().catch(() => null)) as Json | null;
  if (!res.ok || !data) {
    const err = (data?.error as Json | undefined)?.message;
    throw new Error(`facebook_http_${res.status}${err ? `: ${String(err).slice(0, 120)}` : ""}`);
  }
  return data;
}

export interface MetaAccount { id: string; username?: string; followers_count?: number }

/**
 * Unified login: code → 시스템 사용자 토큰(기본 만료 없음) → 허용된 인스타 계정 목록.
 * 계정 목록은 debug_token의 granular_scopes(instagram_basic의 target_ids)에서 먼저 찾고,
 * 없으면 /me/assigned_instagram_accounts, /me/accounts(페이지에 연결된 인스타)를 차례로 시도한다.
 */
export async function exchangeMetaCode(code: string, config: OAuthConfig) {
  const tokenRes = await fbGet("/oauth/access_token", {
    client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri, code,
  });
  const token = tokenRes.access_token;
  if (typeof token !== "string" || !token) throw new Error("invalid_meta_token");

  const debug = (await fbGet("/debug_token", { input_token: token, access_token: `${config.appId}|${config.appSecret}` })).data as Json | undefined;
  const scopes = (debug?.scopes as string[] | undefined) ?? [];
  if (scopes.length && !META_SCOPES.every((s) => scopes.includes(s))) throw new Error("missing_permissions");
  const expiresAtSec = Number(debug?.expires_at ?? 0);
  const expiresAt = expiresAtSec > 0 ? new Date(expiresAtSec * 1000).toISOString() : null;

  const ids = new Set<string>();
  for (const g of (debug?.granular_scopes as { scope: string; target_ids?: string[] }[] | undefined) ?? []) {
    if (g.scope.startsWith("instagram")) for (const id of g.target_ids ?? []) ids.add(String(id));
  }
  if (!ids.size) {
    try {
      const r = await fbGet("/me/assigned_instagram_accounts", { access_token: token, fields: "id" });
      for (const a of (r.data as Json[] | undefined) ?? []) ids.add(String(a.id));
    } catch {}
  }
  if (!ids.size) {
    try {
      const r = await fbGet("/me/accounts", { access_token: token, fields: "instagram_business_account{id}" });
      for (const p of (r.data as Json[] | undefined) ?? []) {
        const ig = p.instagram_business_account as Json | undefined;
        if (ig?.id) ids.add(String(ig.id));
      }
    } catch {}
  }

  // 마지막 예비: Meta 앱 화면에 나온 계정 ID를 직접 읽어 본다 (토큰에 권한이 있는 것만 읽힌다)
  if (!ids.size) {
    for (const id of (process.env.META_IG_ACCOUNT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) ids.add(id);
  }

  const accounts: MetaAccount[] = [];
  for (const id of ids) {
    try {
      const a = await fbGet(`/${id}`, { access_token: token, fields: "id,username,followers_count" });
      accounts.push({ id: String(a.id ?? id), username: a.username as string | undefined, followers_count: a.followers_count as number | undefined });
    } catch {
      // 인스타 계정이 아닌 id(광고 계정 등)는 건너뛴다
    }
  }
  return { token, expiresAt, accounts };
}
