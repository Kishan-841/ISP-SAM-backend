# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20

# ============================================================================
# Stage 1: builder — install all deps, generate Prisma client, compile TS
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS builder

# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl

WORKDIR /app

# pnpm via corepack — no separate install step needed.
RUN corepack enable && corepack prepare pnpm@latest --activate

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

RUN corepack enable && corepack prepare pnpm@latest --activate

# Install ONLY production deps (smaller image, smaller attack surface).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Bring across the generated Prisma client + compiled JS + prisma schema
# (prisma migrate deploy at boot needs the schema dir).
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Uploads directory — bind-mounted as a docker volume in compose so files
# survive container rebuilds.
RUN mkdir -p /app/uploads && chown -R node:node /app

# Boot script: applies pending migrations, then starts the server.
COPY --chown=node:node docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER node
EXPOSE 5500

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./entrypoint.sh"]
