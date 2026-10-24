#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-1.0.10}"
PKG="vrcx"
FPK_DIR="${ROOT}/fpk"
OUT="${ROOT}/${PKG}_${VERSION}_x86.fpk"

cd "${ROOT}"

# Never ship runtime state with the package.
rm -f "${ROOT}/app/app.sock"
rm -rf "${ROOT}/app/VRCX"
rm -f "${ROOT}/app/bin/node"

# desktop_uidir must live inside app.tgz (the appcenter exposes it as .../ui).
rm -rf "${ROOT}/app/ui"
cp -a "${FPK_DIR}/ui" "${ROOT}/app/ui"

echo "==> packing app.tgz"
rm -f "${FPK_DIR}/app.tgz"
tar -czf "${FPK_DIR}/app.tgz" \
    --exclude='app.sock' \
    --exclude='*.log' \
    --exclude='.DS_Store' \
    -C "${ROOT}/app" .

SUM="$(md5sum "${FPK_DIR}/app.tgz" | awk '{print $1}')"
echo "==> app.tgz md5 ${SUM}"

python3 - "${FPK_DIR}/manifest" "${SUM}" "${VERSION}" <<'PY'
import re, sys
path, checksum, version = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding='utf-8').read()
text = re.sub(r'^version\s*=.*$', f'version               = {version}', text, flags=re.M)
text = re.sub(r'^checksum\s*=.*$', f'checksum              = {checksum}', text, flags=re.M)
open(path, 'w', encoding='utf-8').write(text)
PY

echo "==> building ${OUT}"
rm -f "${OUT}"
cd "${FPK_DIR}"
tar -czf "${OUT}" manifest ICON.PNG ICON_256.PNG cmd config wizard app.tgz

ls -lh "${OUT}"
