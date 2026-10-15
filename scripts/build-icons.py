"""Convert the selected generated artwork to desktop formats (requires Pillow)."""
from pathlib import Path
import sys
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
art.save(assets / 'app.ico', format='ICO', sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
print('Created assets/app.png and assets/app.ico')
