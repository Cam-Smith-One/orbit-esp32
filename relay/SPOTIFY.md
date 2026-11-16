# Optional Spotify bridge

`relay/spotify.py` exposes one awaited function for the parent relay:

```python
from spotify import control

metadata = await control("status")
```

Allowed actions are `status`, `play`, `pause`, `next`, and `previous`. A successful result is JSON-serializable:

```python
{"action": "status", "state": "playing", "track": "...", "artist": "...", "album": "..."}
```

`SpotifyNotInstalledError`, `SpotifyDisconnectedError`, and `SpotifyError` inherit `ValueError`, so the existing dispatcher can convert them to its normal `{"error": ...}` tool result. The parent can use `track` as the card value, `artist · album` as the body, and `state` as the fallback value.

The module sends only fixed `/usr/bin/osascript` programs, checks for an already-running Spotify process, and never launches Spotify or plays DRM audio on the ESP32. Spotify must be opened by the user first. It recognizes the normal `/Applications/Spotify.app` and `~/Applications/Spotify.app` locations.

On this Mac, Spotify is not installed or LaunchServices-registered, so no local `.sdef` dictionary was available and no live status query was made. Tests use mocked subprocesses and issue no playback-changing commands:

```sh
cd relay && .venv/bin/python -m unittest -v test_spotify.py
```
