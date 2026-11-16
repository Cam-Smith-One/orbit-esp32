"""Create a consistent, private SQLite copy for a one-time Fly migration."""
import os
from pathlib import Path
import sqlite3

private = Path(__file__).resolve().parent / '.private'
source = private / 'memory.db'
seed = private / 'memory.fly-seed.db'
if not source.exists():
    raise SystemExit('No local Orbit database to migrate')
if seed.exists():
    raise SystemExit('Fly seed already exists; inspect it before replacing')
fd = os.open(seed, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.close(fd)
try:
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as old, sqlite3.connect(seed) as copy:
        old.backup(copy)
        result = copy.execute('PRAGMA integrity_check').fetchone()[0]
        if result != 'ok':
            raise ValueError('SQLite integrity check failed')
        counts = {name: copy.execute(f'SELECT count(*) FROM {name}').fetchone()[0]
                  for name in ('memories', 'notes', 'orbit_config', 'cloud_commands')}
except BaseException:
    seed.unlink(missing_ok=True)
    raise
print('Private Fly seed ready:', seed, 'row counts:', counts)
