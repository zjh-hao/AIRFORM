from functools import lru_cache
from math import cos, pi, sin
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[2] / 'web'
WIDTH, HEIGHT, SCALE = 336, 276, 2
TAU = 2 * pi
PAPER = '#e6eceb'
LIME = '#d4f34c'
FONT = Path('C:/Windows/Fonts')
PALETTES = [(114, 228, 255), (172, 146, 255), (255, 167, 70)]
PLANETS = [(160, 149, 132), (222, 177, 119), (75, 158, 207), (196, 110, 71),
           (209, 169, 133), (216, 195, 149), (127, 208, 213), (94, 131, 217)]
TITLES = [('离子流', '极光绸带', '熔金星屑'), ('黄铜天球仪', '袖珍天文馆', '全息星图')]
NAMES = [('ION STREAM', 'AURORA SILK', 'EMBER DUST'), ('BRASS ORRERY', 'POCKET COSMOS', 'HOLO ATLAS')]


def point(xy):
    return tuple(round(value * SCALE) for value in xy)


def line(draw, coords, color, width=1):
    draw.line([point(coord) for coord in coords], fill=color, width=max(1, round(width*SCALE)), joint='curve')


def dot(draw, x, y, radius, color):
    draw.ellipse(point((x-radius, y-radius))+point((x+radius, y+radius)), fill=color)


@lru_cache(None)
def font(name, size):
    return ImageFont.truetype(str(FONT/name), size*SCALE)


def label(draw, xy, text, color, size=10, face='consola.ttf'):
    draw.text(point(xy), text, font=font(face, size), fill=color, anchor='lt')


@lru_cache(None)
def backdrop(group, style):
    canvas = Image.new('RGB', point((WIDTH, HEIGHT)), '#10191f')
    draw = ImageDraw.Draw(canvas)
    for row in range(HEIGHT):
        strength = sin(pi*row/HEIGHT)
        line(draw, [(0,row),(WIDTH,row)], (round(13+6*strength),round(21+10*strength),round(27+12*strength)))
    rng = np.random.default_rng(291)
    for col in range(15, WIDTH, 16):
        for row in range(66, HEIGHT-27, 16):
            dot(draw, col,row,.42,'#465454')
    for xpos,ypos,brightness in rng.random((34,3)):
        dot(draw, 14+xpos*(WIDTH-28), 66+ypos*146, .35+brightness*.42, '#566266')
    label(draw,(16,12),f'FX / {group+1:02d}     STUDY {"ABC"[style]}',LIME)
    label(draw,(16,30),TITLES[group][style],PAPER,20,'msyhbd.ttc')
    line(draw,[(16,59),(WIDTH-16,59)],'#49545a',.6)
    line(draw,[(16,HEIGHT-25),(WIDTH-16,HEIGHT-25)],'#49545a',.6)
    label(draw,(16,HEIGHT-17),NAMES[group][style],'#acbfbd',9)
    label(draw,(WIDTH-74,HEIGHT-17),'KINElab / 03','#879697',8)
    return canvas


def comet_point(turn):
    angle = turn*TAU
    return 169+106*sin(angle)+17*sin(2*angle+.4), 150-38*sin(2*angle-.55)-11*cos(angle)


