# Runs the Chamber MCP server over stdio. Exists so directory checkers
# (Glama and similar) can start the server and introspect it; local installs
# don't need Docker at all.
#
#   docker build -t chamber .
#   docker run -i --rm chamber
#
# Node 24 satisfies the 23.6+ floor (built-in TypeScript type stripping).
# There are zero runtime dependencies, so there is no npm install step.
FROM node:24-slim
WORKDIR /app
COPY bin/ bin/
COPY src/ src/
COPY sql/ sql/
COPY scripts/ scripts/
COPY package.json ./
# initialize and tools/list respond before any config exists; tool calls
# resolve config on first use (CHAMBER_* env vars or a mounted config file).
CMD ["node", "--experimental-strip-types", "src/mcp_server.ts"]
