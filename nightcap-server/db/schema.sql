-- Nightcap's own data: accounts, their profiles, and everything each profile watches.
-- Stremio is only used for what its add-ons give us (streams via AIOStreams, subtitles);
-- Cinemeta (a free public service) still supplies episode numbering, TMDB everything else.
--
-- The server applies this itself when it starts, whenever it has changed (nightcap/schema.py): safe
-- to run again (IF NOT EXISTS, IF EXISTS). Drop a column or table only in a version after the one
-- that stopped using it, since every server applies it by itself.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), and encrypting secrets

-- ---------- Accounts and profiles ----------

-- A household. Holds the keys everyone shares.
CREATE TABLE IF NOT EXISTS accounts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The account's secrets, encrypted with the server's SECRETS_KEY (pgp_sym_encrypt).
CREATE TABLE IF NOT EXISTS account_secrets (
    account_id      uuid PRIMARY KEY REFERENCES accounts ON DELETE CASCADE,
    aiostreams_url  bytea,          -- the add-on address, which carries the debrid setup
    subtitle_urls   bytea,          -- JSON list of subtitle add-on addresses
    stream_urls     bytea,          -- JSON list of extra stream add-ons AIOStreams can't reach
    ai_api_key      bytea,          -- the key for the AI that picks and searches (whose: ai_provider)
    updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE account_secrets ADD COLUMN IF NOT EXISTS stream_urls bytea;
-- An older name of ai_api_key, renamed in place.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'account_secrets' AND column_name = 'claude_api_key') THEN
        ALTER TABLE account_secrets RENAME COLUMN claude_api_key TO ai_api_key;
    END IF;
END $$;

-- Who's watching. Settings is a small JSON document (languages, Top 10 countries, row count,
-- audio/subtitle language, trailer volume…) so new settings don't need a schema change.
CREATE TABLE IF NOT EXISTS profiles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    name        text NOT NULL,
    avatar      text,
    settings    jsonb NOT NULL DEFAULT '{}',
    is_admin    boolean NOT NULL DEFAULT false,  -- may add, change and remove profiles
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, name)
);
ALTER TABLE profiles DROP COLUMN IF EXISTS position;

-- ---------- What each profile watches ----------

-- One row per title a profile has watched (any amount) or follows. Marking a title unwatched
-- with nothing else watched removes its row, so it no longer counts as history.
CREATE TABLE IF NOT EXISTS library (
    profile_id         uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    imdb_id            text NOT NULL,
    type               text NOT NULL CHECK (type IN ('movie', 'series')),
    notify             boolean NOT NULL DEFAULT true,  -- "+N new episodes" alerts on (series)
    current_video_id   text,                           -- the episode you're on (series)
    position_ms        bigint NOT NULL DEFAULT 0,      -- where you stopped in it
    duration_ms        bigint NOT NULL DEFAULT 0,
    overall_watched_ms bigint NOT NULL DEFAULT 0,      -- running total for the title (includes imported history)
    times_watched      int NOT NULL DEFAULT 0,         -- finished viewings, running total (includes imported history)
    watched            boolean NOT NULL DEFAULT false, -- a film marked or played to the end
    added_at           timestamptz NOT NULL DEFAULT now(),
    last_watched_at    timestamptz,
    PRIMARY KEY (profile_id, imdb_id)
);
-- "Not for me" when leaving early takes a title out of Continue watching until it's played again.
ALTER TABLE library ADD COLUMN IF NOT EXISTS continue_hidden_at timestamptz;
-- The audio language picked in the player for this title ("hi"), so its next episode opens in it.
ALTER TABLE library ADD COLUMN IF NOT EXISTS audio_pick text;
-- The subtitles picked in the player for this title ("eng", or "off"), so its next episode opens with them.
ALTER TABLE library ADD COLUMN IF NOT EXISTS subtitle_pick text;
ALTER TABLE library DROP COLUMN IF EXISTS followed;
ALTER TABLE library DROP COLUMN IF EXISTS time_watched_ms;
ALTER TABLE library DROP COLUMN IF EXISTS updated_at;
CREATE INDEX IF NOT EXISTS library_recent ON library (profile_id, last_watched_at DESC);

