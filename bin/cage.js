#!/usr/bin/env node
// Prefer the compiled build; fall back to running the TypeScript sources directly
// (Node >= 22.18 strips types natively, but not for files under node_modules).
import { existsSync } from 'node:fs';

const dist = new URL('../dist/cli.js', import.meta.url);
const src = new URL('../src/cli.ts', import.meta.url);
await import(existsSync(dist) ? dist.href : src.href);
