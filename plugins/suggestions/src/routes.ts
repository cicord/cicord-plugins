export type Proposal = {
  id: string;
  status: string;
  score: number;
  body?: string;
  authorId?: string;
  reason?: string;
};
export interface Routes {
  "GET /suggestions": {
    query: { status?: string; offset?: number };
    response: { items: Proposal[] };
  };
  "POST /suggestions/:id/status": { body: { status: string; reason: string }; response: Proposal };
  "GET /suggestions/moderation": { query: { offset?: number }; response: { items: Proposal[] } };
}