-- Episode ticks (Stremio kept these as a compressed bit list; here it's one row per episode).
CREATE TABLE IF NOT EXISTS episode_watched (
    profile_id  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    video_id    text NOT NULL,                  -- "tt…:season:episode", Cinemeta numbering
    imdb_id     text NOT NULL,
    watched_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, video_id)
);
CREATE INDEX IF NOT EXISTS episode_watched_show ON episode_watched (profile_id, imdb_id);

-- Every play session, for the recommendation engine: when, how much was really watched,
-- how far, whether it finished, why it was left early (an optional tap), and where it came from.
CREATE TABLE IF NOT EXISTS watch_events (
    id              bigserial PRIMARY KEY,
    profile_id      uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    imdb_id         text NOT NULL,
    video_id        text NOT NULL,
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    played_ms       bigint NOT NULL DEFAULT 0,       -- real playback time (no pauses, no skipping)
    position_ms     bigint NOT NULL DEFAULT 0,
    duration_ms     bigint NOT NULL DEFAULT 0,
    finished        boolean NOT NULL DEFAULT false,
    exit_reason     text CHECK (exit_reason IN ('not_my_taste', 'pausing')),
    audio_language  text,
    origin          text CHECK (origin IN ('row', 'search', 'continue', 'up_next', 'direct')),
    row_key         text,                            -- the Home row it came from, if any
    slot            int,                             -- its position in that row
    request_id      text,                            -- the engine response it came from
    model_version   text
);
ALTER TABLE watch_events DROP COLUMN IF EXISTS updated_at;
ALTER TABLE watch_events
    ADD COLUMN IF NOT EXISTS ended_at timestamptz,
    ADD COLUMN IF NOT EXISTS played_ms bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS exit_reason text CHECK (exit_reason IN ('not_my_taste', 'pausing')),
    ADD COLUMN IF NOT EXISTS audio_language text,
    ADD COLUMN IF NOT EXISTS origin text CHECK (origin IN ('row', 'search', 'continue', 'up_next', 'direct')),
    ADD COLUMN IF NOT EXISTS row_key text,
    ADD COLUMN IF NOT EXISTS slot int,
    ADD COLUMN IF NOT EXISTS request_id text,
    ADD COLUMN IF NOT EXISTS model_version text;
DROP INDEX IF EXISTS watch_events_recent;
CREATE INDEX IF NOT EXISTS watch_events_by_start ON watch_events (profile_id, started_at DESC);

-- Titles a profile said "Not interested" to: never shown in rows, and a signal for the
-- recommender to avoid them and close lookalikes. (Clearing something you started by
-- accident is "Mark as unwatched", which simply removes it from the library.)
CREATE TABLE IF NOT EXISTS not_interested (
    profile_id  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    imdb_id     text NOT NULL,
    marked_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, imdb_id)
);
ALTER TABLE not_interested DROP COLUMN IF EXISTS name, DROP COLUMN IF EXISTS type;

-- Deliberate actions only (nothing passive: a TV left on proves nothing). Each is linked to
-- where it happened and, for engine rows, to the engine response that showed it.
CREATE TABLE IF NOT EXISTS interactions (
    id             bigserial PRIMARY KEY,
    profile_id     uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    imdb_id        text NOT NULL,
    kind           text NOT NULL CHECK (kind IN ('opened', 'played', 'searched_opened', 'not_interested', 'remind_me')),
    at             timestamptz NOT NULL DEFAULT now(),
    origin         text CHECK (origin IN ('row', 'search', 'continue', 'up_next', 'direct')),
    row_key        text,
    slot           int,
    request_id     text,
    model_version  text
);
CREATE INDEX IF NOT EXISTS interactions_recent ON interactions (profile_id, at DESC);

-- How a profile rated a title: -1 dislike, 1 like, 2 love (asked at the end, or on its page).
CREATE TABLE IF NOT EXISTS ratings (
    profile_id  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    imdb_id     text NOT NULL,
    value       smallint NOT NULL CHECK (value IN (-1, 1, 2)),
    rated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, imdb_id)
);
DROP TABLE IF EXISTS hidden;

