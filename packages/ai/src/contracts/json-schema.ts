import { z } from "zod";

type JsonObject = Record<string, unknown>;

/**
 * Convert a Zod schema to the JSON Schema subset that strict tool calling accepts on both
 * providers: every object closed (`additionalProperties: false`) and every property listed
 * in `required`. Optional values are expressed as nullable instead.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as JsonObject;
  delete json.$schema;
  return strictify(json) as JsonObject;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;
  const obj: JsonObject = {};
  for (const [key, value] of Object.entries(node as JsonObject)) obj[key] = strictify(value);
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
