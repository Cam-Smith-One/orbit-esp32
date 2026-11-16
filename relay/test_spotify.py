import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import spotify


class _FakeProcess:
    def __init__(self, stdout=b"", stderr=b"", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode
        self.killed = False
        self.reaped = False

    async def communicate(self):
        return self.stdout, self.stderr

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        self.reaped = True
        return self.returncode


class _HangingProcess(_FakeProcess):
    def __init__(self):
        super().__init__(returncode=None)
        self.started = asyncio.Event()

    async def communicate(self):
        self.started.set()
        await asyncio.Event().wait()


class SpotifyControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_parses_metadata_without_playback(self):
        run = AsyncMock(return_value=_FakeProcess(b"OK\tplaying\tTrack\tArtist\tAlbum\n"))
        with patch.object(spotify, "_spotify_app_installed", return_value=True), \
                patch.object(spotify.asyncio, "create_subprocess_exec", new=run):
            result = await spotify.control("status")

        self.assertEqual(result, {
            "action": "status",
            "state": "playing",
            "track": "Track",
            "artist": "Artist",
            "album": "Album",
        })
        args = run.await_args.args
        self.assertEqual(args[:2], (spotify.OSASCRIPT, "-e"))
        self.assertIn('exists application process "Spotify"', args[2])
        self.assertNotIn("\n    play\n", args[2])
        self.assertNotIn("\n    pause\n", args[2])
        self.assertNotIn("\n    next track\n", args[2])
        self.assertNotIn("\n    previous track\n", args[2])

    async def test_not_installed_does_not_call_osascript(self):
        run = AsyncMock()
        with patch.object(spotify, "_spotify_app_installed", return_value=False), \
                patch.object(spotify.asyncio, "create_subprocess_exec", new=run):
            with self.assertRaisesRegex(spotify.SpotifyNotInstalledError, "not installed"):
                await spotify.control("status")
        run.assert_not_awaited()

    async def test_not_running_is_a_clear_disconnected_error(self):
        run = AsyncMock(return_value=_FakeProcess(b"SPOTIFY_NOT_RUNNING\n"))
        with patch.object(spotify, "_spotify_app_installed", return_value=True), \
                patch.object(spotify.asyncio, "create_subprocess_exec", new=run):
            with self.assertRaisesRegex(spotify.SpotifyDisconnectedError, "not running"):
                await spotify.control("status")

    async def test_timeout_kills_and_reaps_subprocess(self):
        process = _HangingProcess()
        run = AsyncMock(return_value=process)
        with patch.object(spotify, "_spotify_app_installed", return_value=True), \
                patch.object(spotify.asyncio, "create_subprocess_exec", new=run), \
                patch.object(spotify, "_COMMUNICATE_TIMEOUT", 0.01):
            with self.assertRaisesRegex(spotify.SpotifyError, "timed out"):
                await spotify.control("status")
        self.assertTrue(process.killed)
        self.assertTrue(process.reaped)

    async def test_cancellation_kills_and_reaps_subprocess(self):
        process = _HangingProcess()
        run = AsyncMock(return_value=process)
        with patch.object(spotify, "_spotify_app_installed", return_value=True), \
                patch.object(spotify.asyncio, "create_subprocess_exec", new=run):
            task = asyncio.create_task(spotify.control("status"))
            await asyncio.wait_for(process.started.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(process.killed)
        self.assertTrue(process.reaped)

    async def test_unknown_action_is_rejected_before_subprocess(self):
        run = AsyncMock()
        with patch.object(spotify.asyncio, "create_subprocess_exec", new=run):
            with self.assertRaisesRegex(spotify.SpotifyError, "Unknown Spotify action"):
                await spotify.control("seek")
        run.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
