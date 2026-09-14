create table keeper_job_state (
  chain_id            bigint        not null,
  job_id              numeric(78,0) not null,
  finalize_gave_up    boolean       not null default false,
  expiry_recorded_at  timestamptz,
  expiry_attempts     integer       not null default 0,
  expiry_next_at      bigint,
  expiry_gave_up      boolean       not null default false,
  updated_at          timestamptz   not null default now(),
  primary key (chain_id, job_id)
);

create index keeper_job_state_expiry_open on keeper_job_state (chain_id, expiry_next_at)
  where expiry_recorded_at is null and not expiry_gave_up;

insert into keeper_job_state (chain_id, job_id, finalize_gave_up)
select distinct chain_id, job_id, true from keeper_actions where gave_up
on conflict (chain_id, job_id) do update set finalize_gave_up = true;

insert into keeper_job_state (chain_id, job_id, expiry_recorded_at)
select chain_id, job_id, min(created_at) from keeper_actions
where action = 'recordExpiry' and reason is null
group by chain_id, job_id
on conflict (chain_id, job_id) do update set expiry_recorded_at = excluded.expiry_recorded_at;
