export interface Routes {
  "GET /leaderboard": {
    query: { limit?: number; offset?: number };
    response: { userId: string; valid: number; fake: number; left: number }[];
  };
}
