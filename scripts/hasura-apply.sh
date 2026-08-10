#!/usr/bin/env bash
#
# Applies migrations + metadata to the configured Hasura instance.
#
# Metadata in the repo refers to the handler host as {{ACTION_BASE_URL}}, which
# is the idiomatic Hasura way to keep an environment-specific URL out of version
# control. Hasura normally resolves that from its own environment; on nhost that
# means adding the variable in the project dashboard. To keep `git clone && run`
# working without a dashboard visit, this script substitutes the value from your
# local .env into a throwaway copy of the metadata directory and applies that.
# Nothing environment-specific is ever written back into the tracked files.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
if [ -f .env ];       then set -a; . ./.env;       set +a; fi

: "${HASURA_GRAPHQL_ENDPOINT:?set HASURA_GRAPHQL_ENDPOINT in .env.local}"
: "${HASURA_GRAPHQL_ADMIN_SECRET:?set HASURA_GRAPHQL_ADMIN_SECRET in .env.local}"
: "${ACTION_BASE_URL:?set ACTION_BASE_URL in .env.local (your deployed app origin)}"

HASURA_BIN="${HASURA_BIN:-hasura}"
if ! command -v "$HASURA_BIN" >/dev/null 2>&1; then
  echo "hasura CLI not found. Install with: npm i -g hasura-cli" >&2
  exit 1
fi

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cp -R hasura/. "$BUILD/"

# Substitute environment-specific values in the build copy only.
#   {{ACTION_BASE_URL}}                      -> your app origin
#   value_from_env: AGENTFLOW_WEBHOOK_SECRET -> value: '<secret>'
# The second rewrite exists so the shared secret does not also have to be
# registered in the nhost dashboard before anything works. If you do add both
# variables to your nhost project's environment, delete this block — Hasura will
# resolve them itself and the tracked metadata applies unchanged.
export ACTION_BASE_URL AGENTFLOW_WEBHOOK_SECRET
find "$BUILD/metadata" -type f -name '*.yaml' -print0 | xargs -0 perl -pi -e '
  s/\{\{ACTION_BASE_URL\}\}/$ENV{ACTION_BASE_URL}/g;
  if (s/value_from_env:\s*AGENTFLOW_WEBHOOK_SECRET/value: __SECRET__/) {
    my $s = $ENV{AGENTFLOW_WEBHOOK_SECRET}; $s =~ s/'"'"'/'"'"''"'"'/g;
    s/__SECRET__/'"'"'$s'"'"'/;
  }
'

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
