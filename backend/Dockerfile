# Node 24 here, not 18 — Node 18's bundled npm (10.x) fails `npm ci` on this
# lockfile with a spurious "Missing: X from lock file" error (same known npm
# 10.x lockfile-validation bug already documented in frontend/Dockerfile; npm
# 11+ installs this exact lockfile cleanly). Safe to differ from the Node 18
# production stage below — this stage only compiles TypeScript to dist/, and
# the backend has zero native/compiled npm dependencies (see the production
# stage's own comment), so nothing here is glibc/Node-version sensitive.
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
#
# Switched from node:18-alpine to node:18-bookworm-slim to support the Config
# Sync feature: psycopg2-binary has no musl/Alpine wheel, and the vendored
# passetto-server binary needs a glibc dynamic linker Alpine doesn't ship at
# all. Audited before switching: this backend has ZERO native/compiled npm
# dependencies (bcryptjs is pure-JS despite the name; pg/ioredis/redis are
# pure-JS too) — so there is no native-module ABI risk from the musl->glibc
# change, only a larger image size. The only Alpine-specific line (`apk add
# git`) has a direct apt-get equivalent below.
FROM node:18-bookworm-slim

# git: migration verification feature (pre-existing).
# python3/pip3 + the library list below: Config Sync feature — this exact
# library list is what `ldd` reported against the real vendored
# passetto-server-x86_64 binary on a Debian 12 host, not a guess.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      python3 python3-pip \
      libpq5 libncursesw6 libgmp10 libsodium23 libssl3 \
      libkrb5-3 libldap-2.5-0 libsasl2-2 libgnutls30 libkeyutils1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Config Sync — vendored config_transfer.py + its Python deps + binary, all
# static and safe to bake into the image. Nothing under assets/ is copied
# here: environments.json/config.json/patches.json are all generated at
# runtime (environments.json from DATABASE_CONFIGS, config.json/patches.json
# from Postgres — see config-sync-loader.ts and configSyncAssets.service.ts),
# never present in the image itself. seed/config.json is the one exception —
# real, non-secret, already-audited content used only to seed Postgres on a
# deployment's very first boot (see seedFromDiskIfEmpty()); patches.json has
# no equivalent seed file since it can carry real secrets and is never
# committed, so it starts as an empty object instead.
COPY config-sync/config_transfer.py config-sync/requirements.txt ./config-sync/
COPY config-sync/seed/config.json ./config-sync/seed/config.json
COPY config-sync/bin/passetto-server-x86_64 ./config-sync/bin/passetto-server-x86_64
RUN chmod +x ./config-sync/bin/passetto-server-x86_64 \
    && pip3 install --no-cache-dir --break-system-packages -r config-sync/requirements.txt

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "dist/server.js"]
