import { z } from "zod";

type JsonObject = Record<string, unknown>;

/**
 * Convert a Zod schema to the JSON Schema subset that strict tool calling accepts on both
 * providers: every object closed (`additionalProperties: false`) and every property listed
 * in `required`. Optional values are expressed as nullable instead. Limits strict mode
 * rejects (Claude: "For 'integer' type, properties maximum, minimum are not supported")
 * move into the description; the tool loop still checks every call against the Zod schema.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as JsonObject;
  delete json.$schema;
  return strictify(json) as JsonObject;
}

/** Keywords strict tool schemas reject. Zod writes some itself: `.int()` adds safe-integer bounds. */
const UNSUPPORTED_LIMITS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

/** Zod's `.int()` bounds: they say nothing a model needs to read. */
const SAFE_INTEGER_BOUNDS = new Set<unknown>([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);

function moveLimitsToDescription(obj: JsonObject): void {
  const limits: string[] = [];
  for (const key of UNSUPPORTED_LIMITS) {
    if (!(key in obj)) continue;
    if (!SAFE_INTEGER_BOUNDS.has(obj[key])) limits.push(`${key}: ${JSON.stringify(obj[key])}`);
    delete obj[key];
  }
  // Only 0 or 1 is accepted as minItems.
  if (typeof obj.minItems === "number" && obj.minItems > 1) {
    limits.push(`minItems: ${obj.minItems}`);
    delete obj.minItems;
  }
  if (limits.length) obj.description = `${obj.description ? `${obj.description} ` : ""}(${limits.join(", ")})`;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;
  const obj: JsonObject = {};
  for (const [key, value] of Object.entries(node as JsonObject)) {
    // Property names (e.g. a field called "minimum") are not keywords: keep them, recurse into each.
    obj[key] =
      key === "properties" && value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as JsonObject).map(([name, prop]) => [name, strictify(prop)]))
        : strictify(value);
  }
  moveLimitsToDescription(obj);
  const props = obj.properties as JsonObject | undefined;
  if (obj.type === "object" || props) {
    obj.type = "object";
    obj.properties = props ?? {};
    obj.required = Object.keys(props ?? {});
    obj.additionalProperties = false;
  }
  return obj;
}

/** Turn `null`s from strict-mode tool calls back into missing keys. */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
    return out as T;
  }
  return value;
}

/** Parameters typed as a union (`anyOf`, `oneOf` or a list of types): nullable ones count. */
export function countUnionParams(schema: unknown): number {
  if (Array.isArray(schema)) return schema.reduce((sum: number, item) => sum + countUnionParams(item), 0);
  if (!schema || typeof schema !== "object") return 0;
  const node = schema as JsonObject;
  const own = node.anyOf || node.oneOf || Array.isArray(node.type) ? 1 : 0;
  return own + Object.values(node).reduce((sum: number, value) => sum + countUnionParams(value), 0);
}

function allowsNull(schema: JsonObject): boolean {
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
  const variants = (schema.anyOf ?? schema.oneOf) as JsonObject[] | undefined;
  return Array.isArray(variants) && variants.some((variant) => allowsNull(variant));
}

/**
 * Without strict mode a model may leave out a property instead of sending null. Put the null
 * back wherever the schema allows one, so the Zod check sees what strict mode would send.
 */
export function fillMissingNulls(value: unknown, schema: JsonObject): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
      return value.map((item) => fillMissingNulls(item, schema.items as JsonObject));
    }
    return value;
  }
  const objectSchema = (schema.properties ? schema : ((schema.anyOf as JsonObject[] | undefined)?.find((v) => v.properties) ?? schema)) as JsonObject;
  const props = objectSchema.properties as Record<string, JsonObject> | undefined;
  if (!props) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, prop] of Object.entries(props)) {
    if (!(key in out)) {
      if (allowsNull(prop)) out[key] = null;
    } else {
      out[key] = fillMissingNulls(out[key], prop);
    }
  }
  return out;
}