def comet(style, turn):
    canvas = backdrop(0,style).copy()
    trail = Image.new('RGB',canvas.size)
    draw = ImageDraw.Draw(trail)
    colors = PALETTES[style]
    extent = [.225,.34,.29][style]
    guide = ImageDraw.Draw(canvas)
    for sample in range(104):
        dot(guide,*comet_point(sample/104),.56,'#5a6a6e')
    previous = {}
    for idx in range(85):
        age = 1-idx/84
        pos = turn-age*extent
        x,y = comet_point(pos)
        ahead = comet_point(pos+.001)
        tangent = np.array([ahead[0]-x, ahead[1]-y]); tangent /= max(.01,np.linalg.norm(tangent))
        normal = np.array([-tangent[1],tangent[0]])
        power = (1-age)**.8
        for strand in range([3,10,1][style]):
            spread = (1 if style!=1 else 11)*sin(age*pi)**.7
            offset = spread*(sin(9*age+TAU*strand/10+TAU*turn*2) if style==1 else strand-1)
            xy = (x+offset*normal[0],y+offset*normal[1])
            shade = np.array(colors) if style!=1 else np.array([110+110*strand/9,221-105*strand/9,250])
            if strand in previous:
                line(draw,[previous[strand],xy],tuple((shade*power).astype(int)),(1.2 if style==1 else 1.8)+.8*power)
            previous[strand]=xy
    for idx in range(90 if style==2 else 27):
        age = ((idx*.61803399+turn*2)%1)
        x,y = comet_point(turn-age*extent)
        x += age*(sin(idx*2.77+turn*TAU)*20 if style==2 else sin(idx)*5)
        y += age*(cos(idx*4.21+turn*TAU)*18 if style==2 else cos(idx)*5)
        power = (1-age)**.65
        tint = tuple(int(value*(.22+.78*power)) for value in colors)
        if style==2:
            length = .6+2.2*power
            draw.polygon([point((x-length,y)),point((x+.3,y-length*.55)),point((x+length,y+.45))],fill=tint)
        else: dot(draw,x,y,.5+power*.7,tint)
    x,y=comet_point(turn)
    dot(draw,x,y,3.6,colors);dot(draw,x,y,1.8,'#ffffff')
    if style==0:
        line(draw,[(x-6,y),(x+6,y)],'#d7f8ff',.55)
    return light(canvas,trail)


def light(base,emission):
    from PIL import ImageChops
    glow=emission.filter(ImageFilter.GaussianBlur(4*SCALE))
    return ImageChops.screen(ImageChops.screen(base,glow),emission)


def hand(draw, cx, cy, scale):
    def transform(coords): return [(cx+x*scale,cy+y*scale) for x,y in coords]
    outline=[(-132,43),(-74,16),(-53,5),(-35,1),(-31,-8),(-17,-17),(-13,-15),(-14,-10),(-25,0),(-17,3),(4,1),(21,-2),(44,-11),(55,-18),(61,-19),(63,-16),(58,-10),(46,-1),(62,-8),(75,-16),(80,-15),(80,-12),(70,-3),(55,6),(73,-1),(82,-7),(86,-6),(85,-2),(70,9),(56,17),(68,13),(79,6),(82,7),(80,11),(66,21),(45,31),(16,38),(-18,40),(-43,35),(-64,38),(-110,65)]
    draw.polygon([point(pos) for pos in transform(outline)], fill='#2b393c')
    line(draw,transform(outline+[outline[0]]),'#83999a',1.1)
    for crease in [[(-48,13),(-29,11),(-12,15),(8,14),(28,8)], [(-43,24),(-23,28),(0,28),(24,20)],[(4,1),(19,3),(39,-2),(46,-4)]]:
        line(draw,transform(crease),'#596e6f',.7)


