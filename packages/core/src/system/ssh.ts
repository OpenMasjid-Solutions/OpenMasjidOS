/**
 * Add an SSH public key to the HOST's root account so the admin can SSH in.
 *
 * The core runs in a container, so it can't touch the host filesystem directly.
 * It launches a one-shot helper container that mounts the host root FS and
 * appends the key to /root/.ssh/authorized_keys. No sshd restart is needed —
 * sshd reads authorized_keys per connection, and the default sshd config
 * (PermitRootLogin prohibit-password) already allows key-based root login.
 *
 * Enabling password login or installing sshd needs service control across
 * distros, so that's surfaced to the user as a command instead (see the UI).
 */
import { spawn } from 'node:child_process';

const KEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(\s+\S.*)?$/;

export function isValidSshKey(key: string): boolean {
  return KEY_RE.test(key.trim());
}

export function addRootSshKey(key: string): Promise<void> {
  const clean = key.trim();
  const script =
    'set -e; ' +
    'mkdir -p /hostfs/root/.ssh; ' +
    'touch /hostfs/root/.ssh/authorized_keys; ' +
    'grep -qxF "$OMOS_SSH_KEY" /hostfs/root/.ssh/authorized_keys || ' +
    'printf "%s\\n" "$OMOS_SSH_KEY" >> /hostfs/root/.ssh/authorized_keys; ' +
    'chmod 700 /hostfs/root/.ssh; chmod 600 /hostfs/root/.ssh/authorized_keys';

  return new Promise((resolve, reject) => {
    // spawn with an args array (no shell), so the key value can't be injected;
    // the helper reads it from the environment, never from the script text.
    const child = spawn('docker', [
      'run',
      '--rm',
      '-e',
      `OMOS_SSH_KEY=${clean}`,
      '-v',
      '/:/hostfs',
      'alpine:3.20',
      'sh',
      '-c',
      script,
    ]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || 'Could not add the SSH key.')),
    );
  });
}
