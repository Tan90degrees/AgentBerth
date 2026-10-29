"""Pack the pinned MIT DSH character frames into offline animations and static posters.

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
        data = (DEST / (status + '.webp')).read_bytes()
        assert len(data) <= 4 * 1024 * 1024 and digest(data) == record['animationSha256']
        with Image.open(BytesIO(data)) as image:
            assert image.size == tuple(config['canvas'])
            assert image.n_frames >= 24, (status, image.n_frames)
            assert image.info.get('loop') == (0 if selection['loop'] else 1)
            alpha = image.convert('RGBA').getpixel((0, 0))[3]
            print(status + ': alpha=' + str(alpha) + ', extrema=' + str(image.convert('RGBA').getchannel('A').getextrema()), flush=True)
            assert alpha == 0, (status, alpha)
            total = 0
            for n in range(image.n_frames):
                image.seek(n)
                image.load()
                total += image.info['duration']
            assert abs(total - record['sourceFrames'] * 1000 / 24) <= 2
        poster = (DEST / (status + '.png')).read_bytes()
        assert digest(poster) == record['posterSha256']
        with Image.open(BytesIO(poster)) as image:
            assert image.size == tuple(config['canvas'])
            assert image.mode == 'RGBA'
        print(status + ': ' + str(record['sourceFrames']) + ' frames, ' + str(len(data)) + ' bytes', flush=True)
    assert (ROOT / 'assets/pet/LICENSE-PC2005-cloud.txt').is_file()
    assert (ROOT / 'assets/pet/LICENSE-QCYTSN.txt').is_file()
    for name in ['working', 'completed']:
        with Image.open(ROOT / 'tests/fixtures' / ('pet-' + name + '.gif')) as image:
            assert image.is_animated


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
        # Source matting leaves alpha=1 noise in otherwise empty canvas corners.
        # Remove only imperceptible alpha noise, preserving soft character edges.
        cutoff = config['encoder']['alphaCutoff']
        frame.putalpha(frame.getchannel('A').point(lambda value: 0 if value <= cutoff else value))
        return frame

    report = {'version': 1, 'format': 'animated-webp', 'importRepository': config['repository'], 'importCommit': config['commit'],
              'originalSource': manifest['assetSource'], 'sourceFps': config['fps'], 'canvas': config['canvas'], 'encoder': config['encoder'], 'states': {}}
    for status, selection in config['states'].items():
        clip = manifest['clips'][selection['clip']]
        frames = [rgba_frame(relative) for relative in clip['frames']]
        durations = [round((n + 1) * 1000 / 24) - round(n * 1000 / 24) for n in range(len(frames))]
        encoder = config['encoder']
        # Animated WebP keeps soft alpha edges and full colour, with a much smaller payload than GIF.
        frames[0].save(DEST / (status + '.webp'), format='WEBP', save_all=True, append_images=frames[1:],
                       duration=durations, loop=0 if selection['loop'] else 1,
                       quality=encoder['quality'], method=encoder['method'], minimize_size=encoder['minimizeSize'],
                       allow_mixed=encoder['allowMixed'], background=tuple(encoder['background']))
        frames[len(frames) // 3].save(DEST / (status + '.png'), optimize=True)
        data = (DEST / (status + '.webp')).read_bytes()
        assert len(data) <= 4 * 1024 * 1024, status + ' exceeds animation budget'
        poster = (DEST / (status + '.png')).read_bytes()
        report['states'][status] = {'clip': selection['clip'], 'loop': selection['loop'], 'sourceFrames': len(frames),
            'source': clip['source'], 'animationSha256': digest(data), 'posterSha256': digest(poster)}
        if status in ['working', 'completed']:
            # Small animated GIFs exercise the separate custom-GIF import path without shipping duplicate defaults.
            fixture = []
            for rgba in frames[:12]:
                image = rgba.convert('RGB').quantize(colors=255)
                image.paste(255, mask=rgba.getchannel('A').point(lambda a: 255 if a < 96 else 0))
                fixture.append(image)
            target = ROOT / 'tests/fixtures' / ('pet-' + status + '.gif')
            fixture[0].save(target, save_all=True, append_images=fixture[1:],
                            duration=[round((n + 1) * 100 / 24) * 10 - round(n * 100 / 24) * 10 for n in range(12)],
                            loop=0, transparency=255, disposal=2, optimize=False)
        (DEST / (status + '.gif')).unlink(missing_ok=True)
        print('Encoded ' + status, flush=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    verify()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate bundled files without network access')
    args = parser.parse_args()
    verify() if args.check else render()
