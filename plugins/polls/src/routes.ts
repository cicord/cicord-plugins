/**
 * Portal contract of the polls routes (plugin.yaml spec.routes.types). Type-only and
 * self-contained (no imports): `cicord portal typegen` copies it into the portals, which get a
 * typed client for these routes. The handlers are checked against it (`defineRoutes`).
 */

/** Results of a poll. */
export interface PollResults {
  id: string;
  question: string;
  status: "scheduled" | "open" | "closed";
  /** Several choices per voter. */
  multiple: boolean;
  createdAt: string;
  closesAt: string;
  closedAt: string | null;
  choices: { label: string; votes: number }[];
  /** Number of distinct voters. */
  voters: number;
}

export interface Routes {
  /** Public: polls are posted in public channels. 404 for an unknown poll. */
  "GET /polls/:id": { response: PollResults };
}
