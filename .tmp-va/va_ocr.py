from rapidocr_onnxruntime import RapidOCR
import numpy as np
from PIL import Image

p = r"C:\Users\Administrator\.zcode\cli\artifacts\sess_8bc49f9f-aee2-4d88-998f-cc6a9cf1a575\call_c745659309c243849b4e4652-tool-result-db90d0d0-e9c0-4511-9aa6-db8dcc22864f.png"
a = np.array(Image.open(p).convert("RGB"))
ocr = RapidOCR()
im2 = Image.fromarray(a).resize((a.shape[1]*2, a.shape[0]*2), Image.LANCZOS)
res, _ = ocr(np.array(im2))
if res:
    for item in res:
        box, text = item[0], item[1]
        conf = item[2] if len(item) > 2 else 0
        xs = [pt[0]/2 for pt in box]; ys = [pt[1]/2 for pt in box]
        try: c = float(conf)
        except: c = -1
        print(f"({min(xs):4.0f},{min(ys):4.0f})-({max(xs):4.0f},{max(ys):4.0f}) conf={c:.2f}  {text}")
else:
    print("no text found")
