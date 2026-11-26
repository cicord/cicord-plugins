import type { Context, Json, Member } from "@cicord/sdk";
import { tr } from "./data.ts";

export type Method = "button" | "visual" | "turnstile" | "hcaptcha";
type Challenge = { id: string; method: Method; answer?: number };
const providers = {
  turnstile: {
    url: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    secret: "TURNSTILE_SECRET",
  },
  hcaptcha: { url: "https://api.hcaptcha.com/siteverify", secret: "HCAPTCHA_SECRET" },
} as const;
const siteKey = (ctx: Context, method: "turnstile" | "hcaptcha") =>
  method === "turnstile" ? ctx.config.turnstileSiteKey : ctx.config.hcaptchaSiteKey;

export function methodFor(ctx: Context, member?: Member): Method {
  const method = ctx.config.method;
  if (method === "turnstile" || method === "hcaptcha") {
    if (
      ctx.features.enabled("captcha") &&
      siteKey(ctx, method) &&
      ctx.secrets.has(providers[method].secret)
    )
      return method;
  } else if (method === "button" && (!member || member.user.avatarUrl)) return method;
  return ctx.features.enabled("visual") ? "visual" : "button";
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

export async function begin(ctx: Context, member: Member): Promise<Json> {
  const method = methodFor(ctx, member);
  // Identity comes from the signed member session. This nonce separates attempts and
  // rotations; it is never an authentication credential.
  const id = crypto.randomUUID();
  if (method === "visual") {
    const answer = 1 + (crypto.getRandomValues(new Uint8Array(1))[0]! % 5);
    await ctx.kv.set("challenge:" + member.id, { id, method, answer }, { ttlSeconds: 180 });
    const layers = Array.from({ length: answer }, (_, i) => ({
      type: "rect" as const,
      x: 15 + i * 38,
      y: 12 + Math.floor(Math.random() * 30),
      width: 22,
      height: 22,
      color: "#243b72",
    }));
    const image = await ctx.render.image({ width: 210, height: 80, background: "#f4f7fb", layers });
    return {
      id,
      method,
      image: "data:image/png;base64," + base64(image.data),
      choices: [1, 2, 3, 4, 5],
      prompt: tr(ctx, "message.howManySquaresAreInThe"),
    };
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
  if (method !== methodFor(ctx, member)) return;
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
