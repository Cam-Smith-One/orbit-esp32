"""Run with: PYTHONPATH=relay python3 relay/test_session.py"""
import asyncio
import json
from array import array
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time

import aiohttp

from memory import MemoryStore
from mcp_client import MCPTransportError
from server import Conversation, TOOLS, session_config


class Message:
    def __init__(self, message_type, data):
        self.type, self.data = message_type, data


class FakeSocket:
    def __init__(self, messages=()):
        self.messages = iter(messages)
        self.sent = []

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self.messages)
        except StopIteration as error:
            raise StopAsyncIteration from error

    async def send_json(self, value):
        self.sent.append(('json', value))

    async def send_bytes(self, value):
        self.sent.append(('bytes', value))

    async def close(self):
        self.closed = True


class FakeHTTPResponse:
    def __init__(self, payload):
        self.payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def raise_for_status(self):
        return None

    async def json(self):
        return self.payload


class FakeHTTP:
    def __init__(self, payloads):
        self.payloads = iter(payloads)

    def get(self, url, params, timeout):
        return FakeHTTPResponse(next(self.payloads))


class StartupDevice(FakeSocket):
    def __init__(self, order):
        super().__init__()
        self.order = order

    async def receive_json(self):
        return {'type': 'hello', 'version': 1,
                'audio_params': {'format': 'opus', 'sample_rate': 16000,
                                 'channels': 1, 'frame_duration': 60}}

    async def send_json(self, value):
        if value.get('type') == 'hello':
            self.order.append('device-hello')
        await super().send_json(value)


class StartupOpenAI(FakeSocket):
    def __init__(self, order, messages=()):
        super().__init__(messages)
        self.order = order

    async def __anext__(self):
        try:
            return next(self.messages)
        except StopIteration:
            await asyncio.Future()

    async def send_json(self, value):
        if value.get('type') == 'session.update':
            self.order.append('session-configured')
        await super().send_json(value)


class StartupHTTP:
    def __init__(self, order):
        self.order = order
        self.socket = None

    async def ws_connect(self, *args, **kwargs):
        self.order.append('openai-connected')
        self.socket = StartupOpenAI(self.order, [Message(
            aiohttp.WSMsgType.TEXT, json.dumps({'type': 'session.updated'}))])
        return self.socket


