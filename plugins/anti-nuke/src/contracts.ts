export type Triggered = {
  actorId?: string;
  actorType: "human" | "bot" | "cicord" | "unknown";
  trigger: string;
  count: number;
  /** Applied responses; always empty in monitor mode. */
  responses: string[];
  /** What enforce mode would do, in order (spec §5.6). */
  wouldRespond?: ("removeRoles" | "kick" | "finalSanction" | "requestSync")[];
  certainty: "confirmed" | "probable" | "unknown";
};
