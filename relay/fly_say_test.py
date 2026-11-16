"""Run through Fly SSH to verify real device playback; never exposed publicly."""
import asyncio
import os
import sys
import time

import aiohttp


async def main():
    headers = {'Authorization': 'Bearer ' + os.environ['ORBIT_DEVICE_TOKEN']}
    url = 'http://127.0.0.1:8080/control'
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as http:
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            async with http.post(url, headers=headers, json={'action': 'status'}) as response:
                status = await response.json()
            if status['connected']:
                break
            await asyncio.sleep(.4)
        else:
            raise SystemExit('Board did not connect to Fly in 35 seconds')
        baseline = status['downlink_frames']
        calendar = '--calendar' in sys.argv
        prompt = ('What is on my Google Calendar today? Give a short spoken summary and show the agenda.'
                  if calendar else 'Say one short sentence: Orbit is speaking through the cloud relay.')
        while time.monotonic() < deadline:
            async with http.post(url, headers=headers, json={
                'action': 'say', 'text': prompt}) as response:
                if response.status == 200:
                    print('Realtime speech requested on the connected device')
                    break
            await asyncio.sleep(.4)
        else:
            raise SystemExit('Connected board never became ready for speech')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            async with http.post(url, headers=headers, json={'action': 'status'}) as response:
                status = await response.json()
            if status['downlink_frames'] > baseline:
                print('PASS: board received', status['downlink_frames'] - baseline, 'new speech frames through Fly')
                return
            await asyncio.sleep(.5)
        raise SystemExit('No speech frames reached the board')


asyncio.run(main())
