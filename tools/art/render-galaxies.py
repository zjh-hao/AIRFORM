"""Render three inclined stellar discs with a warm bulge, dusty arms and a 3D star field."""
import sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

SIZE = 288
TEX = 768
TAU = 2 * np.pi
Y, X = np.mgrid[-1.27:1.27:complex(SIZE), -1.27:1.27:complex(SIZE)].astype('f')
V, U = np.mgrid[-1.24:1.24:complex(TEX), -1.24:1.24:complex(TEX)].astype('f')


def turbulence(rng):
    values = np.zeros_like(U)
    for cells, strength in [(7,.39), (19,.24), (37,.17), (83,.11), (169,.065), (340,.025)]:
        grid = rng.normal(0, 1, (cells,cells)).astype('f')
        values += strength * cv2.resize(grid,(TEX,TEX),interpolation=cv2.INTER_CUBIC)
    return values


def disk_texture(rng, barred):
    r = np.hypot(U,V)
    angle = np.arctan2(V,U)
    cloud = turbulence(rng)
    knots = turbulence(rng)
    phase = (2 if barred else 3)*(angle - (2.3 if barred else 2.95)*np.log1p(3*r))
    wave = np.cos(phase + cloud*1.65)
    arms = np.exp(-((1-wave)*2.5)**1.25)
    disc = np.exp(-r**1.5*2.7) * np.clip((1.18-r)*4,0,1)
    lane = np.exp(-((np.sin((phase+.42+cloud*1.85)/2))/.25)**2)
    extinction = np.clip(.27 + .61*lane + cloud*.54, .01,.97) * np.clip(r*7,0,1)
    patches = np.clip(.78 + knots*1.35 + cloud*.52, .12,2.2)
    light = disc*(.17+1.25*arms)*patches*(1-extinction)
    dust = disc*(.23+arms*.62+lane*.47)*np.clip(.74+cloud*.6,0,1.8)
    bar = np.exp(-(U/.37)**2-(V/.087)**2) if barred else np.exp(-((U/.17)**2+(V/.14)**2))
    inner = np.exp(-r*5)
    red = light*(.46+inner*.6) + .63*bar
    green = light*(.62+inner*.25) + .38*bar
    blue = light*(1.25 if not barred else .84) + .19*bar
    hii = np.clip(knots-.12,0,1)**2*disc*arms*(4.8 if barred else .48)
    color = np.stack([red+hii,green,blue+hii*.52],axis=2)
    return np.dstack([color,dust]).astype('f')


def render_variant(out, key, seed, tilt, roll, barred):
    rng=np.random.default_rng(seed)
    tex=disk_texture(rng,barred)
    # Fixed stellar positions give the changing view coherent parallax and prevent sparkle noise.
    n=12000
    r=np.clip(rng.gamma(2,.21,n),0,1.18)
    branch=rng.integers(0,2 if barred else 3,n)
    arm_angle=branch*TAU/(2 if barred else 3)+(2.3 if barred else 2.95)*np.log1p(3*r)
    theta=arm_angle+rng.normal(0,.18,n)
    theta[::3]=rng.uniform(0,TAU,len(theta[::3]))
    sx=r*np.cos(theta); sy=r*np.sin(theta)
    sz=rng.normal(0,.023+.06*np.exp(-r*5),n)
    lum=.026+rng.pareto(2.3,n)*.34
    lum*=np.clip((1.17-r)*3.8,0,1)
    colors=np.column_stack([.66+rng.random(n)*.48,.73+rng.random(n)*.34,.84+rng.random(n)*.47])
    target=Path(out)/key
    target.mkdir(parents=True,exist_ok=True)
    edge=key=='edge'
    for f in range(64):
        phase=TAU*f/64
        yaw=(.21 if not edge else .14)*np.sin(phase)
        inc=tilt+.064*np.cos(phase)
        rot=roll+.045*np.sin(phase+.55)
        cr,sr=np.cos(rot),np.sin(rot)
        ci,si=np.cos(inc),np.sin(inc)
        cy,syaw=np.cos(yaw),np.sin(yaw)
        # Undo camera roll, then intersect the rays with three heights in the inclined disk.
        x=X*cr+Y*sr
        y=-X*sr+Y*cr
        def sample(height):
            v=(y-height*si)/ci
            u=x*cy+v*syaw
            w=-x*syaw+v*cy
            return cv2.remap(tex,(u/2.48+.5)*(TEX-1),(w/2.48+.5)*(TEX-1),cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
        mid=sample(0)
        haze=.5*(sample(-.034)+sample(.034))
        rad=np.sqrt((x/(.23 if edge else .19))**2+(y/(.13 if edge else .14))**2)
        bulge=np.exp(-rad*1.35)
        core=np.exp(-rad*7.0)
        radiance=(mid[:,:,:3]*.84+haze[:,:,:3]*.32)+bulge[:,:,None]*[1.35,.91,.53]+core[:,:,None]*[1.4,1.28,.99]
        if edge:
            band=np.exp(-((y-.012-.013*np.sin(x*11))/.037)**2)*np.exp(-abs(x)*.86)
            radiance*=1-.985*band[:,:,None]
        else:
            band=mid[:,:,3]*np.clip(np.hypot(x,y)*6,0,1)
        # Project the 3D stars into the same orientation as the absorbing layer.
        dx=sx*cy-sy*syaw
        dy=(sx*syaw+sy*cy)*ci+sz*si
        px=(dx*cr-dy*sr+1.27)*(SIZE-1)/2.54
        py=(dx*sr+dy*cr+1.27)*(SIZE-1)/2.54
        ix=np.floor(px).astype(int); iy=np.floor(py).astype(int)
        valid=(ix>=0)&(ix<SIZE-1)&(iy>=0)&(iy<SIZE-1)
        ix,iy=ix[valid],iy[valid]
        fx,fy=px[valid]-ix,py[valid]-iy
        specks=np.zeros((SIZE,SIZE,3),dtype='f')
        power=lum[valid]*(1-.96*np.clip(band[iy,ix],0,1))
        for ox,oy,weight in [(0,0,(1-fx)*(1-fy)),(1,0,fx*(1-fy)),(0,1,(1-fx)*fy),(1,1,fx*fy)]:
            np.add.at(specks,(iy+oy,ix+ox),colors[valid]*(power*weight)[:,None])
        radiance+=specks*.38+cv2.GaussianBlur(specks,(0,0),1.25)*.30
        if key=='dark':
            veil=np.exp(-((y-.035-.13*x-.042*np.sin(9*x+.42*np.sin(phase)))/.085)**2)
            veil*=np.exp(-abs(x)*1.7)*np.clip(.62+mid[:,:,3]*.53,0,1)
            radiance*=1-.90*veil[:,:,None]
        exposure=1-np.exp(-radiance*1.52)
        alpha=np.clip(exposure.max(axis=2)+mid[:,:,3]*(.92 if key=='dark' else .6)+bulge*.14,0,1)
        rgb=np.clip(exposure/np.maximum(alpha[:,:,None],.001),0,1)**.91
        rgba=np.uint8(np.dstack([rgb,alpha])*255)
        Image.fromarray(rgba).save(target/f'{f:02}.png')
    print(key,flush=True)


if __name__=='__main__':
    for args in [('dark',754,.83,-.32,False),('barred',981,.47,.38,True),('edge',468,1.37,-.29,False)]:
        render_variant(sys.argv[1],*args)
