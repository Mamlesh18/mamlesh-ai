"""Simple console logger. Usage: log = get_logger(__name__)"""
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)

# One line per HTTP request (OpenAI, MCP, embeddings) is noise; warnings and errors still show.
for _noisy in ("httpx", "httpx2"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)
