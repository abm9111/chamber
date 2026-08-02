# Minimal Chamber runtime image
FROM node:22-bookworm-slim

WORKDIR /app

# App sources (no native deps required for core path)
COPY package.json ./
COPY src ./src
COPY sql ./sql
COPY scripts ./scripts
COPY fixtures ./fixtures

ENV NODE_ENV=production
ENV CHAMBER_BIND=0.0.0.0
ENV PORT=8787
ENV CHAMBER_DB=/data/chamber.sqlite

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787
CMD ["node", "--experimental-strip-types", "src/server.ts"]
