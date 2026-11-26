export type { Case } from "./moderation.ts";
export type { Appeal } from "./appeals.ts";
export interface Standing {
  activeWarnings: number;
  lastCase?: number;
  quarantined: boolean;
}
export interface CaseUpdated {
  number: number;
  changes: string[];
  by: string;
}
