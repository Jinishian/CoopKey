-- CoopKey cloud schema (Cloudflare D1). Safe to run more than once.
CREATE TABLE IF NOT EXISTS users (
  id       TEXT PRIMARY KEY,
  email    TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  salt     TEXT NOT NULL,
  hash     TEXT NOT NULL,
  pw_ver   INTEGER NOT NULL DEFAULT 1,
  plan     TEXT NOT NULL DEFAULT 'free',
  joined   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vaults (
  user_id  TEXT PRIMARY KEY,
  data     TEXT NOT NULL,
  updated  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate (
  k TEXT NOT NULL,
  w INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (k, w)
);
