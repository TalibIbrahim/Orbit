# Orbit hub image (Next.js standalone). Works on linux/arm64 and amd64.
# Build context = REPO ROOT:  docker build -f deploy/web.Dockerfile -t orbit-web .
#
# The image also carries the agent bundle (served at <HUB>/agent/orbit-agent.mjs) and the
# install templates used by the "Add device" wizard.

# ---- deps + build -----------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain for any native npm dependency (prebuilt binaries are used when available).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Manifests first for layer caching (npm workspaces).
COPY package.json package-lock.json ./
COPY packages ./packages
COPY agent/package.json ./agent/package.json
COPY web/package.json ./web/package.json
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Agent bundle -> agent/dist/orbit-agent.mjs + version.json
RUN npm run build -w agent
RUN mkdir -p web/public && npm run build -w web

# ---- runtime ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    ORBIT_AGENT_DIST=/app/agent-dist \
    ORBIT_INSTALL_TEMPLATES=/app/install-templates \
    ORBIT_DATA_DIR=/data
WORKDIR /app

# Next standalone output. With npm workspaces the tracing root is the repo root, so the
# server lives at /app/web/server.js (not /app/server.js) and static files must sit next to it.
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./web/.next/static
COPY --from=build /app/web/public ./web/public

COPY --from=build /app/agent/dist /app/agent-dist
COPY deploy/install/ /app/install-templates/

RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
VOLUME ["/data"]
# Fall back to /app/server.js if the standalone output was not nested under web/.
CMD ["sh", "-c", "if [ -f web/server.js ]; then exec node web/server.js; else exec node server.js; fi"]
