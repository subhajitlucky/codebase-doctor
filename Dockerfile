# Sandbox image for registry scanners (e.g. Glama): builds the CLI and serves
# the read-only MCP server over stdio. No credentials are baked in and the
# server makes no network requests unless explicitly asked for advisories.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/cli.js", "mcp"]
