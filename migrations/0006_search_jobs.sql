create table if not exists search_jobs (
  id text primary key,
  url text not null,
  post_key text,
  mode text not null,
  status text not null,
  discovered integer not null default 0,
  scanned integer not null default 0,
  metadata_ok integer not null default 0,
  matches integer not null default 0,
  oldest_launch text,
  newest_launch text,
  sources text not null default '[]',
  hits text not null default '[]',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
