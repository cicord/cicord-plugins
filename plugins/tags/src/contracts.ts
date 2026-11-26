export type Tag = {
  name: string;
  text: string;
  aliases: string[];
  keywords: string[];
  channel?: string;
  url?: string;
};
export type TagSearch = { query: string; limit: number };
export type TagResult = { entries: Tag[] };
