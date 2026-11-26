/**
 * Portal contract of the levels routes (plugin.yaml spec.routes.types). Type-only and
 * self-contained (no imports): `cicord portal typegen` copies it into the portals, which get a
 * typed client for these routes. The handlers are checked against it (`defineRoutes`).
 */

export interface LeaderboardEntry {
  /** From 1. */
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  xp: number;
}

/** The viewer's own standing. */
export interface Standing {
  userId: string;
  /** From 1, null when the viewer has no XP yet. */
  rank: number | null;
  xp: number;
  level: number;
  /** XP earned inside the current level. */
  current: number;
  /** XP needed for the next level. */
  needed: number;
}

export interface Routes {
  "GET /seasons/:id": { response: { entries: { userId: string; xp: number; rank: number }[] } };
  /** Public leaderboard. `limit`: 1-100 (default 25). */
  "GET /leaderboard": {
    query: { limit?: number };
    response: { items: LeaderboardEntry[] };
  };
  /** The viewer's own standing (members). */
  "GET /me": { response: Standing };
}
