create table hosted_agents (
  id            uuid          primary key,
  owner         bytea         not null,
  agent_id      numeric(78,0),
  config        jsonb         not null,
  secret_ref    text,
  budget_limit  numeric(20,0) not null,
  budget_spent  numeric(20,0) not null default 0,
  state         text          not null,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);
