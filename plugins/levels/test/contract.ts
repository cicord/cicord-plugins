/**
 * The subset of JSON Schema used by the interop contracts (type, properties, required,
 * additionalProperties: false, items, maxItems, minimum, min/maxLength). The runtime
 * validates every call against the provider's contract; a mocked `ctx.plugins.query` must
 * check the same shape or it hides an `invalid_input` rejection.
 */
type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};
const kind = (v: unknown) =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "array"
      : Number.isInteger(v)
        ? "integer"
        : typeof v === "number"
          ? "number"
          : typeof v;
export function violations(schema: Schema, value: unknown, path = "$"): string[] {
  const out: string[] = [];
  const types = schema.type === undefined ? [] : [schema.type].flat();
  const k = kind(value);
  if (types.length && !types.some((t) => t === k || (t === "number" && k === "integer")))
    return [`${path}: expected ${types.join("|")}, got ${k}`];
  if (k === "object") {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) out.push(`${path}.${r}: required`);
    for (const [key, v] of Object.entries(o)) {
      const sub = schema.properties?.[key];
      if (sub) out.push(...violations(sub, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${key}: not allowed`);
    }
  }
  if (k === "array") {
    const a = value as unknown[];
    if (schema.maxItems !== undefined && a.length > schema.maxItems)
      out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items)
      a.forEach((v, i) => out.push(...violations(schema.items!, v, `${path}[${i}]`)));
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      out.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      out.push(`${path}: too long`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: above maximum`);
  }
  return out;
}
