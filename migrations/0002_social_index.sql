create table if not exists index_runs (
  id          serial primary key,
  provider    text not null,
  ok          boolean not null,
  fetched     integer not null default 0,
  stored      integer not null default 0,
  error       text,
  finished_at timestamptz not null default now()
);

create table if not exists indexed_tokens (
  chain    text not null,
  address  text not null,
  logo     text,
  dex_url  text,
  primary key (chain, address)
);

create table if not exists token_socials (
  id         serial primary key,
  chain      text not null,
  address    text not null,
  platform   text not null,
  post_key   text not null,
  raw_url    text not null,
  source     text not null,
  link_field text not null,
  current    boolean not null default true,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  unique (chain, address, post_key, source)
);

create index if not exists token_socials_post_key_idx on token_socials (post_key);
create index if not exists token_socials_token_idx on token_socials (chain, address);
