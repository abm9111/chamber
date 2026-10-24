# Minimal Chamber runtime image
FROM node:24-bookworm-slim

# The base's own packages carry security fixes the published tag predates.
# Without this, trivy reports 6 HIGH vulnerabilities with fixes available
# (libpcre2 twice, plus npm's bundled tar / brace-expansion / ip-address,
# removed below) and the ci `image` job goes red. Measured 2026-09-13.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# npm is never used at runtime: runtime dependencies are deliberately empty,
# nothing in this image runs an install step, and CMD is plain node. Shipping
# it meant carrying its bundled tar, brace-expansion and ip-address — three of
# the six fixable HIGHs — for no runtime benefit. Deleting the surface beats
# patching it; that is the same choice findGonePinnedFiles makes in src/pins.ts.
#
# If a future change needs npm INSIDE the container, restore it in a builder
# stage and keep it out of the final one, rather than reinstating it here.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

WORKDIR /app

# App sources (no native deps required for core path)
COPY package.json ./
COPY src ./src
COPY sql ./sql
COPY scripts ./scripts
COPY fixtures ./fixtures

ENV NODE_ENV=production
# 0.0.0.0 is required to be reachable from other containers, and src/server.ts
# refuses to start on a non-loopback bind without CHAMBER_API_TOKEN. That is
# deliberate: this image previously shipped an unauthenticated port on every
# interface. docker-compose.yml already supplies the token via
# ${CHAMBER_API_TOKEN:?}; a bare `docker run` must supply one too.
ENV CHAMBER_BIND=0.0.0.0
ENV PORT=8787
ENV CHAMBER_DB=/data/chamber.sqlite

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787
# The probe and the timings of the healthcheck in docker-compose.yml, for a run
# without compose. /health needs no token. PORT is what src/server.ts listens on
# (the ENV above); 127.0.0.1 reaches a server bound to 0.0.0.0 from inside.
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "src/server.ts"]
