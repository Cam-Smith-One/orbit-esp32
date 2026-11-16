"""One weather lookup shared by voice tools and the silent on-device app."""
import asyncio
import time
import aiohttp


class Weather:
    def __init__(self):
        self.cached = {}
        self.lock = asyncio.Lock()

    async def fetch(self, http, city):
        if not isinstance(city, str) or not 1 <= len(city.strip()) <= 100:
            raise ValueError('Invalid city')
        city = city.strip()
        # ponytail: one lookup at a time for this single-device relay; per-city locks if shared.
        async with self.lock:
            hit = self.cached.get(city.casefold())
            if hit and time.monotonic() - hit[0] < 300:
                return hit[1]

            async def get(url, params):
                async with http.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as r:
                    r.raise_for_status()
                    return await r.json()

            places = await get('https://geocoding-api.open-meteo.com/v1/search',
                               {'name': city, 'count': 1, 'language': 'en'})
            if not places.get('results'):
                raise ValueError('City not found')
            p = places['results'][0]
            data = await get('https://api.open-meteo.com/v1/forecast', {
                'latitude': p['latitude'], 'longitude': p['longitude'], 'timezone': 'auto',
                'current': 'temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m',
                'daily': 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code', 'forecast_days': 2})
            c, d = data['current'], data['daily']
            def condition(code):
                if code == 0: return 'Clear'
                if code in (1, 2, 3): return 'Cloudy'
                if code in (45, 48): return 'Fog'
                if 51 <= code <= 57: return 'Drizzle'
                if 61 <= code <= 67 or 80 <= code <= 82: return 'Rain'
                if 71 <= code <= 77 or code in (85, 86): return 'Snow'
                if code >= 95: return 'Thunderstorms'
                return 'Mixed conditions'
            card = {
                'city': p['name'][:24], 'temperature': f"{c['temperature_2m']:.0f}°",
                'detail': f"{condition(c['weather_code'])} {d['temperature_2m_min'][0]:.0f}-{d['temperature_2m_max'][0]:.0f}°C",
                'humidity': f"Humidity\n{c['relative_humidity_2m']}%",
                'wind': f"Wind\n{c['wind_speed_10m']:.0f} km/h",
                'rain': f"Rain\n{d['precipitation_probability_max'][0]}%",
                'tomorrow': f"{d['temperature_2m_min'][1]:.0f}-{d['temperature_2m_max'][1]:.0f}°C {condition(d['weather_code'][1])}\nRain {d['precipitation_probability_max'][1]}%",
                'source': 'Open-Meteo ' + c['time'][-5:]}
            if any(not isinstance(v, str) or len(v.encode()) > 128 for v in card.values()):
                raise ValueError('Weather response exceeds display limits')
            result = {'card': card, 'data': {'location': {k: p.get(k) for k in ('name', 'admin1', 'country')},
                                           'source': 'Open-Meteo', **data}}
            self.cached = {city.casefold(): (time.monotonic(), result)}
            return result
