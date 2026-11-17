#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const jiti = createJiti(import.meta.url, {
    alias: { '@': resolve(repoRoot, 'src') },
});

const mod = await jiti.import(resolve(here, 'run-eval.ts'));
await mod.runCli(process.argv.slice(2));
