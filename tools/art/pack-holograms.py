"""Bake transparent turntables for the runtime and a labeled review animation."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

SOURCES = Path(sys.argv[1])
APP = Path(__file__).resolve().parents[2] / 'web'
ASSETS = APP / 'src' / 'holograms'
BOARDS = APP.parent / 'local-output' / 'previews'
MODELS = [('webb','韦布空间望远镜'), ('rover','毅力号火星车'), ('watch','精密计时腕表'),
          ('helmet','磨损飞行头盔'), ('camera','古典皮腔相机')]
ASSETS.mkdir(exist_ok=True)
BOARDS.mkdir(parents=True, exist_ok=True)
tile, label_height = 248, 36
font = ImageFont.truetype('msyh.ttc',19)
boards = [Image.new('RGB',(tile*3,(tile+label_height)*2),(16,21,28)) for _ in range(64)]
for idx,(key,label) in enumerate(MODELS):
    files = sorted((SOURCES/key).glob('*.png'))
    assert len(files)==64,key
    side=320
    sheet=Image.new('RGBA',(side*8,side*8))
    left=tile*(idx%3)+(tile//2 if idx>=3 else 0)
    top=(idx//3)*(tile+label_height)
    for i,path in enumerate(files):
        with Image.open(path) as src:
            frame=src.convert('RGBA').resize((side,side),Image.Resampling.LANCZOS)
        sheet.paste(frame,(i%8*side,i//8*side))
        sample=frame.resize((tile-12,tile-12),Image.Resampling.LANCZOS)
        boards[i].paste(sample,(left+6,top+6),sample)
        draw=ImageDraw.Draw(boards[i])
        draw.text((left+tile/2,top+tile+2),label,font=font,anchor='mt',fill='#edf2f3')
    sheet.save(ASSETS/(key+'.webp'),quality=90,method=4)
# Use a common palette for stable highlights throughout the loop.
samples=Image.new('RGB',(boards[0].width,boards[0].height*4))
for j in range(4):samples.paste(boards[16*j],(0,j*boards[0].height))
palette=samples.quantize(colors=256)
indexed=[b.quantize(palette=palette,dither=Image.Dither.FLOYDSTEINBERG) for b in boards]
indexed[0].save(BOARDS/'掌上全息-写实科技.gif',save_all=True,append_images=indexed[1:],duration=80,loop=0,optimize=False)
