import type { Context } from "@cicord/sdk";

/** What the plugin keeps of a GitHub release (drafts are never kept). */
export interface Release {
  id: number;
  tag: string;
  name: string;
  url: string;
  body: string;
  prerelease: boolean;
  /** ISO 8601, UTC. */
  publishedAt: string;
  author?: { login: string; url?: string; avatarUrl?: string };
}

export type FetchOutcome =
  | { kind: "ok"; releases: Release[]; etag?: string; remaining?: number }
  | { kind: "not-modified"; remaining?: number }
  | { kind: "not-found" }
  /** `until`: epoch ms before which GitHub must not be called again, when GitHub says. */
  | { kind: "rate-limited"; until?: number; status: number }
  | { kind: "error"; message: string };

export const API = "https://api.github.com";
/** Leaves time to post within the 10 s handler limit. */
export const FETCH_TIMEOUT_MS = 4_000;
/** Releases read per request: the newest ones (GitHub lists them newest first). */
export const PER_PAGE = 10;
/** Kept of the notes: more than an embed shows, so that a cut is still detected. */
const BODY_KEPT = 4_500;

export const releasesUrl = (repo: string): string =>
  `${API}/repos/${repo}/releases?per_page=${PER_PAGE}`;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A release of the API's JSON, or undefined for drafts and malformed entries. */
export function parseRelease(raw: unknown): Release | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r["draft"] === true) return undefined;
  const id = r["id"];
  const publishedAt = str(r["published_at"]);
  const tag = str(r["tag_name"]);
  if (typeof id !== "number" || !publishedAt || Number.isNaN(Date.parse(publishedAt)) || !tag)
    return undefined;
  const author = r["author"] as Record<string, unknown> | null | undefined;
  const login = author ? str(author["login"]) : "";
  return {
    id,
    tag,
    name: str(r["name"]).trim(),
    url: str(r["html_url"]),
    body: str(r["body"]).replaceAll("\r\n", "\n").trim().slice(0, BODY_KEPT),
    prerelease: r["prerelease"] === true,
    publishedAt,
    ...(login
      ? {
          author: {
            login,
            ...(str(author!["html_url"]) ? { url: str(author!["html_url"]) } : {}),
            ...(str(author!["avatar_url"]) ? { avatarUrl: str(author!["avatar_url"]) } : {}),
          },
        }
      : {}),
  };
}

/** Oldest first: by publication date, then id (ids grow with creation). */
export const byPublication = (a: Release, b: Release): number =>
  Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.id - b.id;

/**
 * Reads a 403/429 like GitHub documents it: `retry-after` (seconds), else
 * `x-ratelimit-remaining: 0` with `x-ratelimit-reset` (epoch seconds), else a rate limit
 * without a date (`until` absent: the caller backs off). Undefined: not a rate limit.
 */
export function rateLimit(
  status: number,
  headers: Record<string, string>,
  body: string,
  now: number,
): { until?: number } | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const retryAfter = Number(headers["retry-after"]);
  if (headers["retry-after"] !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0)
    return { until: now + Math.max(retryAfter, 1) * 1000 };
  const reset = Number(headers["x-ratelimit-reset"]);
  if (headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset) && reset > 0)
    return { until: Math.max(reset * 1000 + 1000, now + 1000) };
  if (status === 429 || /rate limit/i.test(body)) return {};
  return undefined; // a 403 for another reason (e.g. access blocked)
}

/**
 * GET the newest releases of `repo`. With `etag`, an unchanged list answers 304. Never
 * throws: network errors, timeouts and unexpected answers are an `error` outcome.
 */
export async function fetchReleases(
  ctx: Context,
  repo: string,
  etag: string | undefined,
): Promise<FetchOutcome> {
  let res: Awaited<ReturnType<Context["http"]["fetch"]>>;
  try {
    res = await ctx.http.fetch(releasesUrl(repo), {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `cicord-github-releases/${ctx.plugin.version} (+https://github.com/cicord/cicord-plugins)`,
        ...(etag ? { "If-None-Match": etag } : {}),
      },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    return { kind: "error", message: (error as Error)?.message ?? String(error) };
  }
  const h = res.headers;
  const remaining =
    h["x-ratelimit-remaining"] !== undefined ? Number(h["x-ratelimit-remaining"]) : undefined;
  const left = remaining !== undefined && Number.isFinite(remaining) ? { remaining } : {};
  if (res.status === 304) return { kind: "not-modified", ...left };
  if (res.status === 404) return { kind: "not-found" };
  let text = "";
  try {
    text = await res.text();
  } catch {
    // the status is enough below
  }
  const limit = rateLimit(res.status, h, text, Date.now());
  if (limit) return { kind: "rate-limited", ...limit, status: res.status };
  if (res.status !== 200) return { kind: "error", message: `GitHub answered HTTP ${res.status}` };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "error", message: "GitHub answered invalid JSON" };
  }
  if (!Array.isArray(data)) return { kind: "error", message: "GitHub answered a non-list" };
  const releases = data
    .map(parseRelease)
    .filter((r): r is Release => r !== undefined)
    .toSorted(byPublication);
  return { kind: "ok", releases, ...(h["etag"] ? { etag: h["etag"] } : {}), ...left };
}
