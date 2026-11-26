export interface Routes {
  "GET /unanswered": {
    query: { cursor?: string };
    response: { items: { question: string; channel: string }[]; cursor?: string };
  };
  "POST /solved": {
    body: { channel: string; message: string; thread?: string };
    response: { saved: boolean };
  };
}
