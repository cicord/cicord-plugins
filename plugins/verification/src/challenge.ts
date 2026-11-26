import type { Context, ImageLayer, Json, Member } from "@cicord/sdk";
import { tr } from "./data.ts";

export type Method = "button" | "typed" | "visual" | "turnstile" | "hcaptcha";
/** `review`: no challenge can be served, the member goes to the staff queue. */
export type Served = Method | "review";
type Challenge = {
  id: string;
  method: Method;
  answer?: number;
  /** The typed code, kept server-side only. */
  code?: string;
  /** A button served because the image could not be rendered (configured fallback). */
  fallback?: true;
};
const providers = {
  turnstile: {
    url: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    secret: "TURNSTILE_SECRET",
  },
  hcaptcha: { url: "https://api.hcaptcha.com/siteverify", secret: "HCAPTCHA_SECRET" },
} as const;
const siteKey = (ctx: Context, method: "turnstile" | "hcaptcha") =>
  method === "turnstile" ? ctx.config.turnstileSiteKey : ctx.config.hcaptchaSiteKey;

/**
 * The challenge a member gets. The image methods need the optional `render` grant (feature
 * `visual`). A configured `typed` or `visual` challenge that cannot be rendered is never
 * replaced by a silent pass: `fallback` decides (staff review by default), and onStart
 * sets the `challenge` status line.
 */
export function methodFor(ctx: Context, member?: Member): Served {
  const method = ctx.config.method,
    render = ctx.features.enabled("visual");
  if (method === "turnstile" || method === "hcaptcha") {
    if (
      ctx.features.enabled("captcha") &&
      siteKey(ctx, method) &&
      ctx.secrets.has(providers[method].secret)
    )
      return method;
  } else if (method === "button" && (!member || member.user.avatarUrl)) return method;
  else if ((method === "typed" || method === "visual") && render) return method;
  if (render) return "typed";
  return method === "typed" || method === "visual"
    ? ctx.config.fallback === "button"
      ? "button"
      : "review"
    : "button";
}

function base64(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const bits = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result +=
      alphabet.charAt(bits >>> 18) +
      alphabet.charAt((bits >>> 12) & 63) +
      (i + 1 < bytes.length ? alphabet.charAt((bits >>> 6) & 63) : "=") +
      (i + 2 < bytes.length ? alphabet.charAt(bits & 63) : "=");
  }
  return result;
}

// Unbiased integer in [0, n) from the platform CSPRNG.
function random(n: number) {
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const [a, b, c, d] = crypto.getRandomValues(new Uint8Array(4));
    const value = ((a! << 24) | (b! << 16) | (c! << 8) | d!) >>> 0;
    if (value < limit) return value % n;
  }
}
const pick = <T>(items: readonly T[]) => items[random(items.length)]!;
export const VISUAL_CHOICES = 12;
const INK = ["#1f2d5c", "#5a1e1e", "#1e4d2b", "#3b2a5c", "#4a3b12"];
const NOISE = ["#9aa7c2", "#c29a9a", "#9ac2a6", "#b9a3d1", "#cdbb8a"];

/** Four-digit code drawn with jittered glyphs and noise, among similar-looking choices.
 * A blind guess succeeds 1 time in 12; failures are rate limited and escalate to staff
 * review. This deters casual scripts only: it is not an anti-bot control. */
