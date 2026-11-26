import { it, expect } from "vite-plus/test";
import { parseTag, search, visible } from "../src/catalog.ts";
import type { Channel, Context, Member } from "@cicord/sdk";
it("parses list frontmatter without widening malformed restricted tags", () => {
  const tag = parseTag(
    "---\nname: Reset\nchannel: staff\naliases:\n  - restart\nkeywords: [power, boot]\n---\nCycle power.",
  );
  expect(tag?.aliases).toEqual(["restart"]);
  expect(tag?.channel).toBe("staff");
  expect(parseTag("---\nname: Reset\nroles: staff\n---\nSecret answer.")).toBeUndefined();
});
it("rechecks both the invoking member and destination after a role is removed", () => {
  const tag = parseTag("---\nname: Reset\nchannel: staff\n---\nPrivate answer.")!,
    ctx = { server: { compareAudience: () => "wider" } } as unknown as Context;
  let access = true;
  const member = { canView: () => access } as unknown as Member;
  expect(visible(ctx, tag, member)).toBe(true);
  expect(visible(ctx, tag)).toBe(false);
  expect(visible(ctx, tag, member, {} as Channel)).toBe(false);
  access = false;
  expect(visible(ctx, tag, member)).toBe(false);
});
it("autocompletes 1000 tags in under one second", () => {
  const tags = Array.from({ length: 1000 }, (_, i) => ({
    name: "Tag " + i,
    text: "...",
    aliases: [],
    keywords: [],
  }));
  const started = Date.now();
  expect(search(tags, "Tag 998", 25)[0]?.name).toBe("Tag 998");
  expect(Date.now() - started).toBeLessThan(1000);
});
