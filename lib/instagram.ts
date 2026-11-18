// 서버 전용: 인스타그램 공식 API(Instagram API with Instagram Login)로 우리 계정 3개의 릴스 성과를 모아 Supabase에 쌓는다.
// 토큰은 로그나 응답에 절대 내보내지 않는다. 계정 토큰: DB `ig_tokens`(자동 갱신본) → 없으면 환경변수 IG_TOKEN_<ID>.
import { ACCOUNT_PROFILES, type AccountId } from "./accounts";
import { sb } from "./sb";

const GRAPH = "https://graph.instagram.com/v23.0";
// Unified login(새 Meta 앱)의 시스템 사용자 토큰은 graph.facebook.com에서만 쓰이고, 계정은 /me 대신 인스타 ID로 부른다.
export const FB_GRAPH = "https://graph.facebook.com/v27.0";
const HOUR = 3600_000;

type Row = Record<string, unknown>;

/** Instagram 로그인 토큰은 "IG"로 시작한다. 그 밖(EAA…)은 페이스북 로그인(Unified login) 토큰. */
export const isInstagramToken = (token: string) => token.startsWith("IG");

async function ig<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const base = isInstagramToken(token) ? GRAPH : FB_GRAPH;
  const url = new URL(path.startsWith("http") ? path : `${base}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const res = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.code === 190 || res.status === 401 ? "instagram_invalid_token" : `instagram_http_${res.status}`);
  }
  return (await res.json()) as T;
}

export function instagramIdentity(token: string, igUserId?: string | null) {
  type Identity = { username?: string; user_id?: string; id?: string; followers_count?: number };
  if (!isInstagramToken(token)) {
    if (!igUserId) throw new Error("no_ig_user_id");
    return ig<Identity>(`/${igUserId}`, token, { fields: "id,username,followers_count" });
  }
  return ig<Identity>("/me", token, { fields: "user_id,username,followers_count" });
}

export interface AccountResult {
  account: AccountId;
  handle: string;
  ok: boolean;
  error?: string;
  posts?: number;
  snapshots?: number;
  token_expires_at?: string | null;
}

const envToken = (id: AccountId) => process.env[`IG_TOKEN_${id.toUpperCase()}`]?.trim() || "";

/** 토큰이 곧 만료되면 갱신해서 DB에 저장 (갱신은 앱 시크릿 없이 가능, 발급 24시간 뒤부터) */
async function ensureToken(handle: string, id: AccountId): Promise<{ token: string; expires_at: string | null } | null> {
  const rows = await sb<Row[]>("ig_tokens", { params: { handle: `eq.${handle}`, select: "token,expires_at,updated_at" } });
  let token = (rows[0]?.token as string | undefined) || envToken(id);
  let expires = (rows[0]?.expires_at as string | null | undefined) ?? null;
  if (!token) return null;

  // Unified login 토큰은 기본 만료 없음, 갱신 API도 없다 → 갱신하지 않는다
  const soon = isInstagramToken(token) && (!expires || +new Date(expires) - Date.now() < 20 * 24 * HOUR);
  if (soon) {
    try {
      const r = await ig<{ access_token: string; expires_in: number }>("https://graph.instagram.com/refresh_access_token", token, { grant_type: "ig_refresh_token" });
      if (!r.access_token || !Number.isFinite(r.expires_in) || r.expires_in <= 0) throw new Error("invalid_refresh");
      const newExpiry = new Date(Date.now() + r.expires_in * 1000).toISOString();
      const body = { handle, token: r.access_token, expires_at: newExpiry, updated_at: new Date().toISOString() };
      if (rows[0]) {
        await sb("ig_tokens", { method: "PATCH", params: { handle: `eq.${handle}`, updated_at: `eq.${rows[0].updated_at}` }, prefer: "return=minimal", body });
      } else {
        await sb("ig_tokens", { method: "POST", params: { on_conflict: "handle" }, prefer: "resolution=ignore-duplicates,return=minimal", body });
      }
      token = r.access_token;
      expires = newExpiry;
    } catch {
      // 발급 24시간 이내 등으로 갱신이 안 되면 기존 토큰으로 계속 진행
    }
  }
  return { token, expires_at: expires };
}

const METRICS = ["views", "reach", "likes", "comments", "shares", "saved"] as const;

async function insights(mediaId: string, token: string): Promise<Record<string, number>> {
  const tryMetrics = [METRICS.join(","), "views,reach", "reach"];
  for (const m of tryMetrics) {
    try {
      const d = await ig<{ data: { name: string; values: { value: number }[]; total_value?: { value: number } }[] }>(`/${mediaId}/insights`, token, { metric: m });
      const out: Record<string, number> = {};
      for (const x of d.data ?? []) out[x.name] = Number(x.values?.[0]?.value ?? x.total_value?.value ?? 0);
      return out;
    } catch {}
  }
  throw new Error("insights_unavailable");
}

const shortcodeOf = (url: string) => url.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;

/** 어느 체크포인트 구간인지: 24시간/72시간/7일 뒤 24시간 안에 처음 읽은 값을 그 체크포인트로 기록 */
export function checkpointFor(ageMs: number): "24h" | "72h" | "7d" | null {
  const h = ageMs / HOUR;
  if (h >= 24 && h < 48) return "24h";
  if (h >= 72 && h < 96) return "72h";
  if (h >= 168 && h < 192) return "7d";
  return null;
}

async function collectOne(id: AccountId, handle: string): Promise<AccountResult> {
  const base = { account: id, handle };
  const acct = (await sb<Row[]>("ig_accounts", { params: { handle: `eq.${handle}`, select: "id,ig_user_id" } }))[0];
  if (!acct) return { ...base, ok: false, error: "no_account_row (migration 003 필요)" };

  const t = await ensureToken(handle, id);
  if (!t) return { ...base, ok: false, error: "no_token" };

  try {
    const igUserId = (acct.ig_user_id as string | null) ?? null;
    const me = await instagramIdentity(t.token, igUserId);
    if (me.username?.toLowerCase() !== handle.toLowerCase()) throw new Error("instagram_account_mismatch");
    await sb("ig_accounts", {
      method: "PATCH",
      params: { id: `eq.${acct.id}` },
      prefer: "return=minimal",
      body: { ig_user_id: me.user_id ?? me.id ?? null, followers: me.followers_count ?? null, status: "connected", token_expires_at: t.expires_at },
    });

    const media = await ig<{ data: { id: string; caption?: string; media_product_type?: string; permalink: string; timestamp: string }[] }>(isInstagramToken(t.token) ? "/me/media" : `/${me.id ?? igUserId}/media`, t.token, {
      fields: "id,caption,media_product_type,permalink,timestamp",
      limit: "50",
    });
    const reels = (media.data ?? []).filter((m) => m.media_product_type === "REELS");
    if (reels.length) {
      await sb("posts", {
        method: "POST",
        params: { on_conflict: "id" },
        prefer: "resolution=merge-duplicates,return=minimal",
        body: reels.map((m) => ({ id: m.id, account_id: acct.id, url: m.permalink, shortcode: shortcodeOf(m.permalink), caption: m.caption ?? "", posted_at: m.timestamp })),
      });
    }

    // 최근 30일 릴스만 성과를 읽는다
    const recent = reels.filter((m) => Date.now() - +new Date(m.timestamp) < 30 * 24 * HOUR);
    const ids = recent.map((m) => `"${m.id}"`).join(",");
    const existing = recent.length
      ? await sb<Row[]>("post_metric_snapshots", { params: { post_id: `in.(${ids})`, select: "post_id,checkpoint,captured_at", order: "captured_at.desc", limit: "2000" } })
      : [];

    let snapshots = 0;
    for (const m of recent) {
      const mine = existing.filter((e) => e.post_id === m.id);
      const age = Date.now() - +new Date(m.timestamp);
      const cp = checkpointFor(age);
      const hasCp = cp ? mine.some((e) => e.checkpoint === cp) : false;
      const lastAt = mine.length ? +new Date(mine[0].captured_at as string) : 0;
      let checkpoint: string | null = null;
      if (cp && !hasCp) checkpoint = cp;
      else if (Date.now() - lastAt > 20 * HOUR) checkpoint = "daily";
      if (!checkpoint) continue;
      try {
        const v = await insights(m.id, t.token);
        await sb("post_metric_snapshots", {
          method: "POST",
          prefer: "return=minimal",
          body: { post_id: m.id, checkpoint, views: v.views ?? 0, reach: v.reach ?? 0, likes: v.likes ?? 0, comments: v.comments ?? 0, shares: v.shares ?? 0, saves: v.saved ?? 0 },
        });
        snapshots++;
      } catch {
        // 한 게시물의 지표를 못 읽어도 나머지는 계속
      }
    }
    return { ...base, ok: true, posts: reels.length, snapshots, token_expires_at: t.expires_at };
  } catch (e) {
    if (e instanceof Error && e.message === "instagram_invalid_token") {
      await sb("ig_accounts", { method: "PATCH", params: { id: `eq.${acct.id}` }, prefer: "return=minimal", body: { status: "expired", token_expires_at: t.expires_at } }).catch(() => {});
    }
    return { ...base, ok: false, error: e instanceof Error ? e.message : "failed" };
  }
}

export async function collectAll(): Promise<AccountResult[]> {
  return Promise.all(ACCOUNT_PROFILES.map(async (a) => {
    try {
      return await collectOne(a.id, a.handle);
    } catch (error) {
      return { account: a.id, handle: a.handle, ok: false, error: error instanceof Error ? error.message : "collection_failed" };
    }
  }));
}
