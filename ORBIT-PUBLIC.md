# Orbit for Waveshare ESP32-S3 Touch AMOLED 1.75C

Orbit is an experimental Wi-Fi voice companion with a round touch interface, animated orb, spoken replies, weather and calendar cards, notes, explicit memory, and optional MCP connections. The ESP32 handles display, touch, microphone and speaker audio. OpenAI voice processing, web search and connected services run through a separate relay. It is **not** an offline LLM, and it is currently designed for **one owner and one device per relay/console deployment**.

This is a modification of [XiaoZhi ESP32](https://github.com/78/xiaozhi-esp32). Preserve the upstream [MIT licence](LICENSE) and attribution when redistributing it. ESP-IDF components and other dependencies may carry their own licences.

## What to run

- `main/boards/waveshare/esp32-s3-touch-amoled-1.75/`: board firmware and Orbit UI.
- `relay/`: Python voice and tool service. Requires your own OpenAI API key and a private device credential. It can run locally with TLS or on your own HTTPS host.
- `console/`: optional Vercel configuration UI. Set up your own Vercel project and private storage. Its access code controls the entire instance; do not share a deployment among unrelated users.

## Private setup outline

1. Install ESP-IDF 6.0.2 and the Python/Node dependencies for your host. See the upstream build guide, `relay/requirements.txt` and `console/package.json`.
2. Create your own `relay/.private/` credentials. `python relay/bootstrap.py --host your-mac.local --device aa:bb:cc:dd:ee:ff` creates a device token and local certificate; replace the example MAC with your board's actual MAC. Keep the generated files private. Store your OpenAI key in `relay/.private/openai.key` for a local relay or as a host secret for cloud use.
3. For cloud use, deploy `relay/` to your own HTTPS service. `relay/fly.toml.example` is a template for Fly; copy it to ignored `relay/fly.toml` and replace the app name and URL. Set `ORBIT_FLY_APP` when using `relay/fly_secrets.py`. Set `ORBIT_CLOUD_URL=https://your-relay.example` before running `python relay/firmware_endpoint.py cloud` to generate the ignored firmware header.
4. Build the `orbit-amoled-1.75c` variant with `python scripts/build.py waveshare/esp32-s3-touch-amoled-1.75 --name orbit-amoled-1.75c --language en-US --wake-word disabled`. Check the actual board identity before flashing. `relay/flash.py` requires the privately configured MAC and preserves Wi-Fi settings on app-only updates.
5. Provision your own 2.4 GHz Wi-Fi credentials on the board. They are stored in device settings, not in this repository. Configure your own Vercel console, relay sync secrets and approved MCP connectors if you want calendar or other services.

Never commit `relay/.private/`, `.env` files, database copies, firmware binaries, screen captures or a deployed instance's access code. Published firmware binaries can contain a device bearer token, so create fresh credentials for each owner/device. A public copy of this source must not be wired to somebody else's relay or console. Voice and search requests may incur OpenAI charges; calendar and MCP access depend on the services you connect.

Current limits: Bluetooth LE on this board does not provide Bluetooth Classic headset audio; Bluetooth headphones are not implemented. Spotify and message sending are not implemented. Physical touch, audio quality and setup should be re-tested on each hardware revision.
