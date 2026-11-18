"""The database's tables, set up by the server itself when it starts (db/schema.sql): a new version
that adds a table or a column brings it, with no step for whoever deploys it. Only when the file has
changed since it was last applied (its fingerprint is kept in schema_applied), so an ordinary start
costs one small query; and under a Postgres advisory lock, so copies starting together apply it
once (a lock held for its transaction). Everything in schema.sql is safe to run again (IF NOT EXISTS, IF EXISTS).

Care, since every server applies it by itself: a column or table is dropped only in a version after
the one that stopped using it (a copy still on the old version may be running alongside)."""

import hashlib
import logging
import os

from . import store

log = logging.getLogger(__name__)

SCHEMA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db", "schema.sql")
# (Any fixed number: this lock is Nightcap's schema step.)
LOCK = 7_171_001


def apply():
    """Applies schema.sql if it changed since it was last applied. Raises if it can't: a server whose
    tables aren't right doesn't start (the deploy fails, rather than the app later)."""
    if not store.configured():
        return
    with open(SCHEMA, encoding="utf-8") as f:
        sql = f.read()
    fingerprint = hashlib.sha256(sql.encode()).hexdigest()
    with store.pool().connection() as c:
        try:
            # (A transaction lock: freed at commit or rollback, whichever connection pooler is in between.)
            c.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK,))
            # (A table busy with live traffic: the start fails fast and is tried again, never hangs.)
            c.execute("SET LOCAL lock_timeout = '5s'")
            c.execute("""CREATE TABLE IF NOT EXISTS schema_applied (
                             id          int PRIMARY KEY CHECK (id = 1),
                             fingerprint text NOT NULL,
                             applied_at  timestamptz NOT NULL DEFAULT now())""")
            row = c.execute("SELECT fingerprint FROM schema_applied WHERE id = 1").fetchone()
            if row and row["fingerprint"] == fingerprint:
                c.commit()
                return
            log.info("Setting up the database's tables (schema.sql changed)")
            c.execute(sql)
            c.execute("""INSERT INTO schema_applied (id, fingerprint) VALUES (1, %s)
                         ON CONFLICT (id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, applied_at = now()""",
                      (fingerprint,))
            c.commit()
            log.info("Database tables set up")
        except Exception:
            c.rollback()
            raise
