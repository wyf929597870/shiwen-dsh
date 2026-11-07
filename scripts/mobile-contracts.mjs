import {writeFile, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {schemas, protocolVersion, limits, errorCodes} from '../contracts/mobile/v1/schema.mjs';
const output = JSON.stringify({protocolVersion, status: 'P0 draft; not exposed by server', limits, errorCodes,
  schemas: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]))}, null, 2) + '\n';
const path = resolve(import.meta.dirname, '../contracts/mobile/v1/schema.json');
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== output) throw Error('schema.json is stale: run npm run mobile:contracts');
  console.log('Mobile schema matches source.');
} else { await writeFile(path, output); console.log('Wrote mobile v1 draft schema.'); }
