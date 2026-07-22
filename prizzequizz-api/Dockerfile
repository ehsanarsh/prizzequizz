FROM node:20-alpine AS build
WORKDIR /app
# Copy source FIRST, then install — so nothing in the build context can clobber
# node_modules after install. --production=false + --include=dev force the
# devDependencies (typescript) even if NODE_ENV=production or an .npmrc says otherwise.
COPY . .
RUN npm install --include=dev --production=false
RUN ls -la node_modules/.bin/tsc || (echo "!!! tsc NOT installed — check .npmrc/registry" && exit 1)
RUN npm run build

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
