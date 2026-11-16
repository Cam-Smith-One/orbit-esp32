"""Run: .venv/bin/python check.py -- no API calls, no hardware, no persistent test data."""
import asyncio
from array import array
import math
from pathlib import Path
import tempfile
import bootstrap
import contextlib
import io
from memory import MemoryStore
from opus_audio import Opus, lib, C
from server import Conversation, string, session_config

async def check():
    original_root = bootstrap.ROOT
    try:
        with tempfile.TemporaryDirectory(prefix='orbit-bootstrap-') as directory:
            bootstrap.ROOT = Path(directory)
            args = ['--host', 'test-orbit.local', '--device', '00:11:22:33:44:55']
            with contextlib.redirect_stdout(io.StringIO()):
                bootstrap.main(args)
                private = bootstrap.ROOT / '.private'
                before = {name: (private / name).read_bytes() for name in ('server.key', 'server.crt', 'config.json')}
                bootstrap.main(args)
                assert all((private / name).read_bytes() == value for name, value in before.items())
                with contextlib.redirect_stderr(io.StringIO()):
                    try: bootstrap.main(['--host', 'different.local', '--device', '00:11:22:33:44:55'])
                    except SystemExit as error: assert error.code == 2
                    else: raise AssertionError('Host change silently rotated trusted credentials')
                assert all((private / name).read_bytes() == value for name, value in before.items())
                assert (private / 'server.pem').read_bytes() == before['server.crt']
    finally:
        bootstrap.ROOT = original_root
    with tempfile.TemporaryDirectory(prefix='orbit-check-') as directory:
        path = Path(directory) / 'memory.db'
        store = MemoryStore(path)
        fact = store.remember('Testing a private memory')
        assert store.remember('Testing a private memory') == fact
        assert not store.recall('absent') and len(store.recall('private')) == 1
        store.db.close()
        store = MemoryStore(path)
        assert len(store.recall()) == 1, 'Memory must survive restart'
        assert store.forget(fact['id']) and not store.forget(fact['id'])
        assert not store.recall()
        note = store.save_note('This is the exact dictated text.')
        assert store.notes()[0]['text'] == note['text']
        assert store.delete_note(note['id']) and not store.notes()
        config = session_config(store)['session']
        assert config['audio']['input']['format']['rate'] == 24000
        assert config['output_modalities'] == ['audio']
        store.db.close()
    for value in ('x' * 501, '', None, 7):
        try: string({'fact': value}, 'fact', 500)
        except ValueError: pass
        else: raise AssertionError('Invalid input accepted')
    opus = Opus()
    pcm = array('h', [int(6000 * math.sin(i * 2 * math.pi * 440 / 24000)) for i in range(1440)]).tobytes()
    encoded = opus.encode(pcm)
    decoded = opus.decode(encoded)
    assert len(decoded) == len(pcm)
    assert max(abs(x) for x in array('h', decoded)) > 2000, 'Audio unexpectedly silent'
    # The physical board uplink is 16 kHz, unlike the relay's 24 kHz downlink.
    error = C.c_int()
    encoder16 = lib.opus_encoder_create(16000, 1, 2049, C.byref(error))
    assert encoder16 and error.value == 0
    try:
        pcm16 = array('h', [int(6000 * math.sin(i * 2 * math.pi * 440 / 16000)) for i in range(960)]).tobytes()
        packet16 = C.create_string_buffer(4096)
        size16 = lib.opus_encode(encoder16, pcm16, 960, packet16, len(packet16))
        assert size16 > 0
        converted = opus.decode(packet16.raw[:size16])
        assert len(converted) == 2880, '16 kHz uplink must decode to 60 ms at 24 kHz'
        assert max(map(abs, array('h', converted))) > 2000
    finally:
        lib.opus_encoder_destroy(encoder16)
    for bad in (b'', b'x' * 4097):
        try: opus.decode(bad)
        except ValueError: pass
        else: raise AssertionError('Bad Opus length accepted')
    opus.close()
    # The content rectangles fit inside the actual circle, not merely the framebuffer.
    for x, y, w, h in [(103,120,260,260), (71,136,324,252), (71,108,324,280), (62,77,204,90), (93,383,280,30), (133,416,200,26),
                        (58,276,350,98), (46,208,118,62), (174,208,118,62), (302,208,118,62),
                        (103,40,260,40), (107,128,104,104), (255,128,104,104),
                        (107,270,104,104), (255,270,104,104), (101,379,116,26), (249,379,116,26),
                        (81,177,304,56), (81,289,304,56), (204,398,58,58)]:
        for px in (x, x+w):
            for py in (y, y+h): assert (px-233)**2 + (py-233)**2 <= 233**2
    print('PASS: stable TLS bootstrap, memory restart/deletion, input bounds, 16/24 kHz Opus, Realtime configuration, round-screen safe areas')

asyncio.run(check())
