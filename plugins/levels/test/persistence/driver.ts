import { definePlugin } from "@cicord/sdk";
import { credit, migrate } from "../../src/storage.ts";

export default definePlugin({
  tasks: {
    "migrate-ranking": migrate,
    async earn(ctx) {
      await credit(ctx, "1", 10, "live");
      await credit(ctx, "999", 20, "live");
    },
  },
});
