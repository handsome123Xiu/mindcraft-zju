import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
a = np.array(Image.open(p).convert("RGB")).astype(int)
h, w, _ = a.shape
lum = a.mean(axis=2)
gy = np.abs(np.diff(lum, axis=0)).mean(axis=1)  # horizontal edge strength per row
gx = np.abs(np.diff(lum, axis=1)).mean(axis=0)  # vertical edge strength per col

print("Strong horizontal edges (rows where gy>3):")
runs=[]
inr=False
for y in range(len(gy)):
    if gy[y]>3 and not inr: start=y; inr=True
    elif gy[y]<=3 and inr: runs.append((start,y)); inr=False
if inr: runs.append((start,len(gy)))
for s,e in runs: print(f"  y {s}-{e}  peak {gy[s:e].max():.1f}")

print("\nStrong vertical edges (cols where gx>3):")
runs=[]
inr=False
for x in range(len(gx)):
    if gx[x]>3 and not inr: start=x; inr=True
    elif gx[x]<=3 and inr: runs.append((start,x)); inr=False
if inr: runs.append((start,len(gx)))
for s,e in runs: print(f"  x {s}-{e}  peak {gx[s:e].max():.1f}")

# bottom bright band inspection
print("\nBottom band rows mean color:")
for y in [868, 872, 876, 880, 885, 890, 895, 898]:
    row = a[y]
    print(f"  y={y}: mean {row.mean(axis=0).astype(int)} lum {lum[y].mean():.0f} uniq {len(np.unique(row//16,axis=0))}")

# what is at very bottom - taskbar? sample colors
print("\nBottom-left/mid/right colors y=890:")
for x in [10, 200, 640, 1000, 1270]:
    print(f"  ({890},{x}): #%02x%02x%02x" % tuple(a[890,x]))
