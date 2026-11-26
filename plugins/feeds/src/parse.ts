export type Entry = { guid: string; title: string; url: string };

function entry(id: unknown, title: unknown, url: unknown): Entry[] {
  if (
    typeof id !== "string" ||
    !id.trim() ||
    id.length > 384 ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    !/^https?:\/\/[^\s<>]+$/i.test(url) ||
    url.length > 1024
  )
    return [];
  return [{ guid: id.trim(), title: title.trim().slice(0, 240), url }];
}

function entities(s: string): string {
  const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return s.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi, (_, name: string) => {
    if (name[0] !== "#") return names[name] ?? "";
    const n = name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}

type Node = { name: string; text: string; attrs: Record<string, string>; children: Node[] };

// Bounded non-validating reader for RSS and Atom. External entities and document
// type declarations are rejected. Attribute values may contain quoted '>'.
function xml(source: string): Node {
  const root: Node = { name: "", text: "", attrs: {}, children: [] },
    stack = [root];
  const lex =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w.:-]+(?:[^>"'<]|"[^"]*"|'[^']*')*>|[^<]+/gy;
  let count = 0;
  while (lex.lastIndex < source.length) {
    const m = lex.exec(source);
    if (!m || ++count > 100000) throw new Error("Invalid or oversized feed XML");
    const token = m[0],
      node = stack.at(-1)!;
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) {
      node.text += token.slice(9, -3);
      continue;
    }
    if (token[0] !== "<") {
      node.text += entities(token);
      continue;
    }
    const close = token.startsWith("</"),
      name = /^<\/?([\w.:-]+)/.exec(token)![1]!;
    if (close) {
      if (stack.length < 2 || node.name !== name) throw new Error("Unbalanced feed XML");
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = Object.create(null);
    for (const a of token.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs[a[1]!] = entities(a[2] ?? a[3] ?? "");
    const child: Node = { name, attrs, text: "", children: [] };
    node.children.push(child);
    if (!token.endsWith("/>")) stack.push(child);
    if (stack.length > 64) throw new Error("Feed nested too deeply");
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error("Incomplete feed");
  return root.children[0]!;
}
const local = (n: Node) => n.name.split(":").at(-1)!.toLowerCase();

export function parseFeed(body: string): Entry[] {
  if (body.length > 1024 * 1024) throw new Error("Feed exceeds 1 MiB");
  if (body.trimStart().startsWith("{")) {
    const feed = JSON.parse(body);
    if (
      !Array.isArray(feed.items) ||
      !/^https:\/\/jsonfeed\.org\/version\/1(?:\.1)?$/.test(feed.version)
    )
      throw new Error("Invalid JSON Feed");
    return feed.items
      .slice(0, 500)
      .flatMap((i: Record<string, unknown>) =>
        i ? entry(i.id, i.title ?? i.content_text, i.url ?? i.external_url) : [],
      );
  }
  const root = xml(body),
    atom = local(root) === "feed";
  const container =
    atom || local(root) === "rdf" ? root : root.children.find((n) => local(n) === "channel");
  if (!container) throw new Error("Expected RSS or Atom");
  return container.children
    .filter((n) => local(n) === (atom ? "entry" : "item"))
    .slice(0, 500)
    .flatMap((n) => {
      const get = (key: string) => n.children.find((c) => local(c) === key)?.text.trim();
      const link = atom
        ? n.children.find(
            (c) => local(c) === "link" && (!c.attrs.rel || c.attrs.rel === "alternate"),
          )?.attrs.href
        : get("link");
      return entry(get(atom ? "id" : "guid") ?? link, get("title"), link);
    });
}
