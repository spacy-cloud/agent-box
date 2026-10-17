import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** File below the data dir that holds the id of this abox installation. */
export const INSTANCE_ID_FILE = 'instance-id';

const VALID = /^[0-9a-f]{16}$/;

function read(file: string): string | undefined {
  try {
    const v = readFileSync(file, 'utf8').trim();
    return VALID.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The id of the abox installation that owns `dataDir`: 16 random hex characters, generated once
 * and persisted in `<dataDir>/instance-id` (mode 0600). Container backends stamp it on the engine
 * objects they create (`abox.instance`) and only look at objects that carry it, so a second
 * installation on the same container engine never sees the first one's sandboxes as orphans.
 *
 * Safe against concurrent first use (CLI and GUI start together): the id is written to a temporary
 * file and hard-linked into place, the loser of the race reads the winner's id.
 */
export function loadInstanceId(dataDir: string): string {
  const file = join(dataDir, INSTANCE_ID_FILE);
  const existing = read(file);
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const id = randomBytes(8).toString('hex');
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, `${id}\n`, { mode: 0o600, flag: 'wx' });
  try {
    try {
      linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const winner = read(file);
      if (winner) return winner;
      renameSync(tmp, file); // the file exists but is garbage: replace it
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  chmodSync(file, 0o600);
  return id;
}