-- A profile's My List: titles it put aside to watch, newest first on Home. A film leaves it once
-- finished (or marked watched); a show stays until taken off.
CREATE TABLE IF NOT EXISTS my_list (
    profile_id  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    imdb_id     text NOT NULL,
    type        text NOT NULL CHECK (type IN ('movie', 'series')),
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, imdb_id)
);

-- Which one-time questions a profile has been asked about a title (so each is asked once):
-- the rating at the end, and the "leaving early?" card.
CREATE TABLE IF NOT EXISTS prompts (
    profile_id  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    imdb_id     text NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('rating', 'early_exit')),
    shown_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, imdb_id, kind)
);

-- ---------- Each profile's Home ----------

-- Which rows get used, so ignored rotating rows drop out.
CREATE TABLE IF NOT EXISTS row_stats (
    profile_id   uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    row_key      text NOT NULL,
    shown_since  timestamptz,
    last_opened  timestamptz,
    PRIMARY KEY (profile_id, row_key)
);

-- The latest recommendations (For You, Because you watched…) and what they were built from.
CREATE TABLE IF NOT EXISTS recommendations (
    profile_id     uuid PRIMARY KEY REFERENCES profiles ON DELETE CASCADE,
    built_at       timestamptz NOT NULL DEFAULT now(),
    fingerprint    text,                        -- of the history it was built from
    taste_summary  text,
    seeds          jsonb NOT NULL DEFAULT '[]',
    rows           jsonb NOT NULL DEFAULT '{}'  -- row id -> list of titles with reasons
);

CREATE TABLE IF NOT EXISTS recent_searches (
    profile_id    uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    query         text NOT NULL,
    searched_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, query)
);

-- Links sent from the phone to this profile, with where playback is up to and a picture.
CREATE TABLE IF NOT EXISTS sent_links (
    id           bigserial PRIMARY KEY,
    profile_id   uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    url          text NOT NULL,
    name         text NOT NULL,
    sent_at      timestamptz NOT NULL DEFAULT now(),
    position_ms  bigint NOT NULL DEFAULT 0,
    duration_ms  bigint NOT NULL DEFAULT 0,
    thumb        bytea                          -- small JPEG grabbed by the TV
);
ALTER TABLE sent_links DROP COLUMN IF EXISTS watched_at;
CREATE INDEX IF NOT EXISTS sent_links_recent ON sent_links (profile_id, sent_at DESC);

-- ---------- Shared by the account ----------

-- AI calls and what they cost, for the "AI $x this month" chip and the monthly limit.
-- An older name of ai_usage (claude_usage) is renamed in place.
DO $$ BEGIN
    IF to_regclass('claude_usage') IS NOT NULL AND to_regclass('ai_usage') IS NULL THEN
        ALTER TABLE claude_usage RENAME TO ai_usage;
        ALTER SEQUENCE claude_usage_id_seq RENAME TO ai_usage_id_seq;
        ALTER INDEX claude_usage_month RENAME TO ai_usage_month;
        ALTER INDEX claude_usage_pkey RENAME TO ai_usage_pkey;
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS ai_usage (
    id             bigserial PRIMARY KEY,
    account_id     uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    profile_id     uuid REFERENCES profiles ON DELETE SET NULL,
    called_at      timestamptz NOT NULL DEFAULT now(),
    purpose        text NOT NULL,
    model          text NOT NULL,
    input_tokens   int NOT NULL,
    output_tokens  int NOT NULL,
    cost_usd       numeric(10, 6)                -- NULL: not known (the model had no price)
);
ALTER TABLE ai_usage ALTER COLUMN cost_usd DROP NOT NULL;
CREATE INDEX IF NOT EXISTS ai_usage_month ON ai_usage (account_id, called_at);

-- ---------- Shared by everyone: title knowledge ----------

