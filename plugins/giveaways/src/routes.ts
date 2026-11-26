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
  entries?: { userId: string; weight: number }[];
  redacted?: boolean;
};
export interface Routes {
  "GET /giveaways/:id": { response: DrawView };
  "GET /giveaways": {
    query: { cursor?: string };
    response: { items: DrawView[]; cursor?: string };
  };
  "GET /giveaways/:id/entries": { response: { entries: { userId: string; weight: number }[] } };
}
