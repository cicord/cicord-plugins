export type DrawView = {
  id: string;
  prize: string;
  state: string;
  closesAt: number;
  commitment: string;
  entrants: number;
  winners: string[];
  seed?: string;
  entrantsHash?: string;
  history?: string[];
  round?: number;
  /** One page of entrants (publishEntrants, after the draw); see `entriesCursor`. */
  entries?: { userId: string; weight: number }[];
  /** Pass as `?cursor=` to read the next page of entrants. Absent on the last page. */
  entriesCursor?: string;
  redacted?: boolean;
};
export interface Routes {
  "GET /giveaways/:id": { query: { cursor?: string }; response: DrawView };
  "GET /giveaways": {
    query: { cursor?: string };
    response: { items: DrawView[]; cursor?: string };
  };
  "GET /giveaways/:id/entries": {
    query: { cursor?: string };
    response: { entries: { userId: string; weight: number }[]; entriesCursor?: string };
  };
}
