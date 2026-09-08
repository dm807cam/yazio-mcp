#!/usr/bin/env node
/**
 * Read a password from stdin and print its scrypt hash, so the plaintext is
 * never passed as an argument (where it would land in shell history or ps).
 *
 *   read -rs PW && printf '%s' "$PW" | node dist/hash-password.js
 */
import { hashPassword } from './auth/password.js';

const chunks: Buffer[] = [];
process.stdin.on('data', chunk => chunks.push(chunk as Buffer));
process.stdin.on('end', () => {
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!password) {
    console.error('No password received on stdin.');
    process.exit(1);
  }
  process.stdout.write(`${hashPassword(password)}\n`);
});
