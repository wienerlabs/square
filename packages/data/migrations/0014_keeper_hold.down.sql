drop index if exists keeper_job_state_held;

alter table keeper_job_state drop column if exists held_since;
alter table keeper_job_state drop column if exists held_reason;
