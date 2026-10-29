"""Pack the pinned MIT DSH character frames into offline GIFs and static posters.

No drawing, synthetic poses, frame dropping or runtime downloads. Pillow is a
build-time dependency only: python -m pip install Pillow==12.0.0
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import tempfile
import time
from urllib.request import urlopen
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'src/renderer/pet-assets'
CONFIG = ROOT / 'assets/pet/source.json'
REPORT = DEST / 'provenance.json'
BUDGET = 8 * 1024 * 1024


def download(url):
    for attempt in range(4):
        try:
            with urlopen(url, timeout=30) as response:
                return response.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt * 2)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify():
    config = json.loads(CONFIG.read_text())
    report = json.loads(REPORT.read_text())
    assert report['importCommit'] == config['commit']
    assert report['sourceFps'] == config['fps'] == 24
    assert report['canvas'] == config['canvas']
    for status, selection in config['states'].items():
        record = report['states'][status]
        assert record['clip'] == selection['clip']
        data = (DEST / (status + '.gif')).read_bytes()
        assert len(data) <= BUDGET and digest(data) == record['gifSha256']
        with Image.open(BytesIO(data)) as image:
            assert image.size == tuple(config['canvas'])
            assert image.n_frames >= 24, (status, image.n_frames)
            assert (image.info.get('loop') == 0) == selection['loop']
            assert image.convert('RGBA').getpixel((0, 0))[3] == 0
            total = 0
            for n in range(image.n_frames):
                image.seek(n)
                total += image.info['duration']
            assert abs(total - record['sourceFrames'] * 1000 / 24) <= 10
        poster = (DEST / (status + '.png')).read_bytes()
        assert digest(poster) == record['posterSha256']
        with Image.open(BytesIO(poster)) as image:
            assert image.size == tuple(config['canvas'])
            assert image.mode == 'RGBA'
        print(status + ': ' + str(record['sourceFrames']) + ' frames, ' + str(len(data)) + ' bytes', flush=True)
    assert (ROOT / 'assets/pet/LICENSE-PC2005-cloud.txt').is_file()
    assert (ROOT / 'assets/pet/LICENSE-QCYTSN.txt').is_file()


def render():
    config = json.loads(CONFIG.read_text())
    base = 'https://raw.githubusercontent.com/' + config['repository'] + '/' + config['commit'] + '/'
    manifest_bytes = download(base + config['manifest'])
    blob = hashlib.sha1(b'blob ' + str(len(manifest_bytes)).encode() + b'\0' + manifest_bytes).hexdigest()
    assert blob == config['manifestBlob'], 'Pinned manifest digest mismatch'
    manifest = json.loads(manifest_bytes)
    cache = Path(tempfile.gettempdir()) / 'agentberth-pet-frames' / config['commit']
    paths = sorted({frame for state in config['states'].values() for frame in manifest['clips'][state['clip']]['frames']})

    def cache_frame(relative):
        parts = PurePosixPath(relative).parts
        assert len(parts) == 2 and '..' not in parts and relative.endswith('.webp')
        target = cache / relative
        if not target.is_file():
            data = download(base + 'assets/pet/' + relative)
            with Image.open(BytesIO(data)) as image:
                image.verify()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        return target

    print('Downloading ' + str(len(paths)) + ' pinned transparent frames', flush=True)
    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(cache_frame, paths))
    DEST.mkdir(parents=True, exist_ok=True)
    canvas = tuple(config['canvas'])

    def rgba_frame(relative):
        with Image.open(cache / relative) as source:
            fitted = ImageOps.contain(source.convert('RGBA'), canvas, Image.Resampling.LANCZOS)
        frame = Image.new('RGBA', canvas, (0, 0, 0, 0))
        frame.alpha_composite(fitted, ((canvas[0] - fitted.width) // 2, canvas[1] - fitted.height))
        return frame

    report = {'version': 1, 'importRepository': config['repository'], 'importCommit': config['commit'],
              'originalSource': manifest['assetSource'], 'sourceFps': config['fps'], 'canvas': config['canvas'], 'states': {}}
    for status, selection in config['states'].items():
        clip = manifest['clips'][selection['clip']]
        paths = clip['frames']
        # One palette for an entire action keeps skin/hair/outline colours stable.
        samples = [rgba_frame(paths[round(n * (len(paths) - 1) / 15)]) for n in range(16)]
        swatches = Image.new('RGB', (canvas[0] * 4, canvas[1] * 4))
        for n, sample in enumerate(samples):
            swatches.paste(sample.convert('RGB'), ((n % 4) * canvas[0], (n // 4) * canvas[1]))
        palette = swatches.quantize(colors=255)
        colours = palette.getpalette()
        colours += [0] * (768 - len(colours))
        palette.putpalette(colours)
        reserved = colours[255 * 3:256 * 3]
        # Pillow may select unused black index 255; remap it before reserving alpha.
        opaque_index = min(range(255), key=lambda n: sum((colours[n * 3 + c] - reserved[c]) ** 2 for c in range(3)))
        remap = bytes(opaque_index if n == 255 else n for n in range(256))
        frames = []
        for relative in paths:
            rgba = rgba_frame(relative)
            indexed = rgba.convert('RGB').quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG)
            indexed.frombytes(indexed.tobytes().translate(remap))
            indexed.paste(255, mask=rgba.getchannel('A').point(lambda alpha: 255 if alpha < 96 else 0))
            indexed.info['transparency'] = 255
            frames.append(indexed)
        # GIF timing has 10 ms precision. Alternate 40/50 ms to retain 24 fps timing.
        durations = [round((n + 1) * 100 / 24) * 10 - round(n * 100 / 24) * 10 for n in range(len(frames))]
        options = {'loop': 0} if selection['loop'] else {}
        frames[0].save(DEST / (status + '.gif'), save_all=True, append_images=frames[1:], duration=durations,
                       transparency=255, disposal=2, optimize=False,
                       comment=b'dsh-pet / PC2005-cloud (MIT); frames QCYTSN/dsh-dafeiyu (MIT); see assets/pet', **options)
        rgba_frame(paths[len(paths) // 3]).save(DEST / (status + '.png'), optimize=True)
        gif = (DEST / (status + '.gif')).read_bytes()
        assert len(gif) <= BUDGET, status + ' exceeds animation budget'
        poster = (DEST / (status + '.png')).read_bytes()
        report['states'][status] = {'clip': selection['clip'], 'loop': selection['loop'], 'sourceFrames': len(paths),
            'source': clip['source'], 'gifSha256': digest(gif), 'posterSha256': digest(poster)}
        print('Encoded ' + status, flush=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    verify()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate bundled files without network access')
    args = parser.parse_args()
    verify() if args.check else render()