async function visual(ctx: Context) {
  const answer = 1000 + random(9000);
  const digits = String(answer);
  const layers: ImageLayer[] = [];
  for (let i = 0; i < 9; i++)
    layers.push({
      type: "rect",
      x: random(240),
      y: random(86),
      width: 30 + random(110),
      height: 2 + random(2),
      color: pick(NOISE),
    });
  for (let i = 0; i < 4; i++)
    layers.push({
      type: "text",
      x: 28 + i * 56 + random(17) - 8,
      // Text y is the top of the glyph box: keep the tallest glyph inside 90 px.
      y: 10 + random(24),
      text: digits[i]!,
      size: 34 + random(12),
      color: pick(INK),
    });
  for (let i = 0; i < 14; i++)
    layers.push({
      type: "rect",
      x: random(256),
      y: random(86),
      width: 3,
      height: 3,
      color: pick(NOISE),
    });
  // Similar distractors: one or two digits differ, so the list does not reveal the code.
  const choices = new Set([answer]);
  while (choices.size < VISUAL_CHOICES) {
    const chars = digits.split("");
    for (let n = 1 + random(2); n > 0; n--) chars[random(4)] = String(random(10));
    const value = Number(chars.join(""));
    if (value >= 1000) choices.add(value);
  }
  const list = [...choices];
  for (let i = list.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  const image = await ctx.render.image({ width: 260, height: 90, background: "#f4f7fb", layers });
  return { answer, image: "data:image/png;base64," + base64(image.data), choices: list };
}

/**
 * Unambiguous alphabet of the typed code: A-Z and 2-9 without 0/O and 1/I/L (31 symbols).
 * A blind guess of a CODE_LENGTH code succeeds once in 31^6 (about 1 in 887 million).
 */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
/** A code drawn from the CSPRNG and rendered as distorted glyphs over noise (300 × 100 px). */
async function typed(ctx: Context) {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  const layers: ImageLayer[] = [];
  for (let i = 0; i < 12; i++)
    layers.push({
      type: "rect",
      x: random(280),
      y: random(96),
      width: 30 + random(120),
      height: 2 + random(3),
      color: pick(NOISE),
    });
  for (let i = 0; i < CODE_LENGTH; i++)
    layers.push({
      type: "text",
      x: 14 + i * 46 + random(13) - 6,
      // Text y is the top of the glyph box: keep the tallest glyph inside 100 px.
      y: 12 + random(28),
      text: code[i]!,
      size: 32 + random(12),
      color: pick(INK),
    });
  for (let i = 0; i < 24; i++)
    layers.push({
      type: "rect",
      x: random(296),
      y: random(96),
      width: 3,
      height: 3,
      color: pick(NOISE),
    });
  const image = await ctx.render.image({ width: 300, height: 100, background: "#f4f7fb", layers });
  return { code, image: "data:image/png;base64," + base64(image.data) };
}

/** A typed answer: the exact length, only the code's alphabet, case-insensitive. */
function typedAnswer(answer: unknown): string | undefined {
  if (typeof answer !== "string") return;
  const value = answer.trim().toUpperCase();
  if (value.length !== CODE_LENGTH) return;
  for (const c of value) if (!CODE_ALPHABET.includes(c)) return;
  return value;
}

/** Constant-time comparison of two strings of the same length. */
function same(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Starts a challenge. Undefined: no challenge can be served (the image cannot be rendered
 * and the configured fallback is staff review), the caller holds the member for staff.
 */
export async function begin(ctx: Context, member: Member): Promise<Json | undefined> {
  let method = methodFor(ctx, member);
  if (method === "review") return undefined;
  // Identity comes from the signed member session. This nonce separates attempts and
  // rotations; it is never an authentication credential.
  const id = crypto.randomUUID();
  if (method === "typed" || method === "visual") {
    try {
      if (method === "typed") {
        const { code, image } = await typed(ctx);
        await ctx.kv.set("challenge:" + member.id, { id, method, code }, { ttlSeconds: 180 });
        ctx.status.set("render", null);
        return {
          id,
          method,
          kind: "typed",
          image,
          length: CODE_LENGTH,
          charset: "alphanumeric",
          prompt: tr(ctx, "message.typeTheCode"),
        };
      }
      const { answer, image, choices } = await visual(ctx);
      await ctx.kv.set("challenge:" + member.id, { id, method, answer }, { ttlSeconds: 180 });
      ctx.status.set("render", null);
      return { id, method, image, choices, prompt: tr(ctx, "message.whichNumberIsShown") };
    } catch (error) {
      // Rendering is experimental: a failure is visible and never a silent pass.
      ctx.log.warn("verification: challenge image could not be rendered", {
        error: String(error),
      });
      ctx.status.set("render", tr(ctx, "status.renderFailed"));
      if (ctx.config.fallback !== "button") return undefined;
      await ctx.kv.set(
        "challenge:" + member.id,
        { id, method: "button", fallback: true },
        { ttlSeconds: 180 },
      );
      method = "button";
      return { id, method };
    }
  }
  await ctx.kv.set("challenge:" + member.id, { id, method }, { ttlSeconds: 180 });
  if (method === "turnstile" || method === "hcaptcha")
    return { id, method, siteKey: siteKey(ctx, method)! };
  return { id, method };
}

export async function check(
  ctx: Context,
  member: Member,
  input: Record<string, unknown>,
): Promise<Method | undefined> {
  const key = "challenge:" + member.id;
  const entry = await ctx.kv.getEntry<Challenge>(key);
  const challenge = entry?.value;
  if (!challenge || input.id !== challenge.id) return;
  if (!(await ctx.kv.atomic().check(key, entry!.version).delete(key).commit()).ok) return;
  const method = challenge.method;
  // A fallback button was served by begin() itself after a render failure.
  if (method !== methodFor(ctx, member) && !(challenge.fallback && method === "button")) return;
  if (method === "typed") {
    const answer = typedAnswer(input.answer);
    return answer && challenge.code && same(answer, challenge.code) ? method : undefined;
  }
  if (method === "visual") return input.answer === challenge.answer ? method : undefined;
  if (method === "button") return method;
  if (typeof input.token !== "string" || !input.token || input.token.length > 4096) return;
  const provider = providers[method];
  const response = await ctx.http.fetch(provider.url, {
    method: "POST",
    form: { secret: ctx.secrets.ref(provider.secret), response: input.token },
    timeoutMs: 3000,
  });
  if (response.status !== 200) throw new Error("verification provider unavailable");
  const result = await response.json<{ success?: boolean; hostname?: string }>();
  return result?.success === true ? method : undefined;
}
