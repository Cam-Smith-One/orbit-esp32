"""Exercise the real TLS relay and OpenAI with a simulated device (not hardware proof).

Run explicitly: .venv/bin/python live_check.py
Sends one short test prompt, decodes returned Opus audio, never touches stored memories.
"""
import asyncio
import json
from pathlib import Path
import ssl
from array import array
import aiohttp
from opus_audio import Opus

ROOT = Path(__file__).resolve().parent

async def main():
    config = json.loads((ROOT / '.private/config.json').read_text())
    tls = ssl.create_default_context(cafile=ROOT / '.private/server.crt')
    headers = {'Authorization': 'Bearer ' + config['token'], 'Device-Id': config['device']}
    codec = Opus()
    counts = {'packets': 0, 'samples': 0, 'peak': 0}
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=tls)) as http:
        async with http.post('https://localhost:8443/control', headers=headers, json={'action': 'status'}) as r:
            status = await r.json()
            if status['connected']: raise SystemExit('Real device already connected; do not interrupt it for a simulated test.')
        async with http.ws_connect('wss://localhost:8443/device', headers=headers) as ws:
            await ws.send_json({'type': 'hello', 'version': 1, 'transport': 'websocket',
                                'audio_params': {'format': 'opus', 'sample_rate': 16000, 'channels': 1, 'frame_duration': 60}})
            assert (await ws.receive_json())['type'] == 'hello'
            async def receive():
                async for message in ws:
                    if message.type == aiohttp.WSMsgType.BINARY:
                        samples = array('h', codec.decode(message.data))
                        counts['packets'] += 1
                        counts['samples'] += len(samples)
                        counts['peak'] = max(counts['peak'], max(map(abs, samples)))
                    elif message.type == aiohttp.WSMsgType.TEXT:
                        event = json.loads(message.data)
                        if event.get('type') == 'mcp':
                            rpc = event['payload']
                            await ws.send_json({'type': 'mcp', 'payload': {'jsonrpc': '2.0', 'id': rpc['id'],
                                                'result': {'content': [{'type': 'text', 'text': 'true'}]}}})
                        if event.get('type') == 'tts' and event.get('state') == 'stop': return
                        if event.get('type') == 'alert': raise AssertionError(event.get('message'))
            receiver = asyncio.create_task(receive())
            await ws.send_json({'type': 'listen', 'state': 'start', 'mode': 'realtime'})
            await asyncio.sleep(2)
            async with http.post('https://localhost:8443/control', headers=headers, json={
                'action': 'say', 'text': 'For a connection test, say only: Orbit is ready. Do not call tools or save anything.'}) as r:
                assert r.status == 200, await r.text()
            await asyncio.wait_for(receiver, 30)
    codec.close()
    assert counts['packets'] > 4 and counts['peak'] > 100, counts
    print('PASS: real OpenAI response through TLS relay and Opus decoder:', counts)

asyncio.run(main())
