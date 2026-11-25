# MisaTV CPython runner, derived from yagami-hue/MisaTV (GPL-3.0).
FROM python:3.11.14-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /opt/misa
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY runner.py ./runner.py
COPY zip_runner.py ./zip_runner.py
COPY base ./base
USER 65532:65532
ENTRYPOINT ["python", "/opt/misa/zip_runner.py"]
