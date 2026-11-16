"""Run: relay/.venv/bin/python relay/test_web_search.py (offline, no stored data)."""
import asyncio
import copy
import json
from types import SimpleNamespace

from aiohttp import web
from server import Conversation, Relay, TOOLS
from web_search import search, search_result

PAYLOAD = {'status': 'completed', 'output': [
    {'type': 'web_search_call', 'status': 'completed'},
    {'type': 'message', 'content': [{'type': 'output_text', 'text': 'Open daily.\ue200cite\ue202turn0\ue201',
      'annotations': [{'type': 'url_citation', 'url': 'https://example.org/hours', 'title': 'Opening hours'}]}]}]}


class HTTP:
    status = 200
    data = json.dumps(PAYLOAD).encode()

    def post(self, url, **kwargs):
        assert url == 'https://api.openai.com/v1/responses'
        assert kwargs['allow_redirects'] is False
        body = kwargs['json']
        assert body['store'] is False and body['tool_choice'] == 'required'
        assert body['tools'] == [{'type': 'web_search', 'external_web_access': True}]
        assert body['input'] == 'opening hours'
        self.content = self
        return self

    async def __aenter__(self): return self
    async def __aexit__(self, *args): return False
    async def iter_chunked(self, size): yield self.data


async def check():
    result = await search(HTTP(), 'test-only', 'opening hours')
    assert result['answer'] == 'Open daily.' and len(result['sources']) == 1
    markup = copy.deepcopy(PAYLOAD)
    markup['output'][1]['content'][0]['text'] = '**Open daily.** ([Hours](https://example.org/hours))'
    assert search_result(markup)['answer'] == 'Open daily. (Hours)'
    bad = [None, {}, {**PAYLOAD, 'status': 'incomplete'}, {**PAYLOAD, 'output': PAYLOAD['output'][1:]}]
    for url in ('javascript:alert(1)', 'https://user:pass@example.org', 'http://example.org', 'https://[bad', 'https://example.org/\n'):
        payload = copy.deepcopy(PAYLOAD)
        payload['output'][1]['content'][0]['annotations'][0]['url'] = url
        bad.append(payload)
    for payload in bad:
        try: search_result(payload)
        except ValueError: pass
        else: raise AssertionError('Invalid or uncited search accepted')
    for query in ('', 'x' * 301, None, 'sk-proj-secret'):
        try: await search(HTTP(), 'test-only', query)
        except ValueError: pass
        else: raise AssertionError('Unsafe search query accepted')
    for status, data in ((401, b''), (200, b'x' * (256 * 1024 + 1))):
        http = HTTP()
        http.status, http.data = status, data
        try: await search(http, 'test-only', 'opening hours')
        except ValueError: pass
        else: raise AssertionError('Failed/oversized search accepted')
    relay = SimpleNamespace(store=None, http=HTTP(), api_key=lambda: 'test-only', web_result=None)
    conversation = Conversation(relay, None)
    cards = []
    async def card(*args): cards.append(args); return True
    conversation.display_card = card
    try:
        assert any(t['name'] == 'web_search' for t in TOOLS)
        assert (await conversation.execute('web_search', {'query': 'opening hours'}))['displayed']
        assert cards == [('WEB SEARCH', '', 'Open daily.', 'example.org')]
        relay.web_result['answer'] = '<script>bad()</script>'
        response = await Relay.web_sources(relay, SimpleNamespace(host='127.0.0.1:8087'))
        assert '&lt;script&gt;' in response.text and '<script>' not in response.text
        assert 'href="https://example.org/hours"' in response.text
        try: await Relay.web_sources(relay, SimpleNamespace(host='attacker.example'))
        except web.HTTPForbidden: pass
        else: raise AssertionError('DNS rebinding allowed')
    finally:
        conversation.opus.close()
    print('PASS: live-search requirement, citation/query/body bounds, voice tool/card routing, escaped clickable sources, host protection')


asyncio.run(check())
