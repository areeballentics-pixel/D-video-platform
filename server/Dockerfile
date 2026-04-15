# Dockerfile for the FastAPI license server.
#
# Includes FFmpeg (used by the embedded encryption worker for transcoding).
# The arq worker runs in a background thread inside the FastAPI process
# (see app/main.py lifespan) so ONE container serves both HTTP and jobs.

FROM python:3.12-slim

# Install FFmpeg + build tools needed by some Python wheels (bcrypt, asyncpg).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        build-essential \
        libpq-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first for better Docker layer caching.
COPY pyproject.toml ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir .

# Copy the application source
COPY . .

# Railway / Render / Fly / Heroku inject PORT at runtime; default to 8000 for local.
ENV PORT=8000
# Stream stdout/stderr line-by-line so `docker logs` shows print() output
# immediately. Without this, Python buffers stdout until shutdown, making
# live log tailing useless for debugging.
ENV PYTHONUNBUFFERED=1
EXPOSE 8000

# Run Alembic migrations then start the server.
# The embedded arq worker is spawned by app.main.lifespan automatically.
CMD alembic upgrade head && \
    uvicorn app.main:app --host 0.0.0.0 --port ${PORT}
