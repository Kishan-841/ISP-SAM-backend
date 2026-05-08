# syntax=docker/dockerfile:1.7
# Node 22 is required because corepack picks up pnpm 11+, which uses the
# node:sqlite built-in module that only exists in Node 22+. Pinning Node 20
# crashes the container at boot with ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite.
ARG NODE_VERSION=22

# ============================================================================
# Stage 1: builder — install all deps, generate Prisma client, compile TS
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS builder

# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl

WORKDIR /app

# pnpm via corepack — no separate install step needed.
# Pin pnpm to v10. pnpm@latest now resolves to v11+, which (a) requires
# Node 22.13+ (we have it) but (b) made build-script approvals stricter —
# it ignores `onlyBuiltDependencies` in package.json and demands either
# interactive approval or a separate pnpm-workspace.yaml. v10 honours the
# existing config and is still actively maintained.
RUN corepack enable && corepack prepare pnpm@10 --activate

# Cache deps independently of source — package.json + lockfile change less often.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Generate Prisma client (depends on schema, not source).
COPY prisma ./prisma
RUN pnpm exec prisma generate

# Compile TypeScript.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm exec tsc

# ============================================================================
# Stage 2: runner — slim production image
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS runner

# tini = clean PID-1 signal handling (so docker stop / Ctrl+C exits cleanly).
# openssl needed by Prisma at runtime.
RUN apk add --no-cache openssl tini

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5500

# Pin pnpm to v10. pnpm@latest now resolves to v11+, which (a) requires
# Node 22.13+ (we have it) but (b) made build-script approvals stricter —
# it ignores `onlyBuiltDependencies` in package.json and demands either
# interactive approval or a separate pnpm-workspace.yaml. v10 honours the
# existing config and is still actively maintained.
RUN corepack enable && corepack prepare pnpm@10 --activate

# Install production deps. `prisma` is now in dependencies (not devDeps) so
# both the CLI (for `prisma migrate deploy` at boot) and the client are
# present in the runner image.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Bring across the prisma schema + run generate so the client engine is
# built against THIS image's libc/openssl, not the builder's. Prisma 6
# emits the generated client into node_modules/@prisma/client.
COPY --from=builder /app/prisma ./prisma
RUN pnpm exec prisma generate

# Compiled JS.
COPY --from=builder /app/dist ./dist

# Approval files moved to Cloudinary; no local /app/uploads volume needed.
RUN chown -R node:node /app

# Boot script: applies pending migrations, then starts the server.
COPY --chown=node:node docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER node
EXPOSE 5500

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./entrypoint.sh"]
