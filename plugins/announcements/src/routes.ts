export interface Composition {
  channel: string;
  title?: string;
  text: string;
  at?: string;
  layout?: boolean;
}
export interface Preview {
  content?: string;
  embeds?: { title?: string; description?: string; color?: string }[];
  layout?: { type: string; content?: string }[];
}
export interface Routes {
  "POST /preview": { body: Composition; response: { message: Preview } };
  "POST /compose": { body: Composition; response: { id: number } };
  "GET /scheduled": {
    response: {
      timeZone: string;
      recurring: {
        name: string;
        channel: string;
        enabled: boolean;
        timeZone: string;
        schedule: string | null;
        error: string | null;
        next: string | null;
      }[];
      scheduled: {
        id: number;
        channelId: string;
        at: string;
        title: string | null;
        preview: string;
        by: { id: string; name: string };
      }[];
    };
  };
}
