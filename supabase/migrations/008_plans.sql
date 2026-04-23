-- TripBrain — day-by-day itinerary ("trip plan") storage.
-- One row per trip. `days` is a jsonb array:
--   [{ day, date, title, items: [{ place_id, order, notes, checked, time_hint }] }]
-- We keep the whole plan in one jsonb cell because it's always read/written
-- as a unit, edits are small, and this avoids the complexity of a separate
-- plan_items table with ordering columns.

create table if not exists trip_plans (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade unique,
  title text default 'Trip Plan',
  days jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);

create index if not exists trip_plans_trip_id_idx on trip_plans(trip_id);

alter table trip_plans disable row level security;

grant select, insert, update, delete on trip_plans to anon, authenticated;
