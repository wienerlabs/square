alter table jobs add column refund_reason text;

create index jobs_expired_with_agent on jobs (chain_id, job_id) where status = 5 and agent_id is not null;

create index keeper_actions_by_job on keeper_actions (chain_id, job_id, action);