async def test_session():
    with tempfile.TemporaryDirectory(prefix='orbit-session-') as directory:
        store = MemoryStore(Path(directory) / 'memory.db')
        device = FakeSocket()
        openai = FakeSocket()
        conversation = Conversation(SimpleNamespace(store=store), device)
        conversation.openai = openai
        try:
            card_properties = next(item for item in TOOLS if item['name'] == 'show_card')['parameters']['properties']
            assert {key: (value['minLength'], value['maxLength']) for key, value in card_properties.items()} == {
                'title': (1, 32), 'value': (0, 28), 'body': (0, 400), 'source': (0, 80)}
            remember_properties = next(item for item in TOOLS if item['name'] == 'remember')['parameters']['properties']
            assert (remember_properties['fact']['minLength'], remember_properties['fact']['maxLength']) == (1, 500)
            weather_tool = next(item for item in TOOLS if item['name'] == 'weather')
            assert 'already displays' in weather_tool['description']
            config = session_config(store)
            assert 'Weather already displays' in config['session']['instructions']
            assert 'natural contemporary Australian accent' in config['session']['instructions']
            assert 'then show_card' in config['session']['instructions']
            assert 'Never substitute Outlook when Google Calendar is requested' in config['session']['instructions']
            assert config['session']['audio']['output']['voice'] == 'marin'
            assert config['session']['audio']['input']['turn_detection']['silence_duration_ms'] == 450
            try:
                await conversation.execute('remember', {'fact': 'x' * 501})
            except ValueError:
                pass
            else:
                raise AssertionError('oversized facts must be rejected, not truncated')
            await conversation.set_vad_mode('realtime')
            assert conversation.vad_mode == 'auto', 'Device AEC realtime mode must be accepted'
            packet = conversation.opus.encode(array('h', [0] * 1440).tobytes())
            device.messages = iter([
                Message(aiohttp.WSMsgType.TEXT, json.dumps({'type': 'listen', 'state': 'start', 'mode': 'manual'})),
                Message(aiohttp.WSMsgType.BINARY, packet),
                Message(aiohttp.WSMsgType.BINARY, packet),
                Message(aiohttp.WSMsgType.TEXT, json.dumps({'type': 'listen', 'state': 'stop', 'mode': 'manual'})),
            ])
            await conversation.from_device()
            openai_events = [value for kind, value in openai.sent if kind == 'json']
            assert sum(event['type'] == 'input_audio_buffer.append' for event in openai_events) == 2
            assert sum(event['type'] == 'input_audio_buffer.commit' for event in openai_events) == 1
            assert sum(event['type'] == 'response.create' for event in openai_events) == 1
            assert any(event['type'] == 'session.update' and
                       event['session']['audio']['input']['turn_detection'] is None
                       for event in openai_events)
            openai.messages = iter([Message(
                aiohttp.WSMsgType.TEXT,
                json.dumps({'type': 'input_audio_buffer.speech_stopped'})),
            ])
            await conversation.from_openai()
            assert sum(event['type'] == 'response.create'
                       for kind, event in openai.sent if kind == 'json') == 1

            await conversation.queue.put((conversation.generation, b'x' * 2880))
            conversation.speaking = True
            conversation.response_id = 'response-1'
            conversation.response_requested = True
            conversation.item_id = 'item-1'
            conversation.audio_started = time.monotonic() - 1
            conversation.sent_samples = 1440
            await conversation.interrupt()
            assert not conversation.speaking and conversation.response_id is None and conversation.item_id is None
            assert conversation.queue.empty()
            assert any(event == {'type': 'tts', 'state': 'stop'}
                       for kind, event in device.sent if kind == 'json')
            assert any(event == {'type': 'response.cancel'}
                       for kind, event in openai.sent if kind == 'json')
            conversation.response_requested = True
            conversation.response_in_flight = True
            conversation.response_id = None
            await conversation.interrupt()
            openai.messages = iter([Message(
                aiohttp.WSMsgType.TEXT,
                json.dumps({'type': 'response.created', 'response': {'id': 'late-response'}})),
            ])
            await conversation.from_openai()
            assert conversation.response_id is None and 'late-response' in conversation.ignored
            openai.messages = iter([Message(
                aiohttp.WSMsgType.TEXT,
                json.dumps({'type': 'response.done', 'response': {
                    'id': 'response-1', 'status': 'cancelled',
                    'output': [{'type': 'function_call', 'name': 'remember',
                                'call_id': 'cancelled', 'arguments': '{"fact":"must not save"}'}]}})),
            ])
            await conversation.from_openai()
            assert not store.recall('must not save')

            async def failed_card(*args):
                raise ValueError('display unavailable')

            conversation.card = failed_card
            await conversation.execute('record_note', {})
            conversation.response_requested = False
            conversation.openai = FakeSocket([
                Message(aiohttp.WSMsgType.TEXT, json.dumps({
                    'type': 'input_audio_buffer.speech_started', 'item_id': 'note-1'})),
                Message(aiohttp.WSMsgType.TEXT, json.dumps({
                    'type': 'conversation.item.input_audio_transcription.completed',
                    'item_id': 'old-1', 'transcript': 'Late earlier utterance.'})),
                Message(aiohttp.WSMsgType.TEXT, json.dumps({
                    'type': 'conversation.item.input_audio_transcription.completed',
                    'item_id': 'note-1', 'transcript': 'Verbatim dictated text.'})),
            ])
            await conversation.from_openai()
            assert store.notes()[0]['text'] == 'Verbatim dictated text.'
            assert not conversation.record_next and conversation.note_item_id is None
            memory_result = await conversation.execute('remember', {'fact': 'Persist this even if the card is unavailable.'})
            assert memory_result['displayed'] is False
            assert store.recall('Persist this even if the card is unavailable.')

            weather_calls = []

            async def capture_rpc(name, arguments):
                weather_calls.append((name, arguments))
                return {}

            conversation.rpc = capture_rpc
            conversation.relay.http = FakeHTTP([
                {'results': [{'name': 'Melbourne', 'admin1': 'Victoria', 'country': 'Australia',
                              'latitude': -37.8, 'longitude': 144.9}]},
                {'current': {'temperature_2m': 12, 'weather_code': 1,
                              'relative_humidity_2m': 60, 'wind_speed_10m': 10,
                              'time': '2026-09-08T19:13'},
                 'daily': {'temperature_2m_min': [6, 10], 'temperature_2m_max': [15, 13],
                           'precipitation_probability_max': [20, 30], 'weather_code': [1, 0]}}])
            await conversation.execute('weather', {'city': 'Melbourne'})
            weather_payload = weather_calls[0][1]
            assert weather_payload['detail'] == 'Cloudy 6-15°C'
            assert weather_payload['tomorrow'] == '10-13°C Clear\nRain 30%'
            assert '615°C' not in weather_payload['detail']
            assert '1013°C' not in weather_payload['tomorrow']
            assert not any(mark in weather_payload[key] for key in ('detail', 'tomorrow', 'source')
                           for mark in ('–', '·'))

            async def unavailable_tool(name, args):
                raise MCPTransportError('MCP request failed')
            error_socket = FakeSocket([Message(aiohttp.WSMsgType.TEXT, json.dumps({
                'type': 'response.done', 'response': {'status': 'completed', 'output': [{
                    'type': 'function_call', 'name': 'mcp_test', 'call_id': 'test-mcp', 'arguments': '{}'}]}}))])
            error_conversation = Conversation(SimpleNamespace(store=store, cloud=SimpleNamespace(call=unavailable_tool)), device)
            error_conversation.openai = error_socket
            try:
                await error_conversation.from_openai()
                result_events = [v for kind, v in error_socket.sent if kind == 'json' and v['type'] == 'conversation.item.create']
                assert json.loads(result_events[0]['item']['output']) == {'error': 'MCP request failed'}
                assert any(v['type'] == 'response.create' for kind, v in error_socket.sent if kind == 'json')
            finally:
                error_conversation.opus.close()

            startup_order = []
            startup_store = MemoryStore(Path(directory) / 'startup.db')
            startup_relay = SimpleNamespace(store=startup_store, http=StartupHTTP(startup_order),
                                            api_key=lambda: 'test-key')
            startup_device = StartupDevice(startup_order)
            startup_device.messages = iter([
                Message(aiohttp.WSMsgType.TEXT, json.dumps({'type': 'listen', 'state': 'start', 'mode': 'auto'})),
                Message(aiohttp.WSMsgType.BINARY, packet),
            ])
            await Conversation(startup_relay, startup_device).run()
            assert startup_order.index('openai-connected') < startup_order.index('device-hello')
            assert startup_order.index('session-configured') < startup_order.index('device-hello')
            startup_events = [value for kind, value in startup_relay.http.socket.sent if kind == 'json']
            assert any(event['type'] == 'input_audio_buffer.append' for event in startup_events)
            startup_store.db.close()

            # AEC mode streams silence too; one minute of idle audio is not an oversized turn.
            conversation.listening = True
            await conversation.set_vad_mode('realtime')
            conversation.received_samples = 24_000 * 60
            device.messages = iter([Message(aiohttp.WSMsgType.BINARY, packet)])
            await conversation.from_device()
            assert conversation.received_samples > 24_000 * 60
        finally:
            conversation.opus.close()
            store.db.close()


asyncio.run(test_session())
print('PASS: startup readiness, weather card encoding, VAD, interruption, bounded playback, and exact notes')
