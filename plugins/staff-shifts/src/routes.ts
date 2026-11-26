export interface Shift {
  day: number;
  start: number;
  minutes: number;
}
export interface Plan {
  zone: string;
  shifts: Shift[];
}
export interface StaffOverview {
  zones: string[];
  plan?: Plan;
  duty?: { start: number; end: number };
  duration?: number;
  ticket?: number;
  case?: number;
}
export interface Routes {
  "GET /me": { response: StaffOverview };
  "PUT /me/plan": { body: Plan; response: { saved: true } };
  "GET /coverage": {
    query: { from?: string };
    response: { from: number; to: number; gaps: { from: number; to: number }[] };
  };
}
