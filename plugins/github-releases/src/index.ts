import {
  command,
  definePlugin,
  subcommand,
  type AutocompleteChoice,
  type Context,
} from "@cicord/sdk";
import { checkFeeds, eligible, loadState, type CheckSummary, type FeedResult } from "./feeds.ts";
import { fetchReleases, type Release } from "./github.ts";
import { displayName, releaseEmbed, type Feed } from "./render.ts";

/** GitHub's limit for unauthenticated requests, per IP address and hour. */
const HOURLY_LIMIT = 60;
const NO_PINGS = { users: false, roles: false, everyone: false };
const relative = (ms: number): string => `<t:${Math.ceil(ms / 1000)}:R>`;

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.trim().toLowerCase();

/** The configured repositories (once each), as autocomplete choices. */
function suggestRepos(ctx: Context, typed: string): AutocompleteChoice[] {
  const q = typed.trim().toLowerCase();
  const seen = new Set<string>();
  const out: AutocompleteChoice[] = [];
  for (const feed of ctx.config.feeds) {
    const key = feed.repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label =
      feed.label && feed.label !== feed.repo ? `${feed.label} (${feed.repo})` : feed.repo;
    if (q && !key.includes(q) && !label.toLowerCase().includes(q)) continue;
    out.push({ name: label.length <= 100 ? label : `${label.slice(0, 99)}…`, value: feed.repo });
  }
  return out.slice(0, 25);
}

/** The newest release of `feeds` (one repository) from the stored checks, or GitHub. */
async function latestRelease(
  ctx: Context,
  feeds: Feed[],
): Promise<{ feed: Feed; release: Release } | string> {
  let best: { feed: Feed; release: Release } | undefined;
  for (const feed of feeds) {
    const release = (await loadState(ctx, feed)).latest;
    if (
      release &&
      (!best || Date.parse(release.publishedAt) > Date.parse(best.release.publishedAt))
    )
      best = { feed, release };
  }
  if (best) return best;
  // Not checked yet: ask GitHub, without touching the feeds' state.
  const backoff = (await ctx.kv.get("backoff")) as { until?: number } | undefined;
  if (backoff?.until && backoff.until > Date.now())
    return `GitHub's rate limit was reached: try again ${relative(backoff.until)}.`;
  const feed = feeds[0]!;
  const res = await fetchReleases(ctx, feed.repo, undefined);
  switch (res.kind) {
    case "ok": {
      const pick = feeds.find((f) => f.includePrereleases) ?? feed;
      const release = res.releases.findLast((r) => eligible(pick, r));
      return release ? { feed: pick, release } : `**${feed.repo}** has no published release yet.`;
    }
    case "not-found":
      return `GitHub does not know **${feed.repo}** (missing, renamed or private).`;
    case "rate-limited":
      return `GitHub's rate limit was reached${res.until ? `: try again ${relative(res.until)}` : ""}.`;
    default:
      return `Could not reach GitHub: ${res.kind === "error" ? res.message : res.kind}.`;
  }
}

function describe(ctx: Context, r: FeedResult): string {
  let where = `#${r.feed.channel}`;
  try {
    where = ctx.server.channel(r.feed.channel).mention;
  } catch {
    // unknown channel: shown by key
  }
  const name = `**${displayName(r.feed)}** → ${where}`;
  switch (r.kind) {
    case "posted":
      return `✅ ${name}: ${r.posted} new release${r.posted === 1 ? "" : "s"} announced${r.pending ? ", more at the next check" : ""}`;
    case "seeded":
      return `📌 ${name}: first check, ${r.recorded} existing release${r.recorded === 1 ? "" : "s"} recorded (not announced)`;
    case "unchanged":
      return `▫️ ${name}: nothing new`;
    case "not-found":
      return `⚠️ ${name}: repository not found (missing, renamed or private)`;
    case "rate-limited":
      return `⏳ ${name}: GitHub rate limit${r.until ? `, retrying ${relative(r.until)}` : ""}`;
    case "error":
      return `⚠️ ${name}: ${r.message}`;
    case "deferred":
      return `⏭️ ${name}: left for the next check`;
  }
}

function summary(ctx: Context, s: CheckSummary): string {
  if (s.busy) return "A check is already running: try again in a few seconds.";
  if (s.backoffUntil)
    return `GitHub's rate limit was reached: the next check is ${relative(s.backoffUntil)}.`;
  const text = s.results.map((r) => describe(ctx, r)).join("\n");
  return text.length <= 2000 ? text : `${text.slice(0, 1990)}…`;
}

export default definePlugin({
  onStart(ctx) {
    const perHour = (ctx.config.feeds.length * 60) / ctx.config.pollMinutes;
    if (perHour > HOURLY_LIMIT / 2)
      ctx.log.warn(
        "github-releases: polling uses more than half of GitHub's unauthenticated limit (60 requests per hour per IP address, shared with everything on it): raise pollMinutes or list fewer feeds",
        {
          feeds: ctx.config.feeds.length,
          pollMinutes: ctx.config.pollMinutes,
          requestsPerHour: perHour,
        },
      );
  },

  schedules: {
    /** Every 5 minutes (the smallest pollMinutes): checks the feeds that are due. */
    poll: {
      cron: "*/5 * * * *",
      async run(ctx) {
        await checkFeeds(ctx);
      },
    },
  },

  commands: {
    changelog: command({
      description: "Releases of the GitHub repositories announced here",
      // Discord sets permissions per command, not per subcommand: both are for managers.
      permissions: ["ManageServer"],
      subcommands: {
        latest: subcommand({
          description: "Show the latest release of a repository",
          options: {
            repo: {
              type: "string",
              description: "Repository (owner/name)",
              required: true,
              maxLength: 100,
              autocomplete: (ctx, _interaction, focused) => suggestRepos(ctx, focused.value),
            },
          },
          async run(ctx, interaction) {
            const feeds = ctx.config.feeds.filter((f) =>
              sameRepo(f.repo, interaction.options.repo),
            );
            if (feeds.length === 0) {
              await interaction.reply({
                content: `**${interaction.options.repo}** is not announced here. Configured: ${suggestRepos(
                  ctx,
                  "",
                )
                  .map((c) => `\`${c.value}\``)
                  .join(", ")}.`,
                ephemeral: true,
                allowedMentions: NO_PINGS,
              });
              return;
            }
            const latest = await latestRelease(ctx, feeds);
            if (typeof latest === "string") {
              await interaction.reply({
                content: latest,
                ephemeral: true,
                allowedMentions: NO_PINGS,
              });
              return;
            }
            await interaction.reply({
              embeds: [releaseEmbed(ctx, latest.feed, latest.release)],
              allowedMentions: NO_PINGS,
            });
          },
        }),
        check: subcommand({
          description: "Check every feed for new releases now",
          async run(ctx, interaction) {
            await interaction.defer({ ephemeral: true });
            const s = await checkFeeds(ctx, { force: true });
            ctx.log.info("github-releases: check requested", { by: interaction.user.id });
            await interaction.reply({
              content: summary(ctx, s),
              ephemeral: true,
              allowedMentions: NO_PINGS,
            });
          },
        }),
      },
    }),
  },
});
