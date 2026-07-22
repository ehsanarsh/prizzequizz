FROM node:20-alpine AS build
WORKDIR /app
COPY . .
# Wipe any host-built node_modules the context may carry, then install fresh.
RUN rm -rf node_modules
RUN npm install --include=dev --production=false
# Invoke TypeScript's real entry file with node — needs NO .bin symlink (an
# alpine quirk) and NO network (npx would try to download a bogus "tsc" package).
# Force-install typescript only in the rare case its files are missing.
RUN test -f node_modules/typescript/bin/tsc || npm install --no-save typescript
RUN node node_modules/typescript/bin/tsc -p tsconfig.json

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY config ./config
COPY database ./database
EXPOSE 3000
CMD ["node", "dist/index.js"]
