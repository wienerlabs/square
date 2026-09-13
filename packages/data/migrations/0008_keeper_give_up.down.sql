drop index if exists keeper_actions_gave_up;

alter table keeper_actions drop column if exists gave_up;
