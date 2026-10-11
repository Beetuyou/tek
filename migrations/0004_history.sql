alter table token_socials add column if not exists link_origin text not null default 'current';

alter table indexed_tokens add column if not exists metadata_checked_at timestamptz;

alter table index_progress add column if not exists oldest_at timestamptz;
alter table index_progress add column if not exists note text;

create table if not exists index_batches (
  id serial primary key,
  provider text not null,
  cursor_offset integer not null default 0,
  ok boolean not null,
  fetched integer not null default 0,
  stored integer not null default 0,
  oldest_at timestamptz,
  newest_at timestamptz,
  error text,
  finished_at timestamptz not null default now()
);

create index if not exists indexed_tokens_created_idx on indexed_tokens (created_at);
