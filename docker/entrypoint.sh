#!/bin/sh
# Entrypoint for the SAM backend container.
# Applies any pending Prisma migrations, then boots the server.
# Run inside the docker container only — not for local dev.

set -e

echo "▶ Applying Prisma migrations…"
pnpm exec prisma migrate deploy

echo "▶ Starting SAM backend on :${PORT:-5500}…"
exec node dist/server.js
