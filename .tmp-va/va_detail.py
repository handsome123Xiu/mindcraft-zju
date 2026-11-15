import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
a = np.array(Image.open(p).convert("RGB")).astype(int)
h, w, _ = a.shape
def hexc(c): return "#%02x%02x%02x" % tuple(c)

# 1. Precise grid period: scan row y=790 (likely empty canvas area) x=100..1150
y = 790
row = a[y, 100:1150]
trans = [x+100 for x in range(1, 1050) if abs(row[x]-row[x-1]).sum() > 20]
print(f"Grid transitions at y={y}:", trans[:40])
if len(trans)>1:
    diffs = np.diff(trans)
    print("  diffs:", diffs[:40])

# also vertical period on column
x = 1050
col = a[100:820, x]
trans2 = [yy+100 for yy in range(1, 720) if abs(col[yy]-col[yy-1]).sum() > 20]
print(f"Grid transitions at x={x}:", trans2[:40])
if len(trans2)>1:
    print("  diffs:", list(np.diff(trans2))[:40])

# 2. Gold text pixels: R>190, G in 120..200, B<90
gold = (a[:,:,0]>190) & (a[:,:,1]>120) & (a[:,:,1]<210) & (a[:,:,2]<90)
ys, xs = np.where(gold)
print(f"\nGold pixels: {len(xs)}")
if len(xs):
    # cluster by y bands
    ybands = {}
    for yy in ys: ybands[yy//25] = ybands.get(yy//25,0)+1
    print("  y-band(25px) counts:", {k*25:v for k,v in sorted(ybands.items()) if v>20})

# 3. Blue (Steve) pixels: B>120, B-R>40, B-G>30
blue = (a[:,:,2]>120) & (a[:,:,2]-a[:,:,0]>40) & (a[:,:,2]-a[:,:,1]>30)
ys, xs = np.where(blue)
print(f"\nBlue pixels: {len(xs)}")
if len(xs):
    print("  bbox:", xs.min(), xs.max(), ys.min(), ys.max())
    # clusters roughly
    from collections import Counter
    cc = Counter(( (x//40)*40, (y//40)*40 ) for x,y in zip(xs,ys))
    print("  40px-cell clusters:", [(k,v) for k,v in cc.most_common(12)])

# 4. Purple pixels: R>90, B>90, R-G>30, B-G>30
purple = (a[:,:,0]>90) & (a[:,:,2]>90) & (a[:,:,0]-a[:,:,1]>30) & (a[:,:,2]-a[:,:,1]>30)
ys, xs = np.where(purple)
print(f"\nPurple pixels: {len(xs)}")
if len(xs):
    print("  bbox:", xs.min(), xs.max(), ys.min(), ys.max())
    from collections import Counter
    cc = Counter(( (x//40)*40, (y//40)*40 ) for x,y in zip(xs,ys))
    print("  clusters:", [(k,v) for k,v in cc.most_common(12)])

# 5. Bright green (creeper?) R 60-140, G>110, B<90
bgreen = (a[:,:,0]>50) & (a[:,:,0]<150) & (a[:,:,1]>110) & (a[:,:,2]<90) & (a[:,:,1]-a[:,:,2]>50)
ys, xs = np.where(bgreen)
print(f"\nBright-green pixels: {len(xs)}")
if len(xs):
    from collections import Counter
    cc = Counter(( (x//40)*40, (y//40)*40 ) for x,y in zip(xs,ys))
    print("  clusters:", [(k,v) for k,v in cc.most_common(12)])

# 6. Skin/brown (villager/steve skin): R>150, 90<G<140, 60<B<110, R-B>60
skin = (a[:,:,0]>150) & (a[:,:,1]>85) & (a[:,:,1]<145) & (a[:,:,2]>55) & (a[:,:,2]<115) & (a[:,:,0]-a[:,:,2]>60)
ys, xs = np.where(skin)
print(f"\nSkin-brown pixels: {len(xs)}")
if len(xs):
    from collections import Counter
    cc = Counter(( (x//40)*40, (y//40)*40 ) for x,y in zip(xs,ys))
    print("  clusters:", [(k,v) for k,v in cc.most_common(15)])

# 7. Gray buttons #989898: 140..165 equal channels
gray = (abs(a[:,:,0]-a[:,:,1])<12) & (abs(a[:,:,1]-a[:,:,2])<12) & (a[:,:,0]>140) & (a[:,:,0]<175)
ys, xs = np.where(gray)
print(f"\nButton-gray pixels: {len(xs)}")
if len(xs):
    from collections import Counter
    cc = Counter(( (x//30)*30, (y//30)*30 ) for x,y in zip(xs,ys))
    print("  30px clusters:", [(k,v) for k,v in cc.most_common(15)])
