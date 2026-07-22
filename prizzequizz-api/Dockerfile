FROM node:20-alpine AS build
WORKDIR /app
COPY . .
# The build context may carry a host-built node_modules (linux/glibc, or
# production-only) that confuses npm inside alpine and leaves tsc's bin symlink
# uncreated. Wipe it, install fresh with devDependencies forced, and invoke the
# compiler via npx so it runs even if the .bin symlink is still missing.
RUN rm -rf node_modules
RUN npm install --include=dev --production=false
RUN npx --yes tsc -p tsconfig.json

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
