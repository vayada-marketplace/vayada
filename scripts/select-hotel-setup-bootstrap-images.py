#!/usr/bin/env python3
"""Select only reviewed fixed-repository image inputs; no credential access."""
import hashlib
import json
import os
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
repository = '269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api'
inventory = json.loads((root / 'engineering/hotel-setup-bootstrap-images.json').read_text())
pair = inventory.get(os.environ.get('REVIEWED_PAIR', ''))
if not isinstance(pair, dict) or set(pair) != {'primary', 'rollback'}:
    raise SystemExit('Pair has no reviewed dual-image native credential proof')
manifest = {}
for mode in ('primary', 'rollback'):
    entry = pair[mode]
    if not isinstance(entry, dict) or set(entry) != {'digest', 'source'}:
        raise SystemExit('Invalid reviewed image entry')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', entry['digest']) or not re.fullmatch(r'[a-f0-9]{40}', entry['source']):
        raise SystemExit('Invalid immutable digest or source')
    manifest[mode] = {'image': repository + '@' + entry['digest'], 'source': entry['source']}
document = json.dumps(manifest, sort_keys=True, indent=2) + '\n'
(root / 'engineering/hotel-setup-bootstrap-image-manifest.json').write_text(document)
with open(os.environ['GITHUB_ENV'], 'a') as output:
    for mode in ('primary', 'rollback'):
        output.write('BOOTSTRAP_' + mode.upper() + '_IMAGE=' + manifest[mode]['image'] + '\n')
    output.write('BOOTSTRAP_PAIR_HASH=' + hashlib.sha256(document.encode()).hexdigest()[:16] + '\n')
