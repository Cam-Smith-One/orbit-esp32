"""One-time Fly diagnostic; prints tool names and error classes, never events."""
import asyncio
from pathlib import Path

from cloud_sync import CloudSync
from server import Relay
from calendar_app import fetch


async def main():
    relay = Relay()
    cloud = CloudSync(relay, Path('/nonexistent'))
    try:
        await cloud.discover()
        print('Connector states:', [(c['status'], len(c['tools'])) for c in cloud.connector_status])
        original = cloud.call
        last = '(none)'

        async def traced(name, args):
            nonlocal last
            last = cloud.routes.get(name, ('?', '?'))[1]
            try:
                return await original(name, args)
            except Exception as error:
                print('Tool failed:', last, type(error).__name__)
                raise

        cloud.call = traced
        try:
            result = await fetch(cloud)
            print('Calendar PASS:', result['date'], 'event count', len(result['events']))
        except Exception as error:
            print('Calendar failed after:', last, type(error).__name__)
    finally:
        if cloud.client:
            await cloud.client.close()
        relay.store.db.close()


asyncio.run(main())
