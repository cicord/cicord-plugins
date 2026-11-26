export type Triggered = {
  actorId?: string;
  actorType: "human" | "bot" | "cicord" | "unknown";
  trigger: string;
  count: number;
  responses: string[];
  certainty: "confirmed" | "probable" | "unknown";
};
