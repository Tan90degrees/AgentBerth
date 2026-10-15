"""Convert the selected generated artwork to desktop formats (requires Pillow)."""
from pathlib import Path
import sys
import io
import struct
from PIL import Image

root = Path(__file__).resolve().parent.parent
source = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'assets' / 'app.png'
art = Image.open(source).convert('RGBA')
if art.width != art.height:
    raise ValueError('Application artwork must be square')
assets = root / 'assets'
assets.mkdir(exist_ok=True)
art = art.resize((512, 512), Image.Resampling.LANCZOS)
art.save(assets / 'app.png', optimize=True)
# Windows shell icon extraction needs conventional DIB frames at small sizes.
# Keep a PNG frame at 256px; include a correctly padded AND mask for each DIB.
frames = []
for size in (16, 20, 24, 32, 40, 48, 64, 128, 256):
    frame = art.resize((size, size), Image.Resampling.LANCZOS)
    if size == 256:
        output = io.BytesIO()
        frame.save(output, format='PNG')
        data = output.getvalue()
    else:
        pixels = frame.tobytes('raw', 'BGRA', 0, -1)
        mask_stride = ((size + 31) // 32) * 4
        mask = bytearray(mask_stride * size)
        alpha = frame.getchannel('A')
        for y in range(size):
            for x in range(size):
                if alpha.getpixel((x, size - 1 - y)) == 0:
                    mask[y * mask_stride + x // 8] |= 0x80 >> (x % 8)
        data = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0) + pixels + mask
    frames.append((size, data))
offset = 6 + 16 * len(frames)
entries = []
for size, data in frames:
    entries.append(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
    offset += len(data)
(assets / 'app.ico').write_bytes(struct.pack('<HHH', 0, 1, len(frames)) + b''.join(entries) + b''.join(data for _, data in frames))
print('Created assets/app.png and assets/app.ico')
