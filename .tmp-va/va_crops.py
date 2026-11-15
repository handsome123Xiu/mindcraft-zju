import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
a = np.array(Image.open(p).convert("RGB")).astype(int)
def hexc(c): return "#%02x%02x%02x" % tuple(c)

# A. Title area: gold pixels exact colors + shadow
crop = a[8:35, 36:400]
gold = crop[(crop[:,:,0]>190)&(crop[:,:,1]>120)&(crop[:,:,2]<90)]
print("A. Title gold px:", len(gold), "sample:", [hexc(c) for c in gold[:5]])
# shadow: rows just below gold text (y30-36)
sh = a[30:38, 36:400]
print("   below-title colors:", [hexc(c) for c in sh[3, 60:66]])
# status pill right of title (团队运行中) around x298-362 y14-28
st = a[10:32, 290:370]
print("   status area uniq:", [hexc(c) for c in np.unique(st.reshape(-1,3), axis=0)[:8]])

# B. Button 1 "保存并开始新测试" ~x90-240 y295-330. Print pixel rows across
print("\nB. Button1 vertical slice at x=150, y292..334:")
for y in range(292, 335, 2):
    print(f"   y={y}: {hexc(a[y,150])}  x=95:{hexc(a[y,95])} x=235:{hexc(a[y,235])}")
print("   Button1 horizontal slice y=312, x88..244 step4:")
print("   ", [hexc(a[312,x]) for x in range(88, 246, 4)])
# corner of button
print("   Button1 TL corner grid (y293-300, x90-97):")
for y in range(293, 301):
    print("     ", " ".join(hexc(a[y,x])[1:] for x in range(90, 98)))

# C. Canvas grid precise period, row y=770 x=200..1100 (threshold small)
row = a[770, 200:1100]
tr = [x+200 for x in range(1, 900) if abs(row[x]-row[x-1]).sum() > 8]
print("\nC. Grid transitions y=770:", tr[:30], "diffs:", list(np.diff(tr))[:30] if len(tr)>1 else None)
row = a[700, 300:700]
tr = [x+300 for x in range(1, 400) if abs(row[x]-row[x-1]).sum() > 8]
print("   transitions y=700:", tr[:30], "diffs:", list(np.diff(tr))[:30] if len(tr)>1 else None)
print("   y770 colors:", [hexc(a[770,x]) for x in range(300, 380, 8)])

# D. Lead node: find blue bbox tight in region x560-690 y420-560
reg = a[420:560, 560:690]
bl = (reg[:,:,2]>100)&(reg[:,:,2]-reg[:,:,0]>30)&(reg[:,:,2]-reg[:,:,1]>20)
ys,xs = np.where(bl)
print("\nD. lead-node blue bbox in (560-690,420-560):", (xs.min()+560,xs.max()+560,ys.min()+420,ys.max()+420) if len(xs) else None, "n=",len(xs))
# wider: full lead node region incl nameplate  x560-680 y500-560 - nameplate colors
np_region = a[505:545, 560:680]
print("   nameplate uniq colors:", [hexc(c) for c in np.unique(np_region.reshape(-1,3), axis=0)[:10]])

# E/F. builder nodes
for name, (x0,x1,y0,y1) in {"builder1": (320,430,630,760), "builder2": (780,890,630,760)}.items():
    reg = a[y0:y1, x0:x1]
    sk = (reg[:,:,0]>140)&(reg[:,:,1]>80)&(reg[:,:,0]-reg[:,:,2]>60)
    ys,xs = np.where(sk)
    print(f"\n{name} skin bbox: x{xs.min()+x0}-{xs.max()+x0} y{ys.min()+y0}-{ys.max()+y0} n={len(xs)}")

# G. Bottom edit bar: find exact bounds of green button & inputs at y838-878
reg = a[835:880, 1100:1265]
grn = (reg[:,:,1]>100)&(reg[:,:,1]-reg[:,:,2]>40)&(reg[:,:,1]-reg[:,:,0]>20)
ys,xs = np.where(grn)
print("\nG. green button bbox:", (xs.min()+1100,xs.max()+1100,ys.min()+835,ys.max()+835) if len(xs) else None)
# where is panel right border? scan y=855 x1150..1265
print("   y=855 scan:", {x: hexc(a[855,x]) for x in range(1150, 1266, 10)})
# label colors at y855-865: sample text pixels
lab = a[850:870, 96:346]
tw = lab[lab.mean(axis=2)>150]
print("   edit-label bright px:", len(tw), [hexc(c) for c in tw[:6]])
# input box borders in edit bar: scan y=858 x80..1160 for border transitions
row = a[858, 80:1190]
tr = [x+80 for x in range(1, 1110) if abs(row[x]-row[x-1]).sum() > 30]
print("   edit-bar y858 borders at x:", tr)

# H. Legend text color
leg = a[380:400, 120:400]
tw = leg[leg.mean(axis=2)>140]
print("\nH. legend bright px:", len(tw), [hexc(c) for c in tw[:8]])

# I. Hint text y344-362 color
hint = a[342:364, 96:660]
tw = hint[hint.mean(axis=2)>110]
print("I. hint bright px:", len(tw), [hexc(c) for c in tw[:8]])
gd = hint[(hint[:,:,0]>170)&(hint[:,:,1]>110)&(hint[:,:,2]<100)]
print("   hint gold-ish px:", len(gd))

# K. Tab active bg color (团队协作 x454-514 y53-72)
tab = a[55:72, 456:512]
print("\nK. active tab colors:", [hexc(c) for c in np.unique(tab.reshape(-1,3), axis=0)[:6]])

# L. Panel border: scan y=600 x70..92 and x1160..1200
print("\nL. left border scan y600:", {x: hexc(a[600,x]) for x in range(70, 93, 2)})
print("   right border scan y600:", {x: hexc(a[600,x]) for x in range(1158, 1200, 2)})
print("   top border scan x600:", {y: hexc(a[y,600]) for y in range(0, 14, 2)})
