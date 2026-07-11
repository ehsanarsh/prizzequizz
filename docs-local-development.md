# PrizzeQuizz Local Development Guide

## Run Frontend Only

```bash
cd prizzequizz-pwa
npm install
npm run dev
```

## Run Backend Only

```bash
cd prizzequizz-api
npm install
npm run dev
```

Health:

```text
GET http://localhost:3000/v1/health
```

## Run Integration Tests

```bash
cd prizzequizz-api
npm run build
npm run test:integration
```

## Run Full Stack With Docker Compose

```bash
docker compose up --build
```

Services:

```text
PWA: http://localhost:4173
API: http://localhost:3000/v1
PostgreSQL: localhost:5432
Redis: localhost:6379
```

## Repository Driver

Default in Docker Compose is memory for safe local development:

```env
REPOSITORY_DRIVER=memory
```

To test PostgreSQL repositories:

```env
REPOSITORY_DRIVER=postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/prizzequizz
```

Then run:

```bash
cd prizzequizz-api
npm run migrate
npm run dev
```
