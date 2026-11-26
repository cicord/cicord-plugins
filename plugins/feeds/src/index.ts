import { definePlugin, type Context } from "@cicord/sdk";
import { parseFeed, type Entry } from "./parse.ts";

type Feed = NonNullable<Context["config"]["feeds"]>[number];
/**
 * `lease` keeps a second check of the same feed out while one runs. `seeded` is false until
 * the first successful fetch recorded the entries already in the feed. Records written by
 * earlier versions have no `seeded` field: those feeds were already publishing.
 */
type State = { due: number; errors: number; lease?: number; seeded?: boolean };
/**
 * A GUID record: "sent", "seen" (in the feed before its first check), "uncertain",
 * "failed" (Discord rejected this entry itself), the
 * legacy "reserved" (an earlier version's claim, never retried), or the claim of a send in
 * progress with its Discord nonce.
 */
type Claim = { nonce: string; first: number };
type Mark = "sent" | "seen" | "uncertain" | "failed" | "reserved" | Claim;

const MINUTE = 60000,
  // A check runs within the handler deadline (about 10 s). The lease of a run cut by the
  // deadline is free again by the scheduler's second retry (1 s, then 2 s later).
  LEASE = 12000,
  // Discord enforces a nonce for a few minutes. Within this window a retry reuses the
  // claim's nonce and Discord returns the original message instead of posting again.
  RETRY_WINDOW = 60000,
  MAX_POSTS = 8;
const stateKey = (id: string) => "state:" + id;
const guidKey = (feed: Feed, item: Entry) => "guid:" + feed.id + ":" + item.guid;

/**
 * Discord or the host refused for good: the same request cannot succeed on a retry. A
 * channel refusal concerns every entry; an entry refusal (invalid body, too long) only this one.
 */
function refusal(error: unknown): { channel: boolean; reason: string } | undefined {
  if (error instanceof Error && error.name === "CapabilityError")
    return { channel: true, reason: "missing grant" };
  const text = String(error);
  if (/discord: missing permissions|HTTP 403/i.test(text))
    return { channel: true, reason: "missing permissions" };
  if (/discord: not found|unknown channel|HTTP 404/i.test(text))
    return { channel: true, reason: "unknown channel" };
  if (/discord: bad request|HTTP 4(?!29)\d\d/i.test(text))
    return { channel: false, reason: "rejected message" };
  return undefined;
}

function render(ctx: Context, feed: Feed, item: Entry) {
  const role = feed.mentionRole ? ctx.server.role(feed.mentionRole) : undefined;
  const values: Record<string, string> = {
    title: item.title,
    url: item.url,
    role: role?.mention ?? "",
  };
  return {
    content: (feed.template ?? "{role} **{title}**\n{url}")
      .replace(/\{(role|title|url)\}/g, (_, k: string) => values[k]!)
      .trim()
      .slice(0, 2000),
    allowedMentions: { users: false, roles: role ? [role.id] : false, everyone: false },
  };
}

async function backoff(ctx: Context, feed: Feed, state: State) {
  const errors = Math.min(10, state.errors + 1);
  const minutes = Math.min(60, 5 * 2 ** (errors - 1));
  await ctx.kv.set(stateKey(feed.id), {
    ...state,
    due: Date.now() + minutes * MINUTE,
    errors,
    lease: 0,
  });
  ctx.status.set(feed.id, ctx.i18n.t("backoff", { minutes }));
}

/** Records every entry already in the feed as seen, except the newest `backlog` matches. */
async function seed(ctx: Context, feed: Feed, all: Entry[], matching: Entry[]) {
  const backlog = feed.backlog ?? 0;
  const keep = new Set(backlog > 0 ? matching.slice(-backlog).map((i) => i.guid) : []);
  const keys = [...new Set(all.filter((i) => !keep.has(i.guid)).map((i) => guidKey(feed, i)))];
  // A transaction holds fewer than 128 checks and writes.
  for (let n = 0; n < keys.length; n += 60) {
    const chunk = keys.slice(n, n + 60);
    const known = await ctx.kv.getMany(chunk);
    const batch = ctx.kv.atomic();
    let writes = 0;
    chunk.forEach((key, k) => {
      if (known[k] === undefined) {
        batch.check(key, null).set(key, "seen");
        writes++;
      }
    });
    // A conflicting concurrent claim wins; the next check records the rest.
    if (writes) await batch.commit();
  }
  ctx.log.info("feeds: feed started, existing entries recorded", {
    feed: feed.id,
    recorded: keys.length,
    posting: keep.size,
  });
}

