import { readFileSync } from 'node:fs';

export const readFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
