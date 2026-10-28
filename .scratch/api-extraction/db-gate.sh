#!/usr/bin/env bash
# Run a disposable-schema DB gate against the throwaway local Postgres 17
# (port 55432, socket /tmp/nfpgsock, pgvector installed). Never the shared Neon DB.
# Usage: .scratch/api-extraction/db-gate.sh bun run test:workflow:db
set -euo pipefail
URL="postgresql://postgres@localhost:55432/narriflow_gate?host=/tmp/nfpgsock"
export DATABASE_URL="$URL" DIRECT_URL="$URL"
for p in AUTHENTICATED_REQUEST_POLICY CLIP_EDITOR_PERSISTENCE INTEGRATION LIBRARY_SEARCH \
         PROCESSING_USAGE SOCIAL_PUBLICATION UPLOAD_SESSION WORKFLOW WORKSPACE_BILLING \
         BRAND_PROFILES BRAND_PROFILE VIZARD_EXPANSION; do
  export "${p}_TEST_DATABASE_URL=$URL"
done
if ! pg_ctl -D /tmp/nfpg-gate status >/dev/null 2>&1; then
  LC_ALL=C pg_ctl -D /tmp/nfpg-gate -o "-p 55432 -k /tmp/nfpgsock -c max_connections=300" -l /tmp/nfpg-gate.log start >/dev/null
  sleep 2
fi
exec "$@"
