import type { Context, Json } from "@cicord/sdk";
import { byPublication, fetchReleases, type Release } from "./github.ts";
import { announcement, type Feed } from "./render.ts";

/** Announcements per feed and check; the rest follow at the next checks. */
export const MAX_POSTS = 5;
/** No new feed is started after this much time in one check (handlers stop at 10 s). */
export const BUDGET_MS = 3_000;
/** Tick jitter: a feed is due a little before `pollMinutes` have fully elapsed. */
const SLACK_MS = 30_000;
/** Announced release ids remembered per feed (guards against double posts). */
const RECENT = 30;
const BACKOFF = "backoff";

/** What is stored per feed (KV `feed:<repo>:<channel>`). */
export interface FeedState {
  /** ETag of the last list fully handled (sent as If-None-Match). */
  etag?: string;
  /** Newest release announced (or recorded): eligible releases published after it are new. */
  cursor?: { at: string; id: number };
  /** The first check is done (existing releases recorded or announced). */
  seeded?: boolean;
  recent?: number[];
  /** Newest release this feed would announce, for /changelog latest. */
  latest?: Release;
  checkedAt?: number;
  /** The repository answered 404 (logged once). */
  missing?: boolean;
  /** Last error logged (logged again only when it changes). */
  lastError?: string;
}

interface Backoff {
  until: number;
  strikes: number;
}

export type FeedResult =
  | { feed: Feed; kind: "posted"; posted: number; pending: boolean }
  | { feed: Feed; kind: "seeded"; recorded: number }
  | { feed: Feed; kind: "unchanged" }
  | { feed: Feed; kind: "not-found" }
  | { feed: Feed; kind: "rate-limited"; until?: number }
  | { feed: Feed; kind: "error"; message: string }
  | { feed: Feed; kind: "deferred" };

export interface CheckSummary {
  /** Another check is running. */
  busy?: boolean;
  /** GitHub asked to wait: nothing was requested. */
  backoffUntil?: number;
  results: FeedResult[];
}

export const feedKey = (feed: Feed): string => `feed:${feed.repo.toLowerCase()}:${feed.channel}`;

const asJson = (v: object): Json => v as unknown as Json;

export async function loadState(ctx: Context, feed: Feed): Promise<FeedState> {
  return ((await ctx.kv.get(feedKey(feed))) as unknown as FeedState | undefined) ?? {};
}

const saveState = (ctx: Context, feed: Feed, state: FeedState): Promise<void> =>
  ctx.kv.set(feedKey(feed), asJson(state));

const isAfter = (r: Release, cursor: FeedState["cursor"]): boolean =>
  !cursor ||
  Date.parse(r.publishedAt) > Date.parse(cursor.at) ||
  (Date.parse(r.publishedAt) === Date.parse(cursor.at) && r.id > cursor.id);

export const eligible = (feed: Feed, r: Release): boolean =>
  feed.includePrereleases || !r.prerelease;

/** Logs an error of a feed once, until it changes or the feed recovers. */
function noteError(ctx: Context, feed: Feed, state: FeedState, message: string): void {
  if (state.lastError === message) return;
  state.lastError = message;
  ctx.log.warn("github-releases: could not check a feed", { repo: feed.repo, error: message });
}

