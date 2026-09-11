alter table keeper_actions add column gave_up boolean not null default false;

create index keeper_actions_gave_up on keeper_actions (chain_id, job_id) where gave_up;
