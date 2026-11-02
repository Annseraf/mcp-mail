# mcp-mail container image (published to ghcr.io/annseraf/mcp-mail by CI).
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG BUILD_COMMIT=unknown
RUN BUILD_COMMIT=$BUILD_COMMIT npm run build && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3220 ACCOUNTS_FILE=/data/accounts.json DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/compat/baseline ./compat/baseline
COPY LICENSE NOTICE README.md ./
USER node
VOLUME ["/data"]
EXPOSE 3220
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3220)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "--enable-source-maps", "dist/index.js"]
