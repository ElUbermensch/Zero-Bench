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
su postgres -c "psql -q -d shooting -c 'create schema test; grant usage on schema test to authenticated, anon;'"
rc=0
# A glob, so a new suite is run the day it is written rather than the day
# someone remembers to add it to two lists. `sort -V` keeps rls_test9 before
# rls_test10, which plain glob order would not.
for t in $(ls /tmp/sbrun/test/rls_test*.sql | sort -V); do
  out=$(su postgres -c "psql -d shooting -v ON_ERROR_STOP=1 -f $t" 2>&1) || rc=1
  echo "$out" | grep -E "PASS|FAIL|ERROR|ASSERTIONS" | sed 's/^NOTICE:  //'
  # A psql ERROR aborts the script without ever printing FAIL, so grepping for
  # FAIL alone reported success on a suite that never finished.
  echo "$out" | grep -q "ERROR:" && rc=1
  echo "$out" | grep -q "FAIL" && rc=1
done
if [ $rc -ne 0 ]; then echo; echo "SUITE FAILED"; exit 1; fi
echo; echo "ALL SQL SUITES PASSED"
