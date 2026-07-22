FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# Force devDependencies (typescript/tsc) even if NODE_ENV=production leaks into
# the build environment — the build stage needs the compiler.
RUN npm install --include=dev
COPY . .
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