-- Details for a title, from TMDB (what you see) and Cinemeta (episode numbering).
CREATE TABLE IF NOT EXISTS titles (
    imdb_id     text PRIMARY KEY,
    type        text NOT NULL CHECK (type IN ('movie', 'series')),
    tmdb_id     int,
    name        text,
    language    text,                           -- original language, e.g. "hi"
    genres      int[] NOT NULL DEFAULT '{}',    -- TMDB genre ids
    poster      text,
    backdrop    text,
    overview    text,
    rating      numeric(3, 1),
    trailer     text,                           -- YouTube key
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- What the recommendation engine reads about a title (all from the same TMDB request).
ALTER TABLE titles
    ADD COLUMN IF NOT EXISTS keywords        text[] NOT NULL DEFAULT '{}',  -- "heist", "time travel"
    ADD COLUMN IF NOT EXISTS keyword_ids     int[]  NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS "cast"          jsonb  NOT NULL DEFAULT '[]',  -- top 5: [{id, name}]
    ADD COLUMN IF NOT EXISTS creators        jsonb  NOT NULL DEFAULT '[]',  -- director(s) / series creator(s): [{id, name}]
    ADD COLUMN IF NOT EXISTS vote_count      int,
    ADD COLUMN IF NOT EXISTS popularity      numeric(10, 3),
    ADD COLUMN IF NOT EXISTS release_date    date,                          -- film release / first episode
    ADD COLUMN IF NOT EXISTS status          text,                          -- Released, Returning Series, Ended…
    ADD COLUMN IF NOT EXISTS runtime_min     int,                           -- films; typical episode length for series
    ADD COLUMN IF NOT EXISTS seasons         int,
    ADD COLUMN IF NOT EXISTS episode_count   int,
    ADD COLUMN IF NOT EXISTS origin_country  text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS collection      jsonb,                         -- franchise: {id, name}
    ADD COLUMN IF NOT EXISTS certification   jsonb;                         -- age rating by country: {"CA": "14A", "US": "PG-13", "IN": "UA"}
ALTER TABLE titles DROP COLUMN IF EXISTS year, DROP COLUMN IF EXISTS logo;

-- A show's episodes in Cinemeta's numbering (what the stream add-ons expect), with TMDB's
-- names, stills and air dates laid over it.
CREATE TABLE IF NOT EXISTS episodes (
    video_id    text PRIMARY KEY,               -- "tt…:season:episode"
    imdb_id     text NOT NULL,
    season      int NOT NULL,
    episode     int NOT NULL,
    name        text,
    overview    text,
    still       text,
    released    timestamptz,
    rating      numeric(3, 1)
);
CREATE INDEX IF NOT EXISTS episodes_show ON episodes (imdb_id, season, episode);

-- ---------- Account settings, kept lookups, and failures ----------

-- What differs between households: {"timezone", "country", "location": {lat, lon, city, countryCode},
-- "ai_monthly_limit_usd", "home_defaults"}. Missing keys use the server's defaults (config.py).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
-- Older settings named for Claude, renamed in place (values kept).
UPDATE accounts SET settings = (settings - 'claude_monthly_limit_usd')
                               || jsonb_build_object('ai_monthly_limit_usd', settings -> 'claude_monthly_limit_usd')
 WHERE settings ? 'claude_monthly_limit_usd';
UPDATE profiles SET settings = (settings - 'show_claude') || jsonb_build_object('show_ai', settings -> 'show_claude')
 WHERE settings ? 'show_claude';

-- Slow lookups worth keeping across restarts (TMDB ids, title details, TVmaze air times).
-- Shared by everyone; each is looked up again once it's older than its own limit.
CREATE TABLE IF NOT EXISTS lookups (
    key       text PRIMARY KEY,
    value     jsonb,
    saved_at  timestamptz NOT NULL DEFAULT now()
);

-- Add-ons that failed and streams that wouldn't play, so a bad source can be found and dropped.
CREATE TABLE IF NOT EXISTS source_failures (
    id          bigserial PRIMARY KEY,
    account_id  uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    profile_id  uuid REFERENCES profiles ON DELETE SET NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    video_id    text NOT NULL,
    addon       text NOT NULL,              -- the add-on's name, never its address (that has keys in it)
    kind        text NOT NULL CHECK (kind IN ('lookup_failed', 'lookup_timed_out', 'wont_play', 'seen_dead')),
    detail      text                        -- the error, or the stream's file name; seen_dead: the file's key only
);
CREATE INDEX IF NOT EXISTS source_failures_recent ON source_failures (account_id, at DESC);
-- seen_dead: one occasion a file looked gone (playlinks.py). Twice, 30 min apart: it's tried last.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_failures_kind_check'
                   AND pg_get_constraintdef(oid) LIKE '%seen_dead%') THEN
        ALTER TABLE source_failures DROP CONSTRAINT IF EXISTS source_failures_kind_check;
        ALTER TABLE source_failures ADD CONSTRAINT source_failures_kind_check
            CHECK (kind IN ('lookup_failed', 'lookup_timed_out', 'wont_play', 'seen_dead'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS source_failures_seen ON source_failures (account_id, video_id, at DESC) WHERE kind = 'seen_dead';

-- The code a new TV joins the household with (shown to the admin in Settings).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS join_code text UNIQUE;

-- TVs that have joined a household. Each sends its key with every request; only its hash is kept.
CREATE TABLE IF NOT EXISTS devices (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    key_hash    text NOT NULL UNIQUE,
    name        text,
    joined_at   timestamptz NOT NULL DEFAULT now()
);
-- What kind of device, and when it was last used (saved at most every 5 minutes).
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'tv' CHECK (kind IN ('tv', 'browser')),
    ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
-- The household's admin profile manages the household, not a device.
ALTER TABLE devices DROP COLUMN IF EXISTS is_admin;
-- The device itself (a hash of the id it sends when joining): one joining again replaces its own
-- entry instead of adding another.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS install_hash text;

-- Which AI the key in ai_api_key is for (ai.PROVIDERS: "anthropic", "openai", "openrouter", "other").
ALTER TABLE account_secrets ADD COLUMN IF NOT EXISTS ai_provider text;
-- The AI's model, its address (an OpenAI-compatible service of the household's own) and the price the
-- household gave for it ([input, output] US dollars per million tokens, as JSON), encrypted like the key.
ALTER TABLE account_secrets
    ADD COLUMN IF NOT EXISTS ai_model bytea,
    ADD COLUMN IF NOT EXISTS ai_base_url bytea,
    ADD COLUMN IF NOT EXISTS ai_price bytea;

-- The player sites list is no longer used.
ALTER TABLE account_secrets DROP COLUMN IF EXISTS player_sites;

-- A kept lookup or page that was cleared (watch state changed, settings changed…): not used, and
-- not overwritten by a value that was being worked out before it was cleared.
ALTER TABLE lookups ADD COLUMN IF NOT EXISTS dropped boolean NOT NULL DEFAULT false;

-- When a link was last played (the TV saves where it's up to as it plays).
ALTER TABLE sent_links ADD COLUMN IF NOT EXISTS played_at timestamptz;

-- Play on TV: a title or a link sent to one TV, waiting for the TV's 10-second check to pick it
-- up, then for whoever is at the TV to say yes or no. Kept only briefly (see playon.py).
CREATE TABLE IF NOT EXISTS tv_requests (
    id            bigserial PRIMARY KEY,
    account_id    uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    device_id     uuid NOT NULL REFERENCES devices ON DELETE CASCADE,
    from_profile  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    what          jsonb NOT NULL,              -- {"title": {...}} or {"link": {...}}, with what the pop-up shows
    status        text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'shown', 'accepted', 'declined', 'unreachable')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    answered_at   timestamptz
);
CREATE INDEX IF NOT EXISTS tv_requests_waiting ON tv_requests (device_id, created_at) WHERE status = 'waiting';

-- The admin profile's PIN: admin actions (sources and keys, devices, profiles, the household's
-- settings) need an admin session, which the PIN unlocks for one device for a while. Stored as a
-- salted scrypt hash; wrong tries lock it for a while (see adminpin.py).
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS pin_hash text,
    ADD COLUMN IF NOT EXISTS pin_failures int NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz;
