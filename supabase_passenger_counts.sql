-- Run once in the Supabase SQL Editor for the project used by StopSense.
-- Writes are made by the FastAPI backend using SUPABASE_SERVICE_ROLE_KEY.
-- Do not put that key in frontend variables or commit it to source control.

create table if not exists public.passenger_counts (
  camera_id text primary key,
  bus_route text,
  observed_at timestamptz not null,
  boarding_count integer not null check (boarding_count >= 0),
  alighting_count integer not null check (alighting_count >= 0),
  occupancy_count integer check (occupancy_count is null or occupancy_count >= 0),
  confidence double precision not null check (confidence between 0 and 1),
  status text not null check (status in ('ok', 'degraded', 'offline', 'error'))
);

create table if not exists public.passenger_count_sessions (
  session_id uuid primary key,
  camera_id text not null,
  bus_route text,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null default 'active'
    check (status in ('active', 'completed', 'interrupted', 'error')),
  check (ended_at is null or ended_at >= started_at)
);

create table if not exists public.passenger_count_snapshots (
  snapshot_id uuid primary key,
  session_id uuid not null references public.passenger_count_sessions(session_id) on delete cascade,
  camera_id text not null,
  bus_route text,
  observed_at timestamptz not null,
  detected_now integer not null check (detected_now >= 0),
  total_detected integer not null check (total_detected >= 0),
  boarding_count integer not null check (boarding_count >= 0),
  alighting_count integer not null check (alighting_count >= 0),
  occupancy_count integer not null check (occupancy_count >= 0),
  confidence double precision not null check (confidence between 0 and 1),
  status text not null check (status in ('ok', 'degraded', 'offline', 'error'))
);

create index if not exists idx_passenger_sessions_started
  on public.passenger_count_sessions (started_at desc);
create index if not exists idx_passenger_snapshots_session_time
  on public.passenger_count_snapshots (session_id, observed_at desc);

-- These tables are only accessed server-side. The service-role key bypasses RLS.
alter table public.passenger_counts enable row level security;
alter table public.passenger_count_sessions enable row level security;
alter table public.passenger_count_snapshots enable row level security;

revoke all on table public.passenger_counts from anon, authenticated;
revoke all on table public.passenger_count_sessions from anon, authenticated;
revoke all on table public.passenger_count_snapshots from anon, authenticated;
grant all on table public.passenger_counts to service_role;
grant all on table public.passenger_count_sessions to service_role;
grant all on table public.passenger_count_snapshots to service_role;
