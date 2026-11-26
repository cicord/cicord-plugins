export interface Incident {
  at: number;
  trigger: string;
  count: number;
  actorType: "human" | "bot" | "cicord" | "unknown";
  actorId?: string;
  certainty: "confirmed" | "probable" | "unknown";
  why: string;
}
export interface Routes {
  "GET /incidents": {
    query: { cursor?: string };
    response: { items: Incident[]; cursor: string | null };
  };
  "GET /status": { response: { mode: string; warnings: string[] } };
}
