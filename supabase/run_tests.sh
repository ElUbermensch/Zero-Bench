#!/bin/bash
# Rebuild the database from the migration and run the test suite against it.
# A clean build every time, so a green run means the migration itself is sound.
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# postgres runs as its own user, so stage a world-readable copy
rm -rf /tmp/sbrun && cp -r "$HERE" /tmp/sbrun && chmod -R a+rX /tmp/sbrun
su postgres -c "dropdb --if-exists shooting" 2>/dev/null || true
su postgres -c "createdb shooting"
su postgres -c "psql -q -d shooting -v ON_ERROR_STOP=1 -f /tmp/sbrun/test/harness.sql"
for m in /tmp/sbrun/migrations/*.sql; do
  su postgres -c "psql -q -d shooting -v ON_ERROR_STOP=1 -f $m"
done
su postgres -c "psql -q -d shooting -c 'create schema test; grant usage on schema test to authenticated;'"
for t in /tmp/sbrun/test/rls_test.sql /tmp/sbrun/test/rls_test2.sql; do
  su postgres -c "psql -d shooting -v ON_ERROR_STOP=1 -f $t" 2>&1 \
    | grep -E "PASS|FAIL|ERROR|ASSERTIONS" | sed 's/^NOTICE:  //'
done
