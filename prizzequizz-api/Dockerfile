# No-compile image: the TypeScript is pre-built into ./dist on the host and
# shipped in the build context, so the image never needs the compiler or a
# network fetch for it. Only the small production runtime deps are installed.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY dist ./dist
COPY config ./config
COPY database ./database
EXPOSE 3000
CMD ["node", "dist/index.js"]
