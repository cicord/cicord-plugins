export type PortalTag = {
  name: string;
  text: string;
  aliases: string[];
  keywords: string[];
  channel?: string;
  url?: string;
};
export interface Routes {
  "GET /stats": { query: { q?: string }; response: { items: { name: string; uses: number }[] } };
  "GET /tags": { query: { q?: string }; response: { entries: PortalTag[] } };
  "PUT /tags/:name": { body: PortalTag; response: { saved: boolean } };
  "DELETE /tags/:name": { response: { deleted: boolean } };
}
