FROM python:3.11.14-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/misa
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bootstrap.js runner.py NOTICE.md LICENSE ./
USER 65532:65532
ENTRYPOINT ["python", "/opt/misa/runner.py"]
