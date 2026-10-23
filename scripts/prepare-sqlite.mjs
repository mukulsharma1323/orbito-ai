import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url?.startsWith('file:')) throw new Error('DATABASE_URL must point to a SQLite file');

const filePath = decodeURIComponent(url.slice('file:'.length).split('?')[0]);
const schemaDirectory = fileURLToPath(new URL('../apps/api/prisma/', import.meta.url));
const databasePath = path.resolve(schemaDirectory, filePath);

await mkdir(path.dirname(databasePath), { recursive: true });
const file = await open(databasePath, 'a');
await file.close();
