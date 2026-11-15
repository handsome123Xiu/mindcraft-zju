import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artsess_nonexistent"
p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
a = np.array(Image.open(p).convert("RGB")).astype(int)
def hexc(c): return "#%02x%02x%02x" % tuple(c)

# 5. Legend dots: region y376-402 x108-400
leg = a[376:402, 108:400]
print("5. legend region color dots:")
for nm, cond in [
    ("blue", (leg[:,:,2]>100)&(leg[:,:,2]-leg[:,:,0]>25)),
    ("brown/skin", (leg[:,:,0]>140)&(leg[:,:,0]-leg[:,:,2]>60)&(leg[:,:,1]>70)),
    ("purple", (leg[:,:,0]>80)&(leg[:,:,2]>80)&(leg[:,:,0]-leg[:,:,1]>20)&(leg[:,:,2]-leg[:,:,1]>20)),
    ("green", (leg[:,:,1]>90)&(leg[:,:,1]-leg[:,:,2]>30)),
    ("gray", (abs(leg[:,:,0]-leg[:,:,1])<10)&(abs(leg[:,:,1]-leg[:,:,2])<10)&(leg[:,:,0]>110)),
    ("gold", (leg[:,:,0]>170)&(leg[:,:,1]>110)&(leg[:,:,2]<100)),
]:
    ys,xs = np.where(cond)
    if len(xs): print(f"   {nm}: n={len(xs)} x{xs.min()+108}-{xs.max()+108} y{ys.min()+376}-{ys.max()+376} sample {hexc(leg[ys[0],xs[0]])}")

# wider legend sweep across whole header of canvas y160-200 & y370-400
for (y0,y1) in [(370,405),(160,200)]:
    leg = a[y0:y1, 100:1000]
    print(f"  sweep y{y0}-{y1}:")
    for nm, cond in [
        ("blue", (leg[:,:,2]>100)&(leg[:,:,2]-leg[:,:,0]>25)),
        ("purple", (leg[:,:,0]>80)&(leg[:,:,2]>80)&(leg[:,:,0]-leg[:,:,1]>20)&(leg[:,:,2]-leg[:,:,1]>20)),
        ("green", (leg[:,:,1]>100)&(leg[:,:,1]-leg[:,:,2]>30)),
        ("gold", (leg[:,:,0]>170)&(leg[:,:,1]>110)&(leg[:,:,2]<100)),
    ]:
        ys,xs = np.where(cond)
        if len(xs)>5: print(f"   {nm}: n={len(xs)} x{xs.min()+100}-{xs.max()+100} y{ys.min()+y0}-{ys.max()+y0}")

# 6. Panel edges
def find_left_edge(y):
    row = a[y]
    for x in range(0, 400):
        c = row[x]
        if abs(int(c[0])-0x13)>6 or abs(int(c[1])-0x13)>6 or abs(int(c[2])-0x13)>6:
            return x, hexc(c)
    return None
def find_right_edge(y):
    row = a[y]
    for x in range(1245, 900, -1):
        c = row[x]
        if abs(int(c[0])-0x13)>6 or abs(int(c[1])-0x13)>6 or abs(int(c[2])-0x13)>6:
            return x, hexc(c)
    return None
print("\n6. edges: header(y20) L:", find_left_edge(20), "R:", find_right_edge(20))
print("   main(y600) L:", find_left_edge(600), "R:", find_right_edge(600))
print("   editbar(y858) L:", find_left_edge(858), "R:", find_right_edge(858))

# 7. Panel TL corner squareness: rows y108-124, cols x70-90
print("\n7. main panel TL corner:")
for y in range(108, 125, 2):
    print(f"   y{y}:", " ".join(hexc(a[y,x])[1:] for x in range(70, 91)))

# 8. Top border thickness at x300
print("\n8. top border rows at x300:", [(y,hexc(a[y,300])) for y in range(106,118)])

# 9. Title shadow
reg = a[6:36, 36:400]
dark = (reg.mean(axis=2)<12)
gmask = (reg[:,:,0]>190)&(reg[:,:,1]>110)&(reg[:,:,2]<90)
ys,xs = np.where(gmask)
cnt=0; tot=0
for dy,dx in [(2,0),(0,2),(2,2),(3,1)]:
    yy,xx = np.clip(ys+dy,0,reg.shape[0]-1), np.clip(xs+dx,0,reg.shape[1]-1)
    cnt += int(dark[yy,xx].sum()); tot += len(yy)
