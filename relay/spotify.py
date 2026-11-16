"""Optional macOS Spotify control for the Orbit relay.

Only fixed AppleScript is sent to an already-running Spotify process. This
module does not play audio on the ESP32 and never launches Spotify.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Final

OSASCRIPT: Final = "/usr/bin/osascript"
_COMMUNICATE_TIMEOUT = 8.0
SPOTIFY_APP_PATHS: Final = (
    Path("/Applications/Spotify.app"),
    Path.home() / "Applications" / "Spotify.app",
)


class SpotifyError(ValueError):
    """Base error; ValueError keeps failures compatible with server.py."""


class SpotifyNotInstalledError(SpotifyError):
    """Spotify.app could not be found in the supported Mac locations."""


class SpotifyDisconnectedError(SpotifyError):
    """Spotify is installed but is not currently running or reachable."""


_NOT_RUNNING = "SPOTIFY_NOT_RUNNING"
_COMMON_SCRIPT = '''set spotify_running to false
tell application "System Events"
    set spotify_running to exists application process "Spotify"
end tell
if not spotify_running then return "SPOTIFY_NOT_RUNNING"
tell application "Spotify"
'''
_METADATA_SCRIPT = '''    set playback_state to (player state as text)
    try
        set track_name to name of current track
        set track_artist to artist of current track
        set track_album to album of current track
    on error
        set track_name to ""
        set track_artist to ""
        set track_album to ""
    end try
    return "OK" & tab & playback_state & tab & track_name & tab & track_artist & tab & track_album
end tell
'''

# These scripts are selected by a fixed action lookup. The caller's action is
# never inserted into AppleScript source.
_SCRIPTS: Final = {
    "status": _COMMON_SCRIPT + _METADATA_SCRIPT,
    "play": _COMMON_SCRIPT + "    play\n" + _METADATA_SCRIPT,
    "pause": _COMMON_SCRIPT + "    pause\n" + _METADATA_SCRIPT,
    "next": _COMMON_SCRIPT + "    next track\n" + _METADATA_SCRIPT,
    "previous": _COMMON_SCRIPT + "    previous track\n" + _METADATA_SCRIPT,
}


def _spotify_app_installed() -> bool:
    return any(path.is_dir() for path in SPOTIFY_APP_PATHS)


async def _kill_and_reap(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await process.wait()


async def _run_osascript(script: str) -> str:
    try:
        process = await asyncio.create_subprocess_exec(
            OSASCRIPT,
            "-e",
            script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=_COMMUNICATE_TIMEOUT
            )
        except asyncio.TimeoutError as error:
            await _kill_and_reap(process)
            raise SpotifyError("Spotify AppleScript timed out") from error
        except asyncio.CancelledError:
            await _kill_and_reap(process)
            raise
    except FileNotFoundError as error:
        raise SpotifyError("macOS osascript is unavailable") from error

    if process.returncode:
        detail = (stderr or stdout).decode("utf-8", "replace").strip()
        if "-600" in detail or "not running" in detail.lower():
            raise SpotifyDisconnectedError("Spotify is installed but not running")
        raise SpotifyError(f"Spotify AppleScript failed: {detail[:180] or 'unknown error'}")
    return stdout.decode("utf-8", "replace").strip()


async def control(action: str = "status") -> dict[str, str]:
    """Run one whitelisted Spotify action and return current metadata.

    Raises SpotifyNotInstalledError, SpotifyDisconnectedError, or SpotifyError
    with a user-safe message instead of accepting arbitrary AppleScript.
    """
    if type(action) is not str or action not in _SCRIPTS:
        raise SpotifyError("Unknown Spotify action; use status, play, pause, next, or previous")
    if not _spotify_app_installed():
        raise SpotifyNotInstalledError("Spotify is not installed on this Mac")

    output = await _run_osascript(_SCRIPTS[action])
    if output == _NOT_RUNNING:
        raise SpotifyDisconnectedError("Spotify is installed but not running; open Spotify first")

    fields = output.split("\t", 4)
    if len(fields) != 5 or fields[0] != "OK":
        raise SpotifyError("Spotify returned an invalid status response")
    return {
        "action": action,
        "state": fields[1],
        "track": fields[2],
        "artist": fields[3],
        "album": fields[4],
    }


__all__ = [
    "SpotifyDisconnectedError",
    "SpotifyError",
    "SpotifyNotInstalledError",
    "control",
]
