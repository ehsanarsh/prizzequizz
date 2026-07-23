# Fully pre-built, network-free image: dist AND node_modules are prepared on the
# host and shipped in the build context. The image runs zero npm install, so the
# server's flaky npm registry access can never break or half-install a package.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY node_modules ./node_modules
COPY dist ./dist
COPY config ./config
COPY database ./database
EXPOSE 3000
CMD ["node", "dist/index.js"]
