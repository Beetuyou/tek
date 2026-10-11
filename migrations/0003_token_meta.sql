alter table indexed_tokens add column if not exists name text;
alter table indexed_tokens add column if not exists symbol text;
alter table indexed_tokens add column if not exists launchpad text;
alter table indexed_tokens add column if not exists created_at timestamptz;
alter table indexed_tokens add column if not exists market_cap double precision;

create table if not exists index_progress (
  provider text primary key,
  cursor_offset integer not null default 0,
  updated_at timestamptz not null default now()
);
