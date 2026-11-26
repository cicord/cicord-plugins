export type AuditObservation = {
  id: string;
  at: number;
  category: string;
  text: string;
  excerpt?: string;
};
export type SearchResult = { items: AuditObservation[]; cursor?: string };
export interface Routes {
  "GET /search": {
    query: { q?: string; member?: string; channel?: string; category?: string; cursor?: string };
    response: SearchResult;
  };
  "GET /export": {
    query: { q?: string; member?: string; channel?: string; category?: string; cursor?: string };
    response: SearchResult;
  };
}
