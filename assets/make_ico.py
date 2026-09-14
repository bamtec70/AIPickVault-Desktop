from PIL import Image
from pathlib import Path
src = Path(r"C:\Users\bamte\OneDrive\Desktop\AIPickVault-Desktop\assets\aipickvault-desktop-icon.png")
img = Image.open(src).convert("RGBA")
bbox = img.getbbox()
if bbox:
    img = img.crop(bbox)
w, h = img.size
side = max(w, h)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
sizes = [(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]
out = Path(r"C:\Users\bamte\OneDrive\Desktop\AIPickVault-Desktop\assets\aipickvault-desktop.ico")
base = canvas.resize((256,256), Image.Resampling.LANCZOS)
base.save(out, format="ICO", sizes=[(s[0], s[1]) for s in sizes])
canvas.resize((512,512), Image.Resampling.LANCZOS).save(src.parent / "icon-512.png")
print("ico", out, out.stat().st_size)
