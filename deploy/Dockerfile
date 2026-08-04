# Minimal Chamber runtime image
FROM node:24-bookworm-slim

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
CMD ["node", "--experimental-strip-types", "src/server.ts"]
