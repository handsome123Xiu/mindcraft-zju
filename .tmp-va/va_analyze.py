import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
im = Image.open(p)
print("size:", im.size, "mode:", im.mode)
im = im.convert("RGB")
a = np.array(im)
h, w, _ = a.shape
print("h,w:", h, w)

def hexc(c): return "#%02x%02x%02x" % tuple(c)

# 1. Overall color census (quantized) - top colors
q = (a // 8 * 8).reshape(-1, 3)
colors, counts = np.unique(q, axis=0, return_counts=True)
order = np.argsort(-counts)
print("\nTop 15 quantized colors:")
for i in order[:15]:
    print(f"  {hexc(colors[i])}  {counts[i]}  {100.0*counts[i]/q.shape[0]:.2f}%")

# 2. Corner / edge samples
print("\nCorners/edges:")
for name, (y, x) in {"TL": (2,2), "TR": (2,w-3), "BL": (h-3,2), "BR": (h-3,w-3), "center": (h//2,w//2)}.items():
    print(f"  {name}: {hexc(a[y,x])}")

# 3. Row profile: mean brightness per row band (32 bands) to find panels
print("\nRow brightness bands (32):")
lum = a.mean(axis=2)
for i in range(32):
    y0, y1 = h*i//32, h*(i+1)//32
    print(f"  y{y0}-{y1}: {lum[y0:y1].mean():6.1f}")

# 4. Column brightness bands
print("\nCol brightness bands (16):")
for i in range(16):
    x0, x1 = w*i//16, w*(i+1)//16
    print(f"  x{x0}-{x1}: {lum[:,x0:x1].mean():6.1f}")