print(f"\n9. gold px={len(xs)}, near-black px adjacent(offset 2): {cnt}")

# 10. MINDCRAFT letter runs
sub = a[6:36, 36:155]
gm = (sub[:,:,0]>170)&(sub[:,:,1]>100)&(sub[:,:,2]<100)
colsum = gm.sum(axis=0); on = colsum>0
runs=[]; inr=False
for x in range(len(on)):
    if on[x] and not inr: s=x; inr=True
    elif not on[x] and inr: runs.append((s,x)); inr=False
if inr: runs.append((s,len(on)))
starts=[r[0]+36 for r in runs]
print("\n10. MINDCRAFT col-runs starts:", starts, "advances:", np.diff(starts).tolist() if len(starts)>1 else None)

# 11. Scrollbar
col = a[120:830, 1176:1186].mean(axis=(1,2))
light = np.where(col>50)[0]
print("\n11. scrollbar lighter rows in x1176-1186:", (int(light.min())+120, int(light.max())+120, len(light)) if len(light) else "NONE")
print("    sample track y400:", hexc(a[400,1178]), hexc(a[400,1182]), " thumb? y200:", hexc(a[200,1178]), hexc(a[200,1182]))

# 12-14 text colors
hb = a[805:825, 100:750]; tp = hb[hb.mean(axis=2)>100]
print("\n12. bottom hint text px:", len(tp), [hexc(c) for c in tp[:6]])
dl = a[164:184, 248:945]; tp = dl[dl.mean(axis=2)>90]
print("13. desc text px:", len(tp), [hexc(c) for c in tp[:6]])
for nm,(x0,x1) in {"控制tab":(34,72),"设置tab":(98,136),"团队协作tab":(452,516)}.items():
    t = a[52:74, x0:x1]; tp = t[t.mean(axis=2)>90]
    print(f"14. {nm} text px:", len(tp), [hexc(c) for c in tp[:4]])
# active tab bg vs inactive
print("    active bg:", hexc(a[63,480]), " inactive bg:", hexc(a[63,115]))

# 16. inspector purple anywhere strong on canvas (excluding lines maybe): recheck with looser threshold
p2 = (a[:,:,0]>70)&(a[:,:,2]>70)&(a[:,:,0]-a[:,:,1]>15)&(a[:,:,2]-a[:,:,1]>15)
ys,xs = np.where(p2)
from collections import Counter
cc = Counter(((x//30)*30,(y//30)*30) for x,y in zip(xs,ys))
print("\n16. loose purple clusters:", [(k,v) for k,v in cc.most_common(8)])

# 17. green button (校验) detail: bevel?
print("\n17. green button slice x1170-1222 y840-882:")
for y in range(840, 884, 3):
    print(f"   y{y}:", " ".join(hexc(a[y,x])[1:] for x in range(1168, 1224, 6)))

# 18. lead node nameplate text (lead label y505-545?) - find white text near x560-690 y505-560
np2 = a[500:560, 540:700]
tp = np2[np2.mean(axis=2)>170]
print("\n18. lead nameplate white px:", len(tp))
if len(tp):
    ys2,xs2 = np.where(np2.mean(axis=2)>170)
    print("    bbox x", xs2.min()+540, xs2.max()+540, "y", ys2.min()+500, ys2.max()+500)

# 19. edge line labels (派单 etc) - white text? sample colors
for (y0,x0,nm) in [(512,430,'派单1'),(683,585,'消层?'),(716,340,'builder1 name')]:
    r = a[y0:y0+22, x0:x0+120]
    tp = r[r.mean(axis=2)>120]
    print(f"19. {nm}: bright px {len(tp)}", [hexc(c) for c in tp[:4]])

# 20. connection line colors: sample the link between lead and builder1: y~560-640 x~380-560
seg = a[555:645, 380:560]
ys,xs = np.where(seg.mean(axis=2)>60)
if len(xs): print("\n20. link bright px sample:", [hexc(seg[y,x]) for y,x in list(zip(ys,xs))[:10]])
