// ---------------------------------------------------------------------------
// Dola Toolkit — app icon generator (from the user-supplied ico.jpg)
// Produces:
//   build/icon.png                     1024 rounded-square RGBA (electron)
//   build/icon.ico                     multi-resolution 256,128,64,48,32,24,16
//   src/renderer/src/assets/logo.png   256px transparent-corner rail logo
//   src/renderer/src/assets/logo-64.png 64px in-app asset
// Uses the bundled Pillow (python) for Lanczos resampling.
// Run: node scripts/gen-icon.mjs   (requires DOLA_PYTHON)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = process.env.DOLA_ICON_SRC || 'D:\\桌面\\server\\tool\\ico.jpg'

const PY = process.env.DOLA_PYTHON
if (!PY) {
  console.error('DOLA_PYTHON is not set — pass the bundled python executable in the env.')
  process.exit(1)
}
if (!existsSync(SRC)) {
  console.error(`source icon not found: ${SRC}`)
  process.exit(1)
}

for (const d of ['build', join('src', 'renderer', 'src', 'assets')]) {
  mkdirSync(join(ROOT, d), { recursive: true })
}

const script = String.raw`
import sys
from PIL import Image, ImageDraw, ImageFilter

src, root = sys.argv[1], sys.argv[2]

im = Image.open(src).convert("RGBA")

# ---- centre-crop to a square ------------------------------------------------
w, h = im.size
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
top = max(0, top - int(side * 0.02))
im = im.crop((left, top, left + side, top + side))

BASE = 1024
im = im.resize((BASE, BASE), Image.LANCZOS)

def rounded_mask(size, radius_ratio=0.2237, ss=4):
    big = size * ss
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    r = int(big * radius_ratio)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=r, fill=255)
    return m.resize((size, size), Image.LANCZOS)

mask = rounded_mask(BASE)
out = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
out.paste(im, (0, 0), mask)

# subtle inner highlight for a "material" feel
hl = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
hd = ImageDraw.Draw(hl)
hd.rounded_rectangle((0, 0, BASE - 1, BASE - 1), radius=int(BASE * 0.2237),
                     outline=(255, 255, 255, 46), width=max(2, BASE // 256))
hl = hl.filter(ImageFilter.GaussianBlur(max(1, BASE // 512)))
tmp = Image.alpha_composite(out, hl)
out = Image.composite(tmp, Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0)), mask)

out.save(root + "/build/icon.png", "PNG")
out.resize((256, 256), Image.LANCZOS).save(root + "/src/renderer/src/assets/logo.png", "PNG")
out.resize((64, 64), Image.LANCZOS).save(root + "/src/renderer/src/assets/logo-64.png", "PNG")

# Multi-resolution .ico: Pillow keeps every frame when built from a list of
# per-size images. The 256x256 frame MUST be present (electron-builder rejects
# icons whose largest frame is smaller than 256).
sizes = [256, 128, 64, 48, 32, 24, 16]
frames = [out.resize((s, s), Image.LANCZOS) for s in sizes]
frames[0].save(root + "/build/icon.ico", format="ICO",
               sizes=[(s, s) for s in sizes], append_images=frames[1:])

check = Image.open(root + "/build/icon.ico")
print("ico frames:", sorted(check.info.get("sizes", [])))
`

execFileSync(PY, ['-c', script, SRC, ROOT], { stdio: 'inherit' })
console.log('icon generated from', SRC)
