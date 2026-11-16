"""Read loopback-only relay counters through Fly SSH; no secrets printed."""
import json
import os
import urllib.request

request = urllib.request.Request('http://127.0.0.1:8080/control',
    data=b'{"action":"status"}',
    headers={'Authorization': 'Bearer ' + os.environ['ORBIT_DEVICE_TOKEN'],
             'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=5) as response:
    print(json.loads(response.read()))
