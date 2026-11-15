import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
a = np.array(Image.open(p).convert("RGB")).astype(int)
h, w, _ = a.shape

# Downsample to 128x45 grid (10px cells), classify each cell
ch = 10; cw = 10
def classify(cell):
    r,g,b = cell[:,:,0].mean(), cell[:,:,1].mean(), cell[:,:,2].mean()
    lum = (r+g+b)/3
    if r>190 and 120<g<210 and b<90: return 'G'   # gold
    if b>110 and b-r>30 and b-g>20: return 'B'     # blue
    if r>90 and b>90 and r-g>25 and b-g>25: return 'P' # purple
    if g>100 and g-r>30 and g-b>40: return 'g'     # bright green
    if r>140 and g>85 and r-b>50 and g<150: return 's' # skin/brown
    if abs(r-g)<12 and abs(g-b)<12:
        if lum>140: return '#'   # light gray (button/scrollbar)
        if lum>60: return '+'    # mid gray
        if lum>34: return '.'    # dark gray bg 2c2c2c
        if lum>26: return ','    # panel brown 1e1b18 ~ (30,27,24) lum 27
        return ' '               # near black 131313 lum 19
    if g>r and g>b and g>25: return 'v'  # canvas green tint
    if lum>90: return 'W'  # white text
    return '?'

print("Legend: G=gold B=blue P=purple g=green s=skin #=gray-btn +=midgray .=darkgray ,=brown-panel ' '=black v=canvas-green W=white ?=other")
print("     " + "".join(str((x//100)%10) for x in range(0,w,cw)))
for y in range(0, h-ch, ch):
    row = []
    for x in range(0, w-cw+1, cw):
        row.append(classify(a[y:y+ch, x:x+cw]))
    print(f"{y:4d} " + "".join(row))