-- An unlocked admin session: one device, the admin profile, until it expires (renewed while used).
-- Only the token's hash is kept. Removing the device, changing the PIN or the owner resetting it ends it.
CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash  text PRIMARY KEY,
    device_id   uuid NOT NULL REFERENCES devices ON DELETE CASCADE,
    profile_id  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_device ON admin_sessions (device_id);

-- Playback links: a play answer's real stream and subtitle links stay here (encrypted with
-- SECRETS_KEY, like the household's sources); devices get /s/{token}/{n} instead, which works for a
-- few hours and only while the device is still in the household (see playlinks.py). Only the
-- token's hash is kept.
CREATE TABLE IF NOT EXISTS play_links (
    token_hash  text PRIMARY KEY,
    account_id  uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    device_id   uuid NOT NULL REFERENCES devices ON DELETE CASCADE,
    links       bytea NOT NULL,              -- the JSON list of upstream addresses, encrypted
    expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS play_links_expiry ON play_links (expires_at);

-- Invites (join codes) that expire: only a keyed hash of the code is kept (HMAC with SECRETS_KEY, so a
-- copy of the database alone can't be tried against every code), and it works until join_code_expires.
-- The old plain codes stop working: the owner makes new invites.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS join_code_hash text UNIQUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS join_code_expires timestamptz;
UPDATE accounts SET join_code = NULL WHERE join_code IS NOT NULL;

-- Wrong join codes and owner keys, per address (a hash of it), for WINDOW_S in tries.py: shared by
-- every copy of the server. Unlogged: it's a few minutes' worth, and losing it in a crash is fine.
CREATE UNLOGGED TABLE IF NOT EXISTS wrong_tries (
    kind  text NOT NULL,                 -- 'join' or 'owner'
    who   text NOT NULL,                 -- a hash of the address
    at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wrong_tries_by ON wrong_tries (kind, at, who);

-- Nightcap's own AIOStreams (running next to the server): the household's debrid keys
-- (JSON {"servicea": "…", …}) and its setup there (JSON {"uuid", "password", "encryptedPassword",
-- "url"}), both encrypted like the other secrets.
ALTER TABLE account_secrets ADD COLUMN IF NOT EXISTS debrid_keys bytea;
ALTER TABLE account_secrets ADD COLUMN IF NOT EXISTS aiostreams_setup bytea;

-- The household setup the server's owner chose for this server's own AIOStreams (an AIOStreams
-- setup, as JSON, its debrid services' keys left empty), in place of the built-in one (see
-- own_aiostreams.py; its address is a setting). One row or none.
CREATE TABLE IF NOT EXISTS own_aiostreams (
    one             boolean PRIMARY KEY DEFAULT true CHECK (one),
    template        jsonb NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
-- (A row from before the address became a setting is taken out once, so the built-in setup is used.)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = 'own_aiostreams' AND column_name = 'url') THEN
        DELETE FROM own_aiostreams;
        ALTER TABLE own_aiostreams DROP COLUMN url, DROP COLUMN IF EXISTS services, DROP COLUMN IF EXISTS need_a_service;
    END IF;
END $$;

-- Invites, one device each: an invite's code joins one TV or browser, then stops working (or after
-- 24 hours unused). Several may be open at once. [label] is who or what it's for ("Bedroom TV"),
-- and becomes the name of the device that joins with it. Made by the server's owner or the
-- household's admin profile ([made_by]). Only a keyed hash of the code is kept.
CREATE TABLE IF NOT EXISTS invites (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    code_hash   text NOT NULL UNIQUE,
    label       text,
    made_by     text NOT NULL CHECK (made_by IN ('owner', 'admin')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    used_by     uuid                    -- the device that joined (no reference: it may be removed later)
);
CREATE INDEX IF NOT EXISTS invites_by_account ON invites (account_id, created_at DESC);
-- The one invite a household had before (accounts.join_code_hash) carries on as a one-time invite
-- until it expires; the old columns are no longer used.
INSERT INTO invites (account_id, code_hash, made_by, expires_at)
    SELECT id, join_code_hash, 'owner', join_code_expires FROM accounts
    WHERE join_code_hash IS NOT NULL AND join_code_expires > now()
    ON CONFLICT (code_hash) DO NOTHING;
UPDATE accounts SET join_code_hash = NULL, join_code_expires = NULL WHERE join_code_hash IS NOT NULL;
-- A code for one device already in the household (its key lost: a browser's storage cleared, an app's
-- data wiped): joining with it gives that device a new key in place of its old one, instead of adding
-- another. Removing the device takes its open codes with it.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS for_device uuid REFERENCES devices ON DELETE CASCADE;

-- Which device each play session is on (the one that last reported its position), for the admin's
-- Devices page: what each one is watching now, or watched last. Progress stays the profile's.
ALTER TABLE watch_events ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices ON DELETE SET NULL;
-- When its position last moved: players keep reporting while paused, so the last report alone
-- doesn't say it's playing.
ALTER TABLE watch_events ADD COLUMN IF NOT EXISTS moved_at timestamptz;
CREATE INDEX IF NOT EXISTS watch_events_device ON watch_events (device_id, ended_at DESC) WHERE device_id IS NOT NULL;

-- ---------- Live TV (see livetv.py) ----------

-- The household's channel lists (M3U): JSON [{"url", "name"}], encrypted like its add-ons (a paid
-- list carries its account in the address).
ALTER TABLE account_secrets ADD COLUMN IF NOT EXISTS livetv_urls bytea;
-- Each list as last read, its channels already merged: their cards (name, logo, kind, places), and
-- apart from them their stream addresses, only unlocked to play one. Both compressed JSON, encrypted.
-- Read again when Live TV is opened and it's old. Not moved with a household: read again from the address.
CREATE TABLE IF NOT EXISTS livetv_lists (
    account_id  uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    list_id     text NOT NULL,              -- a hash of its address
    cards       bytea,                      -- none until it has been read once
    streams     bytea,                      -- {channel id: [address, …] best first}, or with the extension's: {v: 2, streams, how}
    count       int NOT NULL DEFAULT 0,     -- channels
    read_at     timestamptz,                -- when it was last read (or tried)
    error       text,                       -- why the last read failed (never the address)
    PRIMARY KEY (account_id, list_id)
);
-- The attributes the list's items have, last read ([{name, count}]: names only), for its Advanced settings.
ALTER TABLE livetv_lists ADD COLUMN IF NOT EXISTS fields jsonb;
-- A profile's own channels ("My channels"), in the order added.
CREATE TABLE IF NOT EXISTS livetv_favourites (
    profile_id  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    channel     text NOT NULL,              -- livetv.merge's id
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, channel)
);
-- How long a profile has watched each channel, and at what hour (the household's time; by_hour[1] is
-- midnight to 1), for the page's order and what's "usually on now".
CREATE TABLE IF NOT EXISTS livetv_watched (
    profile_id  uuid NOT NULL REFERENCES profiles ON DELETE CASCADE,
    channel     text NOT NULL,
    seconds     bigint NOT NULL DEFAULT 0,
    by_hour     int[] NOT NULL DEFAULT array_fill(0, ARRAY[24]),
    last_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, channel)
);
CREATE INDEX IF NOT EXISTS livetv_watched_last ON livetv_watched (profile_id, last_at DESC);
-- Channels that failed to play, in a row (playing once clears it): hidden for a while after a few.
CREATE TABLE IF NOT EXISTS livetv_failures (
    account_id   uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    channel      text NOT NULL,
    times        int NOT NULL DEFAULT 1,
    last_failed  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, channel)
);
-- …each device's own (a channel that won't play where one TV is may play on another, elsewhere).
-- The household-wide ones from before are dropped: each device starts again.
ALTER TABLE livetv_failures ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices ON DELETE CASCADE;
DELETE FROM livetv_failures WHERE device_id IS NULL;
ALTER TABLE livetv_failures ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE livetv_failures DROP CONSTRAINT IF EXISTS livetv_failures_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS livetv_failures_device ON livetv_failures (account_id, device_id, channel);
