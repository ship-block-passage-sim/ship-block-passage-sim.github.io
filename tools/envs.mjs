// Shared by the command-line tools: choose the environment table.
//   --envs <file.csv>   use this table
//   --examples          use the built-in example environments
//   (neither)           private/environments.csv if it exists, otherwise the built-in examples
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogCSV, listEnvs, useExamples } from '../src/env.js';

export const DEFAULT_ENV_CSV = resolve(fileURLToPath(new URL('..', import.meta.url)), 'private', 'environments.csv');

/** Loads the catalogue; returns { path, text, name } (all null for the built-in examples). */
export function loadEnvsFromArgs(args, { quiet = false } = {}) {
  const i = args.indexOf('--envs'), say = m => { if (!quiet) process.stderr.write(m + '\n'); };
  const path = i >= 0 ? args[i + 1] : (!args.includes('--examples') && existsSync(DEFAULT_ENV_CSV) ? DEFAULT_ENV_CSV : null);
  if (!path) { useExamples(); say(`Environments: built-in examples (${listEnvs().length}). Use --envs <file.csv> for your own table.`); return { path: null, text: null, name: null }; }
  if (!existsSync(path)) { process.stderr.write(`Environment CSV not found: ${path}\n`); process.exit(1); }
  const text = readFileSync(path, 'utf8'), r = loadCatalogCSV(text, basename(path));
  for (const e of r.errors) process.stderr.write(`  CSV: ${e}\n`);
  if (!r.envs.length) { process.stderr.write(`No valid environment in ${path}\n`); process.exit(1); }
  say(`Environments: ${path} (${r.envs.length})`);
  return { path, text, name: basename(path) };
}
