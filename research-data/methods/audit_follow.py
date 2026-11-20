import csv
from itertools import groupby
import json
from pathlib import Path
import sys
import numpy as np


def audit(folder):
    rows=list(csv.DictReader((folder/'frames.csv').open()))
    labels={0:(115,79),60:(111,80),300:(93,81),360:(79,83),420:(94,81),600:(182,84),720:(79,82),1080:(111,83),1440:(90,84)}
    errors=[]
    for row in rows:
        frame=int(row['frame'])
        if frame in labels and row['points']:
            tip=np.array(json.loads(row['points'])[8])/2
            errors.append(float(np.linalg.norm(tip-labels[frame])*2))
    print('Visually localized index tip samples (640x480 pixel units):',len(errors),'of',len(labels),'median / max:',np.percentile(errors,[50,100]) if errors else None)
    palms={298:(100,133),390:(161,133),478:(122,136),1164:(115,134),1196:(113,141),1208:(158,137),1250:(162,138),1310:(110,138),1364:(130,137),1408:(151,139),1428:(145,139),1450:(126,139)}
    errs=[]
    for row in rows:
        frame=int(row['frame'])
        if frame in palms and row['points']:
            pred=np.median(np.array(json.loads(row['points']))[[0,5,9,13,17]],axis=0)
            errs.append(float(np.linalg.norm(pred-2*np.array(palms[frame]))))
    print('Fast-motion approximate palm center samples:',len(errs),'of',len(palms),'median / max (640x480 px):',np.percentile(errs,[50,100]) if errs else None)
    for name,group in [('all',rows),('0-25s',[r for r in rows if float(r['time'])<25]),('19-25s',[r for r in rows if 19<=float(r['time'])<25])]:
        gaps=[len(list(items)) for lost,items in groupby(group,key=lambda r:r['source']=='lost') if lost]
        print(name,len(group),'original',sum(int(r['original']) for r in group),'visible',sum(r['source']!='lost' for r in group),'tracked-only',sum(r['source'] in ('tracked','guided') for r in group),'max lost samples',max(gaps,default=0))


if __name__=='__main__': audit(Path(sys.argv[1]))
