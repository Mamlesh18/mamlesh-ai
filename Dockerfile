FROM python:3.11-slim

# Node.js is needed for the filesystem MCP server
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && npm install -g @modelcontextprotocol/server-filesystem \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["python", "main.py"]
