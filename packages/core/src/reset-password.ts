/**
 * Password recovery CLI: `docker exec -it openmasjid-core node \
 *   packages/core/dist/reset-password.js`. Lets an admin who is locked out set
 * a new password from the machine's terminal. Apps and data are untouched.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { isConfigured, getUsername, setCredentials } from './auth/store';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth/passwords';
import { destroyAllSessions } from './auth/sessions';
import { docker } from './docker/client';

const CORE_CONTAINER = process.env.OPENMASJID_CONTAINER_NAME ?? 'openmasjid-core';

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  if (!isConfigured()) {
    stdout.write('\nNo admin account exists yet. Open the dashboard to create one.\n');
    rl.close();
    return;
  }

  const current = getUsername() ?? 'admin';
  stdout.write(`\nResetting the password for "${current}".\n`);
  const username = (await rl.question(`Username [${current}]: `)).trim() || current;

  let password = '';
  for (;;) {
    password = await rl.question('New password (typed visibly): ');
    if (password.length < MIN_PASSWORD_LENGTH) {
      stdout.write(`  Please use at least ${MIN_PASSWORD_LENGTH} characters.\n`);
      continue;
    }
    const confirm = await rl.question('Confirm new password: ');
    if (confirm !== password) {
      stdout.write("  Those didn't match — let's try again.\n");
      continue;
    }
    break;
  }

  // Write the new credentials to disk (synchronous + atomic).
  setCredentials(username, await hashPassword(password));
  destroyAllSessions();
  rl.close();

  // The running daemon loaded the old hash into memory at startup and won't
  // re-read auth.json, so the new password won't work until it restarts. Restart
  // the core container automatically (this exec session ends as it does — that's
  // expected). Apps are separate compose projects and are untouched.
  stdout.write('\n✅ Password updated. Restarting OpenMasjidOS so it takes effect…\n');
  stdout.write('   Give it a few seconds, then sign in with your new password.\n\n');
  try {
    await docker.getContainer(CORE_CONTAINER).restart({ t: 3 });
  } catch (err) {
    stdout.write(
      `Couldn't restart automatically (${(err as Error).message}).\n` +
        `Please restart it yourself:  docker restart ${CORE_CONTAINER}\n\n`,
    );
  }
}

main().catch((err) => {
  stdout.write(`\nSomething went wrong: ${(err as Error).message}\n`);
  process.exit(1);
});
