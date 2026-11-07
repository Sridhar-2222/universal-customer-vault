#!/usr/bin/env bash
# Applies the migrations to a throwaway LOCAL Postgres and runs the SQL access tests.
# Usage: PGURL=postgres://postgres@localhost:5432/postgres scripts/test-db.sh   (refuses anything not local)
set -euo pipefail
PGURL="${PGURL:?set PGURL to a local throwaway database}"
case "$PGURL" in *localhost*|*127.0.0.1*|*host=/*) ;; *) echo "Refusing: PGURL must be local" >&2; exit 2 ;; esac
DB="ucv_test_$$"; root="$(cd "$(dirname "$0")/.." && pwd)"
psql "$PGURL" -qAt -v ON_ERROR_STOP=1 -c "create database $DB"
trap 'psql "$PGURL" -qAt -c "drop database if exists $DB" >/dev/null' EXIT
T="${PGURL%/*}/$DB"
for f in "$root"/supabase/tests/0*.sql; do psql "$T" -qAt -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done  # stubs + Fingertip lookalikes
for f in "$root"/supabase/migrations/*.sql; do psql "$T" -qAt -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
out="$(cat "$root"/supabase/tests/[1-9]*.sql | psql "$T" -qAt -v ON_ERROR_STOP=1 2>&1)" || { echo "$out"; exit 1; }
echo "$out" | grep -E '^(PASS|FAIL)'
! echo "$out" | grep -q '^FAIL' && echo "All SQL tests passed"
