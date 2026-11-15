import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
a = np.array(Image.open(p).convert("RGB")).astype(int)
h, w, _ = a.shape

def hexc(c): return "#%02x%02x%02x" % tuple(c)

# --- Right scrollbar analysis ---
print("Right edge column colors (x=1170..1279 sample at y=400):")
for x in range(1150, 1280, 8):
    print(f"  x={x}: {hexc(a[400,x])}  {hexc(a[450,x])}")
# vertical scrollbar thumb: find rows where x=1240 is light
col = a[:, 1240].mean(axis=1)
light_rows = np.where(col > 80)[0]
print("\nx=1240 light rows range:", (light_rows.min(), light_rows.max()) if len(light_rows) else None, "count:", len(light_rows))
# thumb vs track
runs=[]
inr=False
for i in range(h):
    if col[i]>80 and not inr: s=i; inr=True
    elif col[i]<=80 and inr: runs.append((s,i)); inr=False
if inr: runs.append((s,h))
print("thumb runs at x=1240:", runs[:10])

# --- Bottom scrollbar analysis ---
row = a[890].mean(axis=1)
light_cols = np.where(row > 80)[0]
runs=[]
inr=False
for i in range(w):
    if row[i]>80 and not inr: s=i; inr=True
    elif row[i]<=80 and inr: runs.append((s,i)); inr=False
if inr: runs.append((s,w))
print("\nbottom scrollbar thumb runs at y=890:", runs)

# --- Where does main app end? Check x=0..1160 column structure at a few rows inside canvas ---
print("\nRow y=600 colors across width (every 40px):")
for x in range(0, w, 40):
    print(f"  x={x}: {hexc(a[600,x])}")

# --- Background color around panels: sample points likely outside panels ---
print("\nSample points (y,x):")
for (y,x) in [(30,30),(30,1200),(120,600),(400,50),(800,600),(860,1200),(100,1150)]:
    print(f"  ({y},{x}): {hexc(a[y,x])}")
