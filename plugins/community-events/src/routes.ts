export interface Routes {
  "GET /calendar": { response: { id: string; name: string; start: string; end?: string }[] };
  "GET /calendar.ics": { response: string };
}
