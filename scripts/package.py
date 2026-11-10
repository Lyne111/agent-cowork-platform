"""Build a source + frontend delivery ZIP; never include credentials or user data."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent.parent
output = root / 'artifacts'
output.mkdir(exist_ok=True)
target = output / 'agent-cowork-platform-v0.1-dev.zip'
roots = ['apps', 'packages', 'scripts', 'docs', 'tests', '.github']
files = ['README.md', 'CONTRIBUTING.md', 'LICENSE', 'package.json', 'package-lock.json',
         'tsconfig.json', '.gitignore', '.node-version', 'start.ps1', 'install.cmd']
excluded = {'node_modules', '.git', '.local-data', '__pycache__', 'coverage'}
candidates = [root / p for p in files]
for name in roots:
    directory = root / name
    if directory.exists():
        candidates.extend(p for p in directory.rglob('*') if p.is_file())
if not (root / 'apps/web/dist/index.html').is_file():
    raise SystemExit('Build the frontend with npm run build before packaging.')
manifest = []
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(set(candidates)):
        relative = path.relative_to(root)
        if (not path.is_file() or path.is_symlink() or excluded.intersection(relative.parts)
                or path.name.startswith('.env') or path.suffix in {'.log', '.sqlite', '.db'}):
            continue
        body = path.read_bytes()
        if path.suffix == '.cmd':
            body = body.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
        archive.writestr(relative.as_posix(), body)
        manifest.append({'path': relative.as_posix(), 'sha256': hashlib.sha256(body).hexdigest()})
    archive.writestr('DELIVERY-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2))
digest = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix('.zip.sha256').write_text(f'{digest}  {target.name}\n')
print(f'{target}\n{len(manifest)} files\nSHA256 {digest}')
