-- TripBrain — rolling history of previous trip plan versions.
-- Each entry is { days, title, saved_at }. We cap at 5 on write so the
-- column stays bounded (older versions fall off). The 'Undo' endpoint
-- pops the most recent entry and swaps it in as the current plan.

alter table trip_plans
  add column if not exists history jsonb default '[]'::jsonb;
