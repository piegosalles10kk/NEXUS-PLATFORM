FROM python:3.12-slim

WORKDIR /app

# Install build deps for XGBoost native binaries
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8500

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8500", "--workers", "2"]
