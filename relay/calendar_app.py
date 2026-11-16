"""Primary Google Calendar agenda through explicitly approved Zapier read tools."""
from datetime import date, datetime, time, timedelta
import json
from zoneinfo import ZoneInfo


def payload(result):
    data = result.get('structuredContent')
    if data is None:
        parts = [p['text'] for p in result.get('content', []) if p.get('type') == 'text']
        if len(parts) != 1: raise ValueError('Calendar returned an unsupported response')
        data = json.loads(parts[0])
    if not isinstance(data, dict) or not isinstance(data.get('results'), list) or data.get('isError'):
        raise ValueError('Calendar lookup did not return an event list')
    return data


def agenda(events, day, zone, partial=False):
    tz = ZoneInfo(zone)
    lower = datetime.combine(day, time.min, tz)
    upper = datetime.combine(day + timedelta(days=1), time.min, tz)
    rows = []
    seen = set()
    for event in events:
        if not isinstance(event, dict): raise ValueError('Invalid calendar event')
        if event.get('status') == 'cancelled': continue
        start, end = event.get('start', {}), event.get('end', {})
        if not isinstance(start, dict) or not isinstance(end, dict): raise ValueError('Invalid event dates')
        all_day = bool(start.get('date'))
        if all_day:
            a = datetime.combine(date.fromisoformat(start['date']), time.min, tz)
            b = datetime.combine(date.fromisoformat(end['date']), time.min, tz)
        else:
            a, b = [datetime.fromisoformat(x['dateTime'].replace('Z', '+00:00')) for x in (start, end)]
            if a.tzinfo is None or b.tzinfo is None: raise ValueError('Event timezone missing')
            a, b = a.astimezone(tz), b.astimezone(tz)
        if b <= lower or a >= upper: continue
        ident = (event.get('id'), a.isoformat())
        if not isinstance(ident[0], str) or not ident[0]: raise ValueError('Event ID missing')
        if ident in seen: continue
        seen.add(ident)
        title = event.get('summary') or 'Untitled event'
        location = event.get('location') or ''
        if not isinstance(title, str) or not isinstance(location, str): raise ValueError('Invalid event text')
        when = 'All day' if all_day else a.strftime('%H:%M') + '–' + b.strftime('%H:%M')
        rows.append((a, {'title': title[:120], 'time': when, 'location': location[:100]}))
    rows.sort(key=lambda row: row[0])
    entries = [row[1] for row in rows]
    blocks, shown = [], 0
    for e in entries:
        block = e['time'] + '\n' + e['title'] + ('\n' + e['location'] if e['location'] else '')
        if len('\n\n'.join(blocks + [block]).encode('utf-8')) > 2700: break
        blocks.append(block); shown += 1
    partial = partial or shown < len(entries)
    body = '\n\n'.join(blocks) or ('No events returned in this partial result.' if partial else 'No events on this date. Your day is clear.')
    if partial: body += '\n\nPartial agenda — open Google Calendar for the full list.'
    return {'card': {'title': 'GOOGLE CALENDAR', 'value': day.strftime('%a %d %b'), 'body': body,
                     'source': 'Partial · Google Calendar' if partial else 'Google Calendar · Scroll'},
            'date': day.isoformat(), 'timezone': zone, 'events': entries[:shown], 'partial': partial}


async def fetch(cloud, day=None):
    if cloud is None: raise ValueError('Connect Google Calendar in Orbit Console')
    required = ('google_calendar_find_calendars', 'google_calendar_find_events')
    connectors = [c for c in cloud.preferences['connectors'] if c['enabled'] and all(n in c['allowedTools'] for n in required)]
    if len(connectors) != 1: raise ValueError('Approve one Google Calendar connection and its calendar/event search tools')
    connector = connectors[0]
    routes = {raw: name for name, (ident, raw) in cloud.routes.items() if ident == connector['id']}
    if not all(n in routes for n in required): raise ValueError('Test the Google Calendar connection in Orbit Console')
    calendars = payload(await cloud.call(routes[required[0]], {'output_hint': 'Return id, primary, summary and timeZone for each calendar; preserve paging_token.'}))
    primary = [c for c in calendars['results'] if isinstance(c, dict) and c.get('primary') is True]
    if len(primary) != 1 or not isinstance(primary[0].get('id'), str): raise ValueError('Primary Google Calendar not found')
    zone = primary[0].get('timeZone') or 'Australia/Melbourne'
    tz = ZoneInfo(zone)
    target = date.fromisoformat(day) if day else datetime.now(tz).date()
    start = datetime.combine(target, time.min, tz)
    # Zapier names these backwards: end_time is the lower, start_time the upper bound.
    args = {'calendarid': primary[0]['id'], 'end_time': start.isoformat(),
            'start_time': (start + timedelta(days=1)).isoformat(), 'ordering': 'startTime',
            'output_hint': 'Return events with id, summary, start, end, status and location; preserve paging_token.'}
    events, cursor = [], None
    for _ in range(3):
        data = payload(await cloud.call(routes[required[1]], args))
        events.extend(data['results'])
        cursor = data.get('paging_token')
        if not cursor: break
        if not isinstance(cursor, str) or len(cursor) > 4096: raise ValueError('Invalid calendar pagination')
        args['paging_token'] = cursor
    return agenda(events, target, zone, bool(cursor))
