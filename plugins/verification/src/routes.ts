export type Decision =
  | { verified: boolean }
  | { state: "hold" | "delay" | "denied"; retryAt?: number };
export type Challenge =
  | Decision
  | { id: string; method: "button" }
  | { id: string; method: "visual"; prompt: string; image: string; choices: number[] }
  | { id: string; method: "turnstile" | "hcaptcha"; siteKey: string };
export interface Routes {
  "GET /challenge": { response: Challenge };
  "POST /challenge": { body: { id: string; token?: string; answer?: number }; response: Decision };
  "GET /queue": {
    query: { cursor?: string };
    response: { items: { userId: string; joined: number }[]; cursor: string | null };
  };
  "POST /queue/:id": { body: { decision: "approve" | "deny" }; response: { verified: boolean } };
  "GET /return/:id": {
    response: {
      result: string;
      method: string | null;
      at: string | null;
      retryAt: number;
      invite?: string;
    };
  };
}
