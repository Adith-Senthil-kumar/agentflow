#!/usr/bin/env bash
#
# Applies migrations + metadata to the configured Hasura instance.
#
# Metadata refers to the handler host as {{ACTION_BASE_URL}}, which is the
# idiomatic Hasura way to keep an environment-specific URL out of version
# control. Hasura resolves that from its own environment; on nhost that means a
# variable added in the project dashboard. To keep `git clone && run` working
# without a dashboard visit, this script substitutes the value from your local
# .env into a throwaway copy of the metadata and applies that. Nothing
# environment-specific is written back into the tracked files.
#
# The shared webhook secret needs no such handling: metadata references
# NHOST_WEBHOOK_SECRET, which nhost injects into both Hasura and the functions
# runtime, so both sides agree without anything being copied between them.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
if [ -f .env ];       then set -a; . ./.env;       set +a; fi

: "${HASURA_GRAPHQL_ENDPOINT:?set HASURA_GRAPHQL_ENDPOINT in .env.local}"
: "${HASURA_GRAPHQL_ADMIN_SECRET:?set HASURA_GRAPHQL_ADMIN_SECRET in .env.local}"
: "${ACTION_BASE_URL:?set ACTION_BASE_URL in .env.local (your nhost functions base URL)}"

HASURA_BIN="${HASURA_BIN:-hasura}"
if ! command -v "$HASURA_BIN" >/dev/null 2>&1; then
  echo "hasura CLI not found. Install with: npm i -g hasura-cli" >&2
  exit 1
fi

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cp -R hasura/. "$BUILD/"

export ACTION_BASE_URL
find "$BUILD/metadata" -type f -name '*.yaml' -print0 \
  | xargs -0 perl -pi -e 's/\{\{ACTION_BASE_URL\}\}/$ENV{ACTION_BASE_URL}/g;'

echo "==> applying migrations"
"$HASURA_BIN" migrate apply --project "$BUILD" --database-name default \
  --endpoint "$HASURA_GRAPHQL_ENDPOINT" --admin-secret "$HASURA_GRAPHQL_ADMIN_SECRET" \
  --skip-update-check

echo "==> applying metadata (ACTION_BASE_URL=$ACTION_BASE_URL)"
"$HASURA_BIN" metadata apply --project "$BUILD" \
  --endpoint "$HASURA_GRAPHQL_ENDPOINT" --admin-secret "$HASURA_GRAPHQL_ADMIN_SECRET" \
  --skip-update-check

echo "==> reloading metadata"
"$HASURA_BIN" metadata reload --project "$BUILD" \
  --endpoint "$HASURA_GRAPHQL_ENDPOINT" --admin-secret "$HASURA_GRAPHQL_ADMIN_SECRET" \
  --skip-update-check

echo "done"
