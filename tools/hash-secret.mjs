#!/usr/bin/env node
/**
 * The hash to put in the client file for a given secret.
 *
 *     node tools/hash-secret.mjs "the secret you generated"
 *
 * The secret itself is never stored here. Print it once, give it to whoever is
 * calling, and put only the hash in the file — so a copy of the configuration
 * is not a copy of the credentials.
 */

import { hashOf } from '../src/auth/clients.js';

const secret = process.argv[2];

if (!secret) {
  console.error('Give it a secret to hash.');
  console.error('Generate one first:  node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"');
  process.exit(1);
}

if (secret.length < 16) {
  console.error('That secret is too short to be worth hashing. Use at least 16 characters.');
  process.exit(1);
}

console.log(hashOf(secret));
