export type TokenKind = "key" | "string" | "number" | "literal" | "punct" | "space" | "other";

interface Token {
  kind: TokenKind;
  text: string;
}

const TOKEN = /("(?:\\.|[^"\\\n])*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)|(.)/g;

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  for (const match of line.matchAll(TOKEN)) {
    const [, string, colon, number, literal, punct, space, other] = match;
    if (string !== undefined) {
      tokens.push({ kind: colon ? "key" : "string", text: string });
      if (colon) tokens.push({ kind: "punct", text: colon });
    } else if (number !== undefined) tokens.push({ kind: "number", text: number });
    else if (literal !== undefined) tokens.push({ kind: "literal", text: literal });
    else if (punct !== undefined) tokens.push({ kind: "punct", text: punct });
    else if (space !== undefined) tokens.push({ kind: "space", text: space });
    else if (other !== undefined) tokens.push({ kind: "other", text: other });
  }
  return tokens;
}

export function errorLine(message: string | null | undefined, source: string): number | null {
  if (!message) return null;
  const byLine = /line (\d+)/.exec(message);
  if (byLine) return Math.max(1, Number(byLine[1]));
  const byPosition = /position (\d+)/.exec(message);
  if (byPosition) {
    const position = Math.min(Number(byPosition[1]), source.length);
    return source.slice(0, position).split("\n").length;
  }
  return source.length === 0 ? null : source.split("\n").length;
}