/** One feed: fetch, then seed or announce what is new (oldest first, MAX_POSTS at most). */
export async function checkFeed(ctx: Context, feed: Feed): Promise<FeedResult> {
  const state = await loadState(ctx, feed);
  const res = await fetchReleases(ctx, feed.repo, state.seeded ? state.etag : undefined);
  if (res.kind === "rate-limited")
    return { feed, kind: "rate-limited", ...(res.until !== undefined ? { until: res.until } : {}) };
  state.checkedAt = Date.now();

  if (res.kind === "not-modified") {
    delete state.lastError;
    await saveState(ctx, feed, state);
    return { feed, kind: "unchanged" };
  }
  if (res.kind === "not-found") {
    if (!state.missing)
      ctx.log.warn("github-releases: repository not found (missing, renamed or private)", {
        repo: feed.repo,
      });
    state.missing = true;
    await saveState(ctx, feed, state);
    return { feed, kind: "not-found" };
  }
  if (res.kind === "error") {
    noteError(ctx, feed, state, res.message);
    await saveState(ctx, feed, state);
    return { feed, kind: "error", message: res.message };
  }

  if (state.missing) ctx.log.info("github-releases: repository found again", { repo: feed.repo });
  delete state.missing;
  const newest = res.releases.findLast((r) => eligible(feed, r));
  if (newest) state.latest = newest;

  if (!state.seeded && !ctx.config.announceExisting) {
    // The cursor is the newest release this feed would announce: a pre-release skipped
    // today is still announced if it becomes a full release later.
    if (newest) state.cursor = { at: newest.publishedAt, id: newest.id };
    state.seeded = true;
    if (res.etag) state.etag = res.etag;
    delete state.lastError;
    await saveState(ctx, feed, state);
    ctx.log.info("github-releases: feed started, existing releases recorded", {
      repo: feed.repo,
      releases: res.releases.length,
    });
    return { feed, kind: "seeded", recorded: res.releases.length };
  }

  const recent = state.recent ?? [];
  const fresh = res.releases
    .filter((r) => isAfter(r, state.cursor) && !recent.includes(r.id))
    .toSorted(byPublication);
  let posted = 0;
  let pending = false;
  for (const r of fresh) {
    if (!eligible(feed, r)) continue; // filtered at every check: it may become a full release
    if (posted >= MAX_POSTS) {
      pending = true;
      break;
    }
    try {
      await ctx.server
        .channel(feed.channel)
        .send({ ...announcement(ctx, feed, r), nonce: "gh" + r.id, enforceNonce: true });
    } catch (error) {
      noteError(ctx, feed, state, `could not post in ${feed.channel}: ${String(error)}`);
      pending = true;
      break;
    }
    posted++;
    state.cursor = { at: r.publishedAt, id: r.id };
    recent.push(r.id);
    state.recent = recent.slice(-RECENT);
    state.seeded = true;
    // Progress is saved after each post: a failure later never posts this one again.
    await saveState(ctx, feed, state);
    ctx.log.info("github-releases: release announced", { repo: feed.repo, tag: r.tag });
  }
  state.seeded = true;
  // The ETag only once everything is handled: otherwise the next check would get a 304 and
  // never post the rest.
  if (pending || !res.etag) delete state.etag;
  else state.etag = res.etag;
  if (!pending) delete state.lastError;
  await saveState(ctx, feed, state);
  return posted === 0 && !pending
    ? { feed, kind: "unchanged" }
    : { feed, kind: "posted", posted, pending };
}

/** Feeds due for a check (or all of them with `force`), least recently checked first. */
async function dueFeeds(ctx: Context, force: boolean, now: number): Promise<Feed[]> {
  const period = ctx.config.pollMinutes * 60_000 - SLACK_MS;
  const withState = await Promise.all(
    (ctx.config.feeds ?? []).map(async (feed) => ({
      feed,
      checkedAt: (await loadState(ctx, feed)).checkedAt,
    })),
  );
  return withState
    .filter((f) => force || f.checkedAt === undefined || now - f.checkedAt >= period)
    .toSorted((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0))
    .map((f) => f.feed);
}

/** Guards against overlapping checks (the tick and /changelog check) in this instance. */
let busyUntil = 0;

/**
 * Checks the due feeds (all with `force`) one after the other, within BUDGET_MS, and stops at
 * the first rate-limit answer: the limit is per IP address, every feed waits.
 */
export async function checkFeeds(
  ctx: Context,
  options: { force?: boolean } = {},
): Promise<CheckSummary> {
  if (ctx.config.enabled === false) return { results: [] };
  const start = Date.now();
  if (start < busyUntil) return { busy: true, results: [] };
  busyUntil = start + 15_000; // also released if the handler is cut short
  try {
    const backoff = (await ctx.kv.get(BACKOFF)) as unknown as Backoff | undefined;
    if (backoff && backoff.until > start) return { backoffUntil: backoff.until, results: [] };
    const results: FeedResult[] = [];
    let limited: { until?: number } | undefined;
    for (const feed of await dueFeeds(ctx, options.force ?? false, start)) {
      if (limited !== undefined || Date.now() - start > BUDGET_MS) {
        results.push({ feed, kind: "deferred" });
        continue;
      }
      const result = await checkFeed(ctx, feed);
      results.push(result);
      if (result.kind === "rate-limited") limited = result;
    }
    if (limited !== undefined) {
      // Without a date from GitHub: at least a minute, longer each time (2, 4… up to an hour).
      const strikes = (backoff?.strikes ?? 0) + 1;
      const until = limited.until ?? Date.now() + Math.min(2 ** (strikes - 1), 60) * 60_000;
      await ctx.kv.set(BACKOFF, asJson({ until, strikes }));
      ctx.log.warn("github-releases: GitHub rate limit reached, waiting", {
        until: new Date(until).toISOString(),
      });
    } else if (backoff && results.some((r) => r.kind !== "deferred")) {
      await ctx.kv.delete(BACKOFF);
    }
    return { results };
  } finally {
    busyUntil = 0;
  }
}
