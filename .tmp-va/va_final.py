import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
a = np.array(Image.open(p).convert("RGB")).astype(int)
def hexc(c): return "#%02x%02x%02x" % tuple(c)

# 1. Other buttons: 恢复旧工程 (x262-360 y296-332), 停止团队 (x390-462)
for nm,(x0,x1) in {"恢复旧工程":(262,362),"停止团队":(390,462)}.items():
    c = a[305:325, x0:x1]
    print(f"1. {nm} fill sample:", hexc(c[5, (x1-x0)//2 - x0 + x0]), [hexc(c[2,k]) for k in [5,(x1-x0)//2]], "bottom:", [hexc(c[-3,k]) for k in [5,(x1-x0)//2]])
    mid = a[315, x0:x1]
    print("   y315 row:", [hexc(v) for v in mid[::8]])

# 2. Lead node face dump: find tight face bbox first (blue) y420-505
reg = a[420:505, 540:680]
bl = (reg[:,:,2]>100)&(reg[:,:,2]-reg[:,:,0]>25)&(reg[:,:,2]-reg[:,:,1]>15)
ys,xs = np.where(bl)
x0,x1,y0,y1 = xs.min()+540, xs.max()+540, ys.min()+420, ys.max()+420
print(f"\n2. lead face bbox: x{x0}-{x1} y{y0}-{y1} ({x1-x0+1}x{y1-y0+1})")
# print block map: sample each pixel block of (w/8)
fw,fh = x1-x0+1, y1-y0+1
bs = fw/8.0
print("   lead face 8x8 block classes (B=blue D=dark W=white/light G=greenish .=bg):")
for by in range(8):
    line=""
    for bx in range(8):
        cell = a[int(y0+by*fh/8):int(y0+(by+1)*fh/8), int(x0+bx*fw/8):int(x0+(bx+1)*fw/8)]
        r,g,b = cell[:,:,0].mean(), cell[:,:,1].mean(), cell[:,:,2].mean()
        if b>100 and b-r>25: line+="B"
        elif r>200 and g>200 and b>200: line+="W"
        elif r>140 and g>90 and r-b>60: line+="s"
        elif r<40 and g<40 and b<40: line+="D"
        elif g>r and b<r: line+="G"
        else: line+="?"
    print("     ",line)

# 3. Builder1 face dump
reg = a[640:715, 340:430]
sk = (reg[:,:,0]>140)&(reg[:,:,1]>80)&(reg[:,:,0]-reg[:,:,2]>60)
ys,xs = np.where(sk)
x0,x1,y0,y1 = xs.min()+340, xs.max()+340, ys.min()+640, ys.max()+640
print(f"\n3. builder1 face bbox: x{x0}-{x1} y{y0}-{y1} ({x1-x0+1}x{y1-y0+1})")
fw,fh = x1-x0+1, y1-y0+1
print("   builder1 8x8 blocks (s=skin D=dark W=light B=blue):")
for by in range(8):
    line=""
    for bx in range(8):
        cell = a[int(y0+by*fh/8):int(y0+(by+1)*fh/8), int(x0+bx*fw/8):int(x0+(bx+1)*fw/8)]
        r,g,b = cell[:,:,0].mean(), cell[:,:,1].mean(), cell[:,:,2].mean()
        if b>100 and b-r>25: line+="B"
        elif r>200 and g>200 and b>200: line+="W"
        elif r>140 and g>80 and r-b>60: line+="s"
        elif r<45 and g<45 and b<45: line+="D"
        else: line+="?"
    print("     ",line)

# block size check: internal hard edges within face (pixelation)
rowface = a[(y0+y1)//2, x0:x1+1]
tr = [i for i in range(1,len(rowface)) if abs(rowface[i]-rowface[i-1]).sum()>30]
print("   builder1 face row hard transitions offsets:", tr, "->block size ~", np.diff(tr).tolist()[:10] if len(tr)>1 else None)

# 4. Nameplate: builder1 (x346-418 y714-750)
npreg = a[712:752, 340:425]
print("\n4. nameplate builder1 uniq:", [hexc(c) for c in np.unique(npreg.reshape(-1,3),axis=0)[:8]])
# text pixels (white-ish)
tp = npreg[npreg.mean(axis=2)>170]
print("   white text px:", len(tp), [hexc(c) for c in tp[:4]])
# bg between text
bg = npreg[(npreg.mean(axis=2)<60)]
print("   dark bg px:", len(bg), "mean:", bg.mean(axis=0).astype(int) if len(bg) else None)

# 5. Legend dots: region y378-400 x108-400 - find colored dots
leg = a[376:402, 108:400]
print("\n5. legend region color dots:")
for cls,nm,cond in [
    ("blue", (leg[:,:,2]>100)&(leg[:,:,2]-leg[:,:,0]>25)),
    ("brown/skin", (leg[:,:,0]>140)&(leg[:,:,0]-leg[:,:,2]>60)&(leg[:,:,1]>70)),
    ("purple", (leg[:,:,0]>80)&(leg[:,:,2]>80)&(leg[:,:,0]-leg[:,:,1]>20)&(leg[:,:,2]-leg[:,:,1]>20)),
    ("green", (leg[:,:,1]>90)&(leg[:,:,1]-leg[:,:,2]>30)),
    ("gray", (abs(leg[:,:,0]-leg[:,:,1])<10)&(abs(leg[:,:,1]-leg[:,:,2])<10)&(leg[:,:,0]>110)),
]:
    ys,xs = np.where(cond)
    if len(xs): print(f"   {nm}: n={len(xs)} at x{xs.min()+108}-{xs.max()+108} y{ys.min()+376}-{ys.max()+376} sample {hexc(leg[ys[0],xs[0]])}")

# 6. Edit panel bounds vs main panel
def find_right_edge(y):
    row = a[y]
    for x in range(1265, 900, -1):
        if not (abs(row[x][0]-19)<8 and abs(row[x][1]-19)<8 and abs(row[x][2]-19)<8):
            continue
    # find last non-#131313 before x1262 scanning leftward: first x from right where color != 131313
    for x in range(1240, 900, -1):
        c = row[x]
        if abs(int(c[0])-0x13)>6 or abs(int(c[1])-0x13)>6 or abs(int(c[2])-0x13)>6:
            return x, hexc(c)
    return None
def find_left_edge(y):
    row = a[y]
    for x in range(0, 400):
        c = row[x]
        if abs(int(c[0])-0x13)>6 or abs(int(c[1])-0x13)>6 or abs(int(c[2])-0x13)>6:
            return x, hexc(c)
    return None
print("\n6. panel edges: main(y600) L:", find_left_edge(600), "R:", find_right_edge(600))
print("   edit bar(y858) L:", find_left_edge(858), "R:", find_right_edge(858))
print("   edit bar(y844) L:", find_left_edge(844), "R:", find_right_edge(844))
print("   header(y20) L:", find_left_edge(20), "R:", find_right_edge(20))
print("   main top? col x600 first non-131313 from top:", next((y for y in range(0,60) if abs(a[y,600][0]-0x13)>6), 0))

# 7. Panel TL corner squareness: y110-125, x72-95 grid
print("\n7. main panel TL corner (rows y110-124, cols x74-88):")
for y in range(110, 125, 2):
    print("   ", " ".join(hexc(a[y,x])[1:] for x in range(74, 89)))

# 8. Border thickness vertical at y600 x1150..1200 already seen; top border at x300 y108-118
print("\n8. top border rows at x300:", [(y,hexc(a[y,300])) for y in range(108,120)])

# 9. Title shadow: check for very dark px adjacent to gold glyphs y8-32
reg = a[6:36, 36:400]
dark = (reg.mean(axis=2)<10)
print("\n9. near-black shadow px in title area:", int(dark.sum()))
# offset check: gold col x, dark at x+2/y+2?
gmask = (reg[:,:,0]>190)&(reg[:,:,1]>110)&(reg[:,:,2]<90)
ys,xs = np.where(gmask)
if len(xs):
    cnt=0
    for dy,dx in [(2,0),(0,2),(2,2),(3,0)]:
        yy,xx = ys+dy, xs+dx
        m = (yy<reg.shape[0])&(xx<reg.shape[1])
        cnt += int(dark[yy[m],xx[m]].sum())
    print("   dark px offset from gold:", cnt)

# 10. Title char advance: gold columns histogram in MINDCRAFT x36-150
sub = a[6:36, 36:155]
gm = (sub[:,:,0]>170)&(sub[:,:,1]>100)&(sub[:,:,2]<100)
colsum = gm.sum(axis=0)
on = colsum>0
# find runs of on-columns (letters)
runs=[]; inr=False
for x in range(len(on)):
    if on[x] and not inr: s=x; inr=True
    elif not on[x] and inr: runs.append((s,x)); inr=False
if inr: runs.append((s,len(on)))
print("\n10. MINDCRAFT letter col-runs (x offsets):", [r[0]+36 for r in runs])
print("    advances:", np.diff([r[0]+36 for r in runs]).tolist())

# 11. Canvas scrollbar thumb: column x1178, y120-830
col = a[120:830, 1176:1186].mean(axis=(1,2))
light = np.where(col>50)[0]
print("\n11. scrollbar track x1176-1186: rows lighter than 50:", (light.min()+120, light.max()+120, len(light)) if len(light) else "NONE - no thumb?")
print("    track color sample:", hexc(a[400,1180]), "vs panel", hexc(a[300,1100]))

# 12. bottom hints text color y805-825
hb = a[805:825, 100:750]
tp = hb[hb.mean(axis=2)>100]
print("\n12. bottom-hint text px:", len(tp), [hexc(c) for c in tp[:6]])

# 13. desc line (y166-181) text color and right extent
dl = a[164:184, 248:945]
tp = dl[dl.mean(axis=2)>90]
print("13. desc text px:", len(tp), [hexc(c) for c in tp[:6]])

# 14. tabs text colors
for nm,(x0,x1) in {"控制":(34,72),"设置":(98,136),"团队协作":(452,516)}.items():
    t = a[52:74, x0:x1]
    tp = t[t.mean(axis=2)>90]
    print(f"14. tab {nm} text px:", len(tp), [hexc(c) for c in tp[:4]])

# 15. purple dot in legend? already checked. Inspector presence overall:
print("15. purple summary above.")
