/**
 * XP math and storage. `GET /leaderboard` items (`LeaderboardEntry`) are consumed by the
 * community portal: keep the shape stable.
 */
import type { Context, Json, User } from "@cicord/sdk";
import type { LeaderboardEntry } from "./routes.ts";

export type { LeaderboardEntry };

/** XP needed to go from `level` to `level + 1` (the classic 5n² + 50n + 100 curve). */
export const stepXp = (level: number): number => 5 * level * level + 50 * level + 100;

export interface Progress {
  level: number;
  /** XP earned inside the current level. */
  current: number;
  /** XP needed for the next level. */
  needed: number;
}

export function progress(xp: number): Progress {
  let level = 0;
  let rest = Math.max(0, xp);
  while (rest >= stepXp(level)) {
    rest -= stepXp(level);
    level++;
  }
  return { level, current: rest, needed: stepXp(level) };
}

export const levelOf = (xp: number): number => progress(xp).level;

export const xpKey = (userId: string): string => `xp:${userId}`;
const profileKey = (userId: string): string => `user:${userId}`;
export const cooldownKey = (userId: string): string => `cooldown:${userId}`;
export const authorKey = (messageId: string): string => `msg:${messageId}`;
export const reactionKey = (messageId: string, userId: string, emoji: string): string =>
  `react:${messageId}:${userId}:${emoji}`;
export const dayKey = (day: string, userId: string): string => `day:${day}:${userId}`;

/** "2026-11-21" (UTC). */
export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

interface Profile {
  displayName: string;
  avatarUrl: string | null;
}

export interface Standing {
  userId: string;
  xp: number;
}

export async function saveProfile(ctx: Context, user: User, displayName: string): Promise<void> {
  const next: Profile = { displayName, avatarUrl: user.avatarUrl ?? null };
  const cur = (await ctx.kv.get(profileKey(user.id))) as Profile | undefined;
  if (cur?.displayName !== next.displayName || cur?.avatarUrl !== next.avatarUrl)
    await ctx.kv.set(profileKey(user.id), next as unknown as Json);
}

/** Every member with XP, best first (ties: lower id first, for a stable order). */
export async function standings(ctx: Context, prefix = "xp:"): Promise<Standing[]> {
  const out: Standing[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.kv.list<number>({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const { key, value } of page.items) {
      if (typeof value === "number" && value > 0)
        out.push({ userId: key.slice(prefix.length), xp: value });
    }
    cursor = page.cursor;
  } while (cursor);
  return out.toSorted((a, b) => b.xp - a.xp || a.userId.localeCompare(b.userId));
}

export async function leaderboard(ctx: Context, limit: number): Promise<LeaderboardEntry[]> {
  const top = (await standings(ctx)).slice(0, limit);
  const items: LeaderboardEntry[] = [];
  for (const [i, s] of top.entries()) {
    const p = (await ctx.kv.get(profileKey(s.userId))) as Profile | undefined;
    items.push({
      rank: i + 1,
      userId: s.userId,
      displayName: p?.displayName ?? `User ${s.userId}`,
      avatarUrl: p?.avatarUrl ?? null,
      level: levelOf(s.xp),
      xp: s.xp,
    });
  }
  return items;
}

/** Text progress bar, e.g. `▰▰▰▱▱▱▱▱▱▱`. */
export function bar(p: Progress, width = 10): string {
  const full = Math.min(width, Math.floor((p.current / p.needed) * width));
  return "▰".repeat(full) + "▱".repeat(width - full);
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}
