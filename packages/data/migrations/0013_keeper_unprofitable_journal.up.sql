alter table keeper_job_state add column unprofitable_journaled_at timestamptz;

insert into keeper_job_state (chain_id, job_id, unprofitable_journaled_at)
select chain_id, job_id, min(created_at) from keeper_actions
where action = 'skipped' and reason = 'unprofitable'
group by chain_id, job_id
on conflict (chain_id, job_id) do update set unprofitable_journaled_at = coalesce(keeper_job_state.unprofitable_journaled_at, excluded.unprofitable_journaled_at);
