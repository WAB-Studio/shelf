#!/bin/sh
# Production applies its migrations before the build, so the new code never serves ahead of its schema;
# a preview or local build never touches a database.
set -e
if [ "$VERCEL_ENV" = "production" ]; then
  npm run db:migrate:env
fi
exec next build
