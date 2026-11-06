"""Deepgram speech-to-text proxy.

The browser sends mic audio to our /ws/stt, we forward it to Deepgram and send the transcripts back.
This way the Deepgram API key never leaves the server.
"""
import asyncio

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from utils.env import DEEPGRAM_API_KEY
from utils.logger import get_logger

log = get_logger(__name__)

DEEPGRAM_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-3&smart_format=true&interim_results=true&endpointing=300"
)


async def proxy_to_deepgram(browser: WebSocket):
    await browser.accept()
    if not DEEPGRAM_API_KEY:
        await browser.close(code=1011, reason="DEEPGRAM_API_KEY is not set in .env")
        return

    async with websockets.connect(DEEPGRAM_URL, additional_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"}) as dg:

        async def browser_to_deepgram():
            try:
                while True:
                    msg = await browser.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
                    if msg.get("bytes"):
                        await dg.send(msg["bytes"])  # audio
                    elif msg.get("text"):
                        await dg.send(msg["text"])   # control, e.g. {"type": "CloseStream"}
            except (WebSocketDisconnect, RuntimeError, websockets.ConnectionClosed):
                pass
            try:
                await dg.send('{"type": "CloseStream"}')
            except websockets.ConnectionClosed:
                pass

        async def deepgram_to_browser():
            try:
                async for msg in dg:  # ends when Deepgram closes after CloseStream
                    await browser.send_text(msg)
            except Exception as e:
                log.warning("STT stream ended: %s", e)
            try:
                await browser.close()  # tells the browser the final transcript is in
            except Exception:
                pass

        await asyncio.gather(browser_to_deepgram(), deepgram_to_browser())
