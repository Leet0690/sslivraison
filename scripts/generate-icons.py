"""Generate the simple native SSlivraison app icon; no external dependencies."""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATTERN = ("11111", "10000", "10000", "11111", "00001", "00001", "11111")

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

for size in (192, 512):
    unit = size // 14
    x0, y0 = (size - unit * 5) // 2, (size - unit * 7) // 2
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            px, py = (x - x0) // unit, (y - y0) // unit
            white = 0 <= px < 5 and 0 <= py < 7 and PATTERN[py][px] == "1"
            pixels.extend((255, 255, 255) if white else (214, 58, 31))
    content = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    content += chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
    folder = ROOT / "icons"
    folder.mkdir(exist_ok=True)
    (folder / f"icon-{size}.png").write_bytes(content)
