import { readFile } from "node:fs/promises";
import { AgentUriError, defaultFetchAgentUri } from "@mandate/did-resolver";
import { z } from "zod";
import { NetworkError, ValidationError } from "./errors.js";

/**
 * What the CLI needs to read out of an ERC-8004 Registration File.
 *
 * Deliberately loose. The authoritative shape is docs/agent-card/schema.json,
 * and the file is a document the owner controls at a URI the owner controls —
 * so the CLI shows the operator what they are about to point a registration at
 * and flags what looks wrong, rather than refusing to register over a field it
 * does not recognise. Anything unknown is preserved by passthrough.
 */
export const RegistrationFileSchema = z
  .object({
    type: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    registrations: z
      .array(
        z
          .object({
            agentId: z.union([z.number(), z.string()]).optional(),
            agentRegistry: z.string().optional(),
            agentAddress: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    services: z
      .array(z.object({ name: z.string().optional(), endpoint: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export type RegistrationFile = z.infer<typeof RegistrationFileSchema>;

export interface CardSummary {
  file: RegistrationFile;
  name: string | undefined;
  description: string | undefined;
  serviceCount: number;
  /** Not fatal. Each one is something the operator should look at before signing. */
  warnings: string[];
}

/**
 * Fetch and shape-check the file an agentURI points at.
 *
 * The fetcher is the resolver's own, so the CLI accepts exactly the schemes a
 * resolver will later accept — including its refusal of plain http. A card the
 * CLI could read but no resolver can is worse than a card that fails here.
 */
export async function loadCardFromUri(
  uri: string,
  opts: { ipfsGateway?: string | undefined; timeoutMs?: number | undefined } = {},
): Promise<CardSummary> {
  let doc: unknown;
  try {
    doc = await defaultFetchAgentUri(uri, {
      ...(opts.ipfsGateway !== undefined ? { ipfsGateway: opts.ipfsGateway } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NetworkError(
      `Could not read the agent card at ${uri}`,
      err instanceof AgentUriError
        ? `${message} Pass --no-card-check to register without reading it.`
        : message,
    );
  }
  return summarizeCard(doc, uri);
}

export async function loadCardFromFile(path: string): Promise<CardSummary> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new ValidationError(`Could not read ${path}: ${(err as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ValidationError(`${path} is not valid JSON`);
  }
  return summarizeCard(doc, path);
}

export function summarizeCard(doc: unknown, source: string): CardSummary {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new ValidationError(`${source} is not a JSON object`);
  }
  const parsed = RegistrationFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new ValidationError(
      `${source} is not a usable registration file: ` +
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  const file = parsed.data;
  const warnings: string[] = [];

  if (!file.name) warnings.push("no 'name' — the card will show as unnamed wherever it is listed");
  if (!file.type) warnings.push("no 'type' — see docs/agent-card/schema.json for the expected value");
  if (file.active === false) {
    warnings.push("'active' is false — a resolver will report this agent as deactivated");
  }
  // The chicken-and-egg of ERC-8004: the id is assigned by the mint, so a card
  // written before registration cannot already carry the right one.
  if (file.registrations?.some((r) => r.agentId !== undefined)) {
    warnings.push(
      "'registrations[].agentId' is already set — the id is assigned by this registration, " +
        "so update the card and call setAgentURI once you know it",
    );
  }

  return {
    file,
    name: file.name,
    description: file.description,
    serviceCount: file.services?.length ?? 0,
    warnings,
  };
}