def solar(style, turn):
    canvas=backdrop(1,style).copy(); draw=ImageDraw.Draw(canvas)
    scale=.89+.16*sin(TAU*turn-.6);cx=168+20*sin(TAU*turn); cy=145+3*cos(TAU*turn)
    hand(draw,cx,cy+54*scale,scale)
    ink = ['#806d4a','#415562','#387578'][style]
    def at(radius,angle):
        orbit_x=radius*cos(angle); orbit_z=radius*sin(angle)
        return cx+scale*(orbit_x*.985-orbit_z*.08), cy+scale*(orbit_z*.34+orbit_x*.12), orbit_z
    radii=[18,28,39,51,65,80,94,107]
    for radius in radii:
        for idx in range(1 if style!=2 else 32):
            start,end=(0,TAU) if style!=2 else (idx*TAU/32,(idx+.7)*TAU/32)
            line(draw,[at(radius,angle)[:2] for angle in np.linspace(start,end,120 if style!=2 else 6)],ink,.55)
    if style==0:
        line(draw,[at(108,0)[:2],at(108,pi)[:2]],'#8c7650',1.4)
        for a in range(72):
            line(draw,[at(111,a*TAU/72)[:2],at(109 if a%6 else 106,a*TAU/72)[:2]],'#a99365',.65)
    if style==2:
        for a in range(0,360,30):
            line(draw,[at(116,a*pi/180)[:2],at(121,a*pi/180)[:2]],'#80cbcd',.7)
        line(draw,[(cx,cy+36*scale),(cx,cy+51*scale)],'#65af9e',.65)
    objs=[(0,-1,cx,cy,10*scale)]
    for idx,(radius,size) in enumerate(zip(radii,[2,3.2,4,2.8,7.6,6.3,4.3,4.1])):
        xpos,ypos,depth=at(radius,idx*2.4+turn*TAU*(2 if idx<3 else 1))
        objs.append((depth,idx,xpos,ypos,size*scale))
    glow=Image.new('RGB',canvas.size); emission=ImageDraw.Draw(glow)
    dot(emission,cx,cy,12*scale,[(104,69,29),(208,118,44),(56,133,138)][style]);canvas=light(canvas,glow.filter(ImageFilter.GaussianBlur(5*SCALE)));draw=ImageDraw.Draw(canvas)
    for _,idx,x,y,radius in sorted(objs):
        rgb=([(249,220,134),(255,202,102),(149,255,228)][style] if idx==-1 else PLANETS[idx] if style==1 else (199,158+idx*4,94+idx*5) if style==0 else (101+idx*9,219,211))
        def ring(start,end):
            line(draw,[(x+radius*(1.7*cos(a)),y+radius*(.35*sin(a)-.27*cos(a))) for a in np.linspace(start,end,35)],'#d7c79d' if style!=2 else '#a9fbe8',1)
        if idx==5: ring(pi,TAU)
        disc(draw,x,y,radius,rgb,idx,style,turn)
        if idx==5:ring(0,pi)
        if style==2 and idx in (2,4,7):
            line(draw,[(x+radius+1,y),(x+radius+5,y-5),(x+radius+11,y-5)],'#70bbb7',.5)
    return canvas


def disc(draw,x,y,radius,rgb,idx,style,turn):
    pixels=round(radius*SCALE)
    center_x,center_y=point((x,y))
    for row in range(-pixels,pixels+1):
        lat=row/pixels
        for col in range(-pixels,pixels+1):
            lon=col/pixels; z2=1-lat*lat-lon*lon
            if z2<0:continue
            normal=z2**.5
            strength=.33+.67*max(0,-.49*lon-.5*lat+.71*normal)
            if idx<0:strength=.72+.27*normal+.08*sin(12*lat+4*lon+turn*TAU)
            elif style==1 and idx in (4,5):strength+=.11*sin(lat*20+1.2*sin(lon*3+turn*TAU))
            elif style==1 and idx==2 and sin(lat*11+lon*8+turn*TAU)>.25:rgb_local=(108,177,137)
            if style==2:strength=(.62+.30*(row%4==0)+.08*normal)*(.66+.34*normal)
            color=rgb_local if idx==2 and style==1 and sin(lat*11+lon*8+turn*TAU)>.25 else rgb
            draw.point((center_x+col,center_y+row),tuple(max(0,min(255,int(value*strength))) for value in color))


def render(output):
    assets=ROOT/'src'/'effect-studies'; assets.mkdir(exist_ok=True);output.mkdir(parents=True,exist_ok=True)
    for group,slug in enumerate(('comet','solar')):
        frames=[]
        for idx in range(80):
            sheet=Image.new('RGB',(WIDTH*3+4,HEIGHT),'#75817d')
            for style in range(3):
                tile=(comet if group==0 else solar)(style,idx/80)
                sheet.paste(tile.resize((WIDTH,HEIGHT),Image.Resampling.LANCZOS),((WIDTH+2)*style,0))
            frames.append(sheet)
        frames[0].save(output/(slug+'-studies.gif'),save_all=True,append_images=frames[1:],duration=80,loop=0,disposal=1)
        frames[0].save(assets/(slug+'.webp'),save_all=True,append_images=frames[1:],duration=80,loop=0,quality=78,method=3)
        frames[17].save(assets/(slug+'-still.webp'),quality=85)


if __name__=='__main__':
    render(Path(sys.argv[1]))
