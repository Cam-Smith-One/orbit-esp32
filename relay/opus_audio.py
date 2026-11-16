"""Tiny binding to installed libopus. Opus can decode the 16 kHz uplink at 24 kHz."""
import ctypes as C
import ctypes.util

lib = C.CDLL(ctypes.util.find_library('opus') or '/opt/homebrew/lib/libopus.dylib')
for name, args, result in [
    ('opus_decoder_create', [C.c_int, C.c_int, C.POINTER(C.c_int)], C.c_void_p),
    ('opus_encoder_create', [C.c_int, C.c_int, C.c_int, C.POINTER(C.c_int)], C.c_void_p),
    ('opus_decode', [C.c_void_p, C.c_void_p, C.c_int, C.c_void_p, C.c_int, C.c_int], C.c_int),
    ('opus_encode', [C.c_void_p, C.c_void_p, C.c_int, C.c_void_p, C.c_int], C.c_int),
    ('opus_decoder_destroy', [C.c_void_p], None),
    ('opus_encoder_destroy', [C.c_void_p], None),
]:
    fn = getattr(lib, name)
    fn.argtypes, fn.restype = args, result

class Opus:
    def __init__(self):
        err = C.c_int()
        self.decoder = lib.opus_decoder_create(24000, 1, C.byref(err))
        if err.value or not self.decoder:
            raise RuntimeError('Opus decoder initialization failed')
        self.encoder = lib.opus_encoder_create(24000, 1, 2049, C.byref(err))
        if err.value or not self.encoder:
            lib.opus_decoder_destroy(self.decoder)
            raise RuntimeError('Opus encoder initialization failed')

    def decode(self, packet):
        if not 0 < len(packet) <= 4096:
            raise ValueError('Invalid Opus packet length')
        pcm = C.create_string_buffer(24000 * 120 // 1000 * 2)
        samples = lib.opus_decode(self.decoder, packet, len(packet), pcm, len(pcm) // 2, 0)
        if samples < 0:
            raise ValueError(f'Opus decode failed: {samples}')
        return pcm.raw[:samples * 2]

    def encode(self, pcm):
        if len(pcm) != 2880:  # 60 ms, 24 kHz, mono, signed 16-bit
            raise ValueError('Expected exactly 60 ms of PCM')
        packet = C.create_string_buffer(4096)
        size = lib.opus_encode(self.encoder, pcm, 1440, packet, len(packet))
        if size < 0:
            raise ValueError(f'Opus encode failed: {size}')
        return packet.raw[:size]

    def close(self):
        lib.opus_decoder_destroy(self.decoder)
        lib.opus_encoder_destroy(self.encoder)
