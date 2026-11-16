"""One-time in-place import after SFTP upload, before cloud sync is enabled."""
from pathlib import Path
import sqlite3

root = Path('/var/data/orbit')
seed = root / 'memory.fly-seed.db'
target = root / 'memory.db'
if not seed.is_file() or not target.is_file():
    raise SystemExit('Seed and target DB must both exist')
with sqlite3.connect(seed) as source, sqlite3.connect(target) as dest:
    if source.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise SystemExit('Seed integrity check failed')
    for table in ('memories', 'notes', 'orbit_config', 'cloud_commands'):
        if dest.execute(f'SELECT count(*) FROM {table}').fetchone()[0]:
            raise SystemExit(f'Target {table} is not empty; refusing to overwrite')
    source.backup(dest)
    if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise SystemExit('Imported DB integrity check failed')
    counts = {table: dest.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
              for table in ('memories', 'notes', 'orbit_config', 'cloud_commands')}
print('Fly database imported and checked; row counts:', counts)
