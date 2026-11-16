FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends libopus0 ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py cloud_sync.py memory.py opus_audio.py weather.py web_search.py mcp_client.py calendar_app.py import_fly_seed.py ./
CMD ["python", "server.py"]
