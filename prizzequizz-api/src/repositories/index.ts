import { postgresRepositories } from './postgresRepositories.js';
import { memoryRepositories } from './memoryRepositories.js';
import type { RepositoryBundle } from './contracts.js';

export function createRepositories(): RepositoryBundle {
  const driver = process.env.REPOSITORY_DRIVER ?? (process.env.DATABASE_URL ? 'postgres' : 'memory');
  if (driver === 'postgres') return postgresRepositories;
  return memoryRepositories;
}

export const repositories = createRepositories();
