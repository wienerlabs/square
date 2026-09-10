drop index keeper_actions_by_job;

drop index jobs_expired_with_agent;

alter table jobs drop column refund_reason;
