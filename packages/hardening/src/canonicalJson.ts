function serialise(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson cannot represent NaN or Infinity");
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson cannot represent bigint, convert it to a string or number first");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === "function") return serialise((withToJson.toJSON as () => unknown)());
  if (Array.isArray(value)) return `[${value.map((item) => serialise(item) ?? "null").join(",")}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .flatMap((key) => {
      const member = serialise(record[key]);
      return member === undefined ? [] : [`${JSON.stringify(key)}:${member}`];
    });
  return `{${members.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  const serialised = serialise(value);
  if (serialised === undefined) {
    throw new TypeError("canonicalJson cannot represent undefined, functions or symbols at the top level");
  }
  return serialised;
}