/** One check of one feed. Throws only after an ambiguous send, so the scheduler retries. */
async function check(ctx: Context, id: string) {
  const feed = ctx.config.enabled ? ctx.config.feeds?.find((f) => f.id === id) : undefined;
  if (!feed) return;
  const entry = await ctx.kv.getEntry<State>(stateKey(id));
  const now = Date.now();
  if ((entry?.value.due ?? 0) > now) return;
  // A retry of a run cut by the deadline waits for that run's lease.
  if ((entry?.value.lease ?? 0) > now) throw new Error("Feed check already running");
  const state: State = {
    due: entry?.value.due ?? 0,
    errors: entry?.value.errors ?? 0,
    seeded: entry ? entry.value.seeded !== false : false,
    lease: now + LEASE,
  };
  const leased = await ctx.kv
    .atomic()
    .check(stateKey(id), entry?.version ?? null)
    .set(stateKey(id), state)
    .commit();
  if (!leased.ok) return; // another run took it
  let all: Entry[];
  try {
    const response = await ctx.http.fetch(feed.url, { timeoutMs: 4000 });
    if (response.status !== 200) throw new Error("Feed unavailable");
    all = parseFeed(await response.text()).reverse(); // oldest first
  } catch {
    await backoff(ctx, feed, state);
    return;
  }
  const matching = all.filter(
    (item) =>
      !feed.keywords?.length ||
      feed.keywords.some((k) => item.title.toLowerCase().includes(k.toLowerCase())),
  );
  if (!state.seeded) {
    await seed(ctx, feed, all, matching);
    state.seeded = true;
    await ctx.kv.set(stateKey(id), state);
  }
  const finish = async () => {
    await ctx.kv.set(stateKey(id), {
      ...state,
      due: Date.now() + ctx.config.pollMinutes * MINUTE,
      errors: 0,
      lease: 0,
    });
    ctx.status.set(id, null);
  };
  const marks: (Mark | undefined)[] = [];
  for (let n = 0; n < matching.length; n += 100)
    marks.push(
      ...(await ctx.kv.getMany<Mark>(matching.slice(n, n + 100).map((i) => guidKey(feed, i)))),
    );
  let sent = 0,
    flagged = false;
  for (let k = 0; k < matching.length && sent < MAX_POSTS; k++) {
    if (typeof marks[k] === "string") continue;
    const item = matching[k]!,
      key = guidKey(feed, item);
    let claim = await ctx.kv.getEntry<Mark>(key);
    if (!claim) {
      const nonce = "f" + (await ctx.kv.increment("nonce")).toString(36);
      const value: Claim = { nonce, first: Date.now() };
      if (!(await ctx.kv.atomic().check(key, null).set(key, value).commit()).ok) continue;
      claim = await ctx.kv.getEntry<Mark>(key);
    }
    if (!claim || typeof claim.value === "string") continue;
    const { nonce, first } = claim.value;
    if (Date.now() - first >= RETRY_WINDOW) {
      // An earlier send may have reached Discord and the nonce no longer protects a retry:
      // never send it again, and tell the operator.
      if ((await ctx.kv.atomic().check(key, claim.version).set(key, "uncertain").commit()).ok) {
        ctx.log.warn("feeds: delivery could not be confirmed", { feed: id, url: item.url });
        ctx.status.set("delivery:" + id, ctx.i18n.t("uncertain", { title: item.title }));
        flagged = true;
      }
      continue;
    }
    try {
      await ctx.server
        .channel(feed.channel)
        .send({ ...render(ctx, feed, item), nonce, enforceNonce: true });
    } catch (error) {
      const refused = refusal(error);
      if (!refused) {
        // Ambiguous (timeout, 5xx, rate limit): the scheduler retries this check within
        // seconds, and the same nonce makes that retry safe.
        await ctx.kv.set(stateKey(id), { ...state, lease: 0 });
        throw error;
      }
      const { reason } = refused;
      if (!refused.channel) {
        // This entry can never be posted as it is: never retry it, and go on with the others.
        await ctx.kv.atomic().check(key, claim.version).set(key, "failed").commit();
        ctx.log.warn("feeds: Discord rejected an entry", { feed: id, url: item.url, reason });
        ctx.status.set("delivery:" + id, ctx.i18n.t("rejected", { title: item.title, reason }));
        flagged = true;
        continue;
      }
      // Discord did not post it: the entry stays unsent and the next check retries it.
      await ctx.kv.atomic().check(key, claim.version).delete(key).commit();
      ctx.log.warn("feeds: Discord refused an entry", { feed: id, reason });
      ctx.status.set("delivery:" + id, ctx.i18n.t("refused", { channel: feed.channel, reason }));
      await finish();
      return;
    }
    await ctx.kv.set(key, "sent");
    sent++;
    // An entry delivered by a later check clears the previous check's delivery notice.
    if (!flagged) ctx.status.set("delivery:" + id, null);
  }
  await finish();
}

export default definePlugin({
  async onStart(ctx) {
    if (!ctx.config.enabled) return;
    await ctx.kv.set("meta:schema", 1);
    for (const feed of ctx.config.feeds ?? []) {
      const state = await ctx.kv.get<State>(stateKey(feed.id));
      if (state?.errors)
        ctx.status.set(
          feed.id,
          ctx.i18n.t("backoff", {
            minutes: Math.max(1, Math.ceil((state.due - Date.now()) / MINUTE)),
          }),
        );
    }
  },
  schedules: {
    poll: {
      cron: "*/5 * * * *",
      // One durable task per due feed: a slow feed never holds up the others, and the
      // scheduler retries a cut or ambiguous run within the nonce window.
      async run(ctx) {
        if (!ctx.config.enabled) return;
        const feeds = ctx.config.feeds ?? [];
        const states = await ctx.kv.getMany<State>(feeds.map((f) => stateKey(f.id)));
        const now = Date.now();
        for (const [k, feed] of feeds.entries()) {
          const s = states[k];
          if ((s?.due ?? 0) <= now && (s?.lease ?? 0) <= now)
            await ctx.schedule.after(1, "check", { id: feed.id });
        }
      },
    },
  },
  tasks: {
    async check(ctx, payload) {
      await check(ctx, (payload as { id: string }).id);
    },
  },
});
