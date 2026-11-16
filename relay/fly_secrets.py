"""Import existing private credentials to Fly without printing them or shell arguments.

Run from relay/: python fly_secrets.py core (before first deploy), then
python fly_secrets.py console (only after the database seed is imported).
"""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
private = root / '.private'
app = os.getenv('ORBIT_FLY_APP', '')
if not app:
    raise SystemExit('Set ORBIT_FLY_APP to your own Fly app name')
if len(sys.argv) != 2 or sys.argv[1] not in ('core', 'console'):
    raise SystemExit('Usage: fly_secrets.py core|console')
if sys.argv[1] == 'core':
    device = json.loads((private / 'config.json').read_text())
    values = {'ORBIT_DEVICE_ID': device['device'],
              'ORBIT_DEVICE_TOKEN': device['token'],
              'OPENAI_API_KEY': (private / 'openai.key').read_text().strip()}
    if not values['OPENAI_API_KEY'].startswith('sk-'):
        raise SystemExit('OpenAI API key is not configured')
else:
    cloud = json.loads((private / 'cloud.json').read_text())
    values = {'ORBIT_CONSOLE_URL': cloud['url'],
              'ORBIT_CONSOLE_TOKEN': cloud['token'],
              'ORBIT_CONSOLE_BYPASS': cloud.get('deploymentBypass', '')}
if any('\n' in v or '\r' in v for v in values.values()):
    raise SystemExit('Secrets must not contain line breaks')
payload = ''.join(f'{k}={v}\n' for k, v in values.items())
command = ['flyctl', 'secrets', 'import', '--app', app]
if sys.argv[1] == 'core':
    command.append('--stage')
result = subprocess.run(command, input=payload, text=True, capture_output=True, cwd=root)
if result.returncode:
    raise SystemExit(f'Fly secret import failed (exit {result.returncode}); inspect account access without exposing credentials')
print(f'Fly {sys.argv[1]} secrets imported; values were not displayed')
