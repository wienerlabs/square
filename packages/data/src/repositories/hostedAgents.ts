import type { Database } from "../database.js";
import { bytesToHex, hexToBytes, jsonParam, nullableBigIntParam, nullableToBigInt, toBigInt, type Hex, type Json } from "../codec.js";

export interface HostedAgentRecord {
  id: string;
  owner: Hex;
  agentId: bigint | null;
  config: Json;
  secretRef: string | null;
  budgetLimit: bigint;
  budgetSpent: bigint;
  state: string;
  createdAt: Date;
  updatedAt: Date;
}

export type HostedAgentInput = Omit<HostedAgentRecord, "createdAt" | "updatedAt">;

interface HostedAgentRow {
  id: string;
  owner: Uint8Array;
  agent_id: string | null;
  config: Json;
  secret_ref: string | null;
  budget_limit: string;
  budget_spent: string;
  state: string;
  created_at: Date;
  updated_at: Date;
}

export async function upsert(db: Database, agent: HostedAgentInput): Promise<void> {
  await db.query(
    `insert into hosted_agents (id, owner, agent_id, config, secret_ref, budget_limit, budget_spent, state)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do update set
       owner = excluded.owner,
       agent_id = excluded.agent_id,
       config = excluded.config,
       secret_ref = excluded.secret_ref,
       budget_limit = excluded.budget_limit,
       budget_spent = excluded.budget_spent,
       state = excluded.state,
       updated_at = now()`,
    [
      agent.id,
      hexToBytes(agent.owner),
      nullableBigIntParam(agent.agentId),
      jsonParam(agent.config),
      agent.secretRef,
      agent.budgetLimit.toString(),
      agent.budgetSpent.toString(),
      agent.state,
    ],
  );
}

export async function get(db: Database, id: string): Promise<HostedAgentRecord | null> {
  const { rows } = await db.query<HostedAgentRow>(
    "select id, owner, agent_id, config, secret_ref, budget_limit, budget_spent, state, created_at, updated_at from hosted_agents where id = $1",
    [id],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        owner: bytesToHex(row.owner),
        agentId: nullableToBigInt(row.agent_id),
        config: row.config,
        secretRef: row.secret_ref,
        budgetLimit: toBigInt(row.budget_limit),
        budgetSpent: toBigInt(row.budget_spent),
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
}
