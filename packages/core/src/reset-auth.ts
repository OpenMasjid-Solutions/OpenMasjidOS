// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Full sign-in reset CLI — the recovery path when authentication is wedged
 * (e.g. after restoring a backup onto a new machine). Run from the host:
 *
 *   docker exec -it openmasjid-core node packages/core/dist/reset-auth.js
 *
 * It (1) sets a NEW admin password, (2) signs out every session (drops all
 * cookies), and (3) rotates EVERY app's Fabric sign-in key so apps re-link
 * cleanly under fresh credentials. **App data is never wiped** — only the admin
 * password, sessions, and per-app keys change. The reset-password CLI is the
 * lighter "just my password" tool; this is the full "auth is broken, start the
 * sign-in layer fresh" tool.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { isConfigured, getUsername, setCredentials } from './auth/store';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth/passwords';
import { destroyAllSessions } from './auth/sessions';
import { rotateAllFabricSecrets, reupAllApps } from './apps/manager';
import { docker } from './docker/client';

const CORE_CONTAINER = process.env.OPENMASJID_CONTAINER_NAME ?? 'openmasjid-core';

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  stdout.write('\n  OpenMasjidOS — full sign-in reset\n');
  stdout.write('  ────────────────────────────────\n');
  stdout.write('  This sets a NEW admin password, signs out everywhere, and rotates\n');
  stdout.write("  every app's sign-in key so apps re-link cleanly. Your apps and ALL\n");
  stdout.write('  their data are kept — only the sign-in layer is reset.\n\n');

  const go = (await rl.question('  Continue? Type RESET to confirm: ')).trim();
  if (go !== 'RESET') {
    stdout.write('\n  Cancelled — nothing was changed.\n\n');
    rl.close();
    return;
  }

  const current = (isConfigured() && getUsername()) || 'admin';
  const username = (await rl.question(`\n  Admin username [${current}]: `)).trim() || current;

  let password = '';
  for (;;) {
    password = await rl.question('  New admin password (typed visibly): ');
    if (password.length < MIN_PASSWORD_LENGTH) {
      stdout.write(`    Please use at least ${MIN_PASSWORD_LENGTH} characters.\n`);
      continue;
    }
    const confirm = await rl.question('  Confirm new password: ');
    if (confirm !== password) {
      stdout.write("    Those didn't match — let's try again.\n");
      continue;
    }
    break;
  }

  // 1. New admin credentials + drop every session (all cookies become invalid).
  setCredentials(username, await hashPassword(password));
  destroyAllSessions();

  // 2. Rotate every app's Fabric sign-in key (data untouched).
  stdout.write('\n  Rotating app sign-in keys…\n');
  const n = rotateAllFabricSecrets((l) => stdout.write(`    ${l}\n`));
  if (n === 0) stdout.write('    (no Fabric apps to rotate)\n');

  // 3. Restart apps so the new keys (and platform address) take effect.
  if (n > 0) {
    stdout.write('\n  Restarting apps with their new keys…\n');
    await reupAllApps((l) => stdout.write(`    ${l}\n`));
  }
  rl.close();

  stdout.write('\n  ✅ Sign-in reset complete. Restarting OpenMasjidOS…\n');
  stdout.write('     Give it a few seconds, then sign in with your new password.\n');
  stdout.write('     Open each app once to re-link it to your dashboard sign-in.\n\n');
  try {
    await docker.getContainer(CORE_CONTAINER).restart({ t: 3 });
  } catch (err) {
    stdout.write(
      `  Couldn't restart automatically (${(err as Error).message}).\n` +
        `  Please restart it yourself:  docker restart ${CORE_CONTAINER}\n\n`,
    );
  }
}

main().catch((err) => {
  stdout.write(`\n  Something went wrong: ${(err as Error).message}\n`);
  process.exit(1);
});
