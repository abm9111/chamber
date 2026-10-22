# Runs the Chamber MCP server over stdio. Exists so directory checkers
# (Glama and similar) can start the server and introspect it; local installs
# don't need Docker at all.
#
#   docker build -t chamber .
#   docker run -i --rm chamber
#
# Node 24 satisfies the 23.6+ floor (built-in TypeScript type stripping).
# There are zero runtime dependencies, so there is no npm install step.
FROM node:25-slim

# The base's own packages carry security fixes the published tag predates, so
# upgrade them here rather than waiting for a new tag. This is the same step
# deploy/Dockerfile has, for the same reason: the ci `image` job scans this
# image too and gates on any HIGH/CRITICAL that has a fix.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# npm is never used at runtime: there are zero runtime dependencies, nothing in
# this image runs an install step, and CMD is plain node. Shipping npm meant
# carrying its bundled brace-expansion and other node packages for no runtime
# benefit. Deleting the surface beats patching it. If a future change needs npm
# INSIDE the container, restore it in a builder stage and keep it out of the
# final one, rather than reinstating it here.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

WORKDIR /app
COPY bin/ bin/
COPY src/ src/
COPY sql/ sql/
COPY scripts/ scripts/
COPY package.json ./
# initialize and tools/list respond before any config exists; tool calls
# resolve config on first use (CHAMBER_* env vars or a mounted config file).

# node:24-slim ships an unprivileged `node` user (uid 1000) with its own
# $HOME, which is where the database lands on first tool call — the copied
# sources are only ever read, so no ownership change is needed. Root bought
# nothing here and cost a container-escape precondition (trivy DS-0002).
USER node

CMD ["node", "--experimental-strip-types", "src/mcp_server.ts"]
