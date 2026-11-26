export interface Violation {
  at: number;
  rule: string;
  action: string;
  status?: "completed" | "needs_review";
  channelId: string;
  messageId?: string;
}
export interface RaidState {
  started: number;
  until: number;
  rate: number;
  enforced: boolean;
  phase: "pending" | "active" | "closing";
  pending: ("overlay" | "invites")[];
}
export interface Routes {
  "GET /violations": {
    query: { cursor?: string };
    response: { items: { userId: string; violations: Violation[] }[]; cursor: string | null };
  };
  "GET /raids": {
    response: {
      active: RaidState | null;
      history: { started: number; ended: number; rate: number; enforced: boolean }[];
    };
  };
  "GET /blocklist": { response: { domains: string[]; hashes: string[] } };
  "POST /blocklist": {
    body: { kind: "domain" | "hash"; action: "add" | "remove"; value: string };
    response: { items: string[] };
  };
}
