# Hardened production image for koko-fork-agents-observe.
# Differences vs the historical upstream Dockerfile (agents-observe v0.9.6):
#   - Node base tag pinned to a specific patch release (no silent "slim" drift)
#   - `npm ci` instead of `npm install` (lockfile-strict, reproducible)
#   - apt with --no-install-recommends + cache cleaned
#   - Non-root runtime user (UID 1000 / `node`)
#   - HEALTHCHECK against /api/health
#   - Runtime still uses `tsx` (the server sources use extensionless ESM
#     imports which strict node ESM rejects; switching to plain `node` would
#     require rewriting every import).
#
# Build locally:
#   docker build -t agents-observe:local .
#
# Use a locally built image with the plugin:
#   export AGENTS_OBSERVE_DOCKER_IMAGE=agents-observe:local

# When updating Node, verify the new digest of the base image:
#   docker pull node:24.10-slim && docker inspect --format='{{.Id}}' node:24.10-slim
FROM node:26.2-slim AS builder

WORKDIR /app

# Build tools for native addons (better-sqlite3 via node-gyp).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Server: lockfile-strict install. Runtime uses `tsx` (matches upstream behaviour).
COPY app/server/package.json app/server/package-lock.json server/
RUN cd server && npm ci --no-audit --no-fund && npm cache clean --force

COPY app/server/tsconfig.json server/
COPY app/server/src server/src

# Client: install + build static SPA.
# `--include=optional` is required because Vite 8 (rolldown bundler) ships
# platform-specific bindings as optionalDependencies; npm has a long-standing
# bug (npm/cli#4828) where `npm ci` can skip the binding for the build
# platform when the lockfile was generated on a different host. Explicit
# flag avoids "Cannot find native binding" at `vite build` time.
COPY app/client/package.json app/client/package-lock.json client/
RUN cd client && npm ci --no-audit --no-fund --include=optional
COPY app/client/ client/
# vite.config.ts reads ../../package.json (resolves to /package.json inside image).
COPY package.json /package.json
RUN cd client && npm run build

# ---------- Production image ----------
FROM node:26.2-slim

WORKDIR /app

# /data is mounted from the host at runtime. Pre-create with the non-root
# user's ownership so the container can write to it regardless of host UID
# mapping (macOS Docker Desktop handles UID translation; bare Linux users
# may need to chown the host data dir to UID 1000).
RUN mkdir -p /data && chown -R node:node /data /app

# Server: source + node_modules (incl. tsx for runtime execution).
COPY --from=builder --chown=node:node /app/server/src server/src
COPY --from=builder --chown=node:node /app/server/node_modules server/node_modules
COPY --from=builder --chown=node:node /app/server/package.json server/
COPY --from=builder --chown=node:node /app/server/tsconfig.json server/

# Client: built static assets served by the server in production.
COPY --from=builder --chown=node:node /app/client/dist client/dist

# VERSION + CHANGELOG read at runtime by /api/health and /api/changelog.
COPY --chown=node:node VERSION /app/VERSION
COPY --chown=node:node CHANGELOG.md /app/CHANGELOG.md

USER node
WORKDIR /app/server

EXPOSE 4981

# Cheap healthcheck using native fetch (Node 18+). Exits 0 if /api/health is 2xx.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGENTS_OBSERVE_SERVER_PORT||4981)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
