export interface Routes {
  "GET /leaderboard": { response: { userId: string; valid: number; fake: number; left: number }[] };
}
