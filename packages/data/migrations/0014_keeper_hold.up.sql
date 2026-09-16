alter table keeper_job_state add column held_reason text;
alter table keeper_job_state add column held_since bigint;

create index keeper_job_state_held on keeper_job_state (chain_id, held_reason)
  where held_reason is not null;
