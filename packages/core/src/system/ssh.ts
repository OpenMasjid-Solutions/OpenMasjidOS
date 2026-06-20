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
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\r\n]*)?$/;

export function isValidSshKey(key: string): boolean {
  const k = key.trim();
  // Must be a single line — a newline could inject an extra authorized_keys entry.
  if (/[\r\n]/.test(k)) return false;
  return KEY_RE.test(k);
}

export function addRootSshKey(key: string): Promise<void> {
  const clean = key.trim();
  // Mount only the host's /root (least privilege) instead of the whole host FS.
  const script =
    'set -e; ' +
    'mkdir -p /hostroot/.ssh; ' +
    'touch /hostroot/.ssh/authorized_keys; ' +
    'grep -qxF "$OMOS_SSH_KEY" /hostroot/.ssh/authorized_keys || ' +
    'printf "%s\\n" "$OMOS_SSH_KEY" >> /hostroot/.ssh/authorized_keys; ' +
    'chmod 700 /hostroot/.ssh; chmod 600 /hostroot/.ssh/authorized_keys';

  return new Promise((resolve, reject) => {
    // spawn with an args array (no shell), so the key value can't be injected;
    // the helper reads it from the environment, never from the script text.
    const child = spawn('docker', [
      'run',
      '--rm',
      '-e',
      `OMOS_SSH_KEY=${clean}`,
      '-v',
      '/root:/hostroot',
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
