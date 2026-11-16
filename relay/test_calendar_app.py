"""Offline: relay/.venv/bin/python relay/test_calendar_app.py"""
import asyncio
from datetime import date
import json
from calendar_app import agenda, fetch, payload

DAY = date(2026, 4, 5)  # Sydney's 25-hour daylight-saving transition day.
EVENT = {'id': 'one', 'summary': 'All-day event', 'start': {'date': '2026-04-05'}, 'end': {'date': '2026-04-06'}}


class Cloud:
    preferences = {'connectors': [{'id': 'test', 'enabled': True, 'allowedTools': ['google_calendar_find_calendars', 'google_calendar_find_events']}]}
    routes = {'cal': ('test', 'google_calendar_find_calendars'), 'events': ('test', 'google_calendar_find_events')}
    async def call(self, name, args):
        if name == 'cal':
            result = {'results': [{'id': 'primary-test', 'primary': True, 'timeZone': 'Australia/Sydney'}]}
        else:
            assert args['calendarid'] == 'primary-test'
            assert args['end_time'] == '2026-04-05T00:00:00+11:00'
            assert args['start_time'] == '2026-04-06T00:00:00+10:00'
            result = {'results': [EVENT], **({} if args.get('paging_token') else {'paging_token': 'page2'})}
        return {'content': [{'type': 'text', 'text': json.dumps(result)}]}


async def check():
    result = await fetch(Cloud(), DAY.isoformat())
    assert len(result['events']) == 1 and not result['partial']  # deduplicated pages
    assert result['events'][0]['time'] == 'All day'
    cancelled = {**EVENT, 'id': 'cancel', 'status': 'cancelled'}
    outside = {**EVENT, 'id': 'outside', 'start': {'date': '2026-04-04'}, 'end': {'date': '2026-04-05'}}
    timed = {'id': 'timed', 'summary': 'Meeting', 'start': {'dateTime': '2026-04-05T00:00:00Z'}, 'end': {'dateTime': '2026-04-05T01:00:00Z'}}
    result = agenda([EVENT, timed, cancelled, outside], DAY, 'Australia/Sydney')
    assert [e['time'] for e in result['events']] == ['All day', '10:00–11:00']
    many = [{**EVENT, 'id': str(i), 'summary': '🌏' * 120} for i in range(100)]
    result = agenda(many, DAY, 'Australia/Sydney')
    assert result['partial'] and len(result['card']['body'].encode()) < 3000
    for invalid in ({}, {'content': [{'type': 'text', 'text': '{}'}]}):
        try: payload(invalid)
        except ValueError: pass
        else: raise AssertionError('Invalid result treated as empty calendar')
    assert not agenda([], DAY, 'Australia/Sydney')['partial']
    print('PASS: primary calendar, Zapier date bounds, DST, overlap, cancellation, pagination, deduplication and partial agenda limits')


asyncio.run(check())
