"""Reproducible original geometric berth-bot GIFs. Requires Pillow only to rebuild."""
from PIL import Image, ImageDraw
from pathlib import Path
import math

folder = Path(__file__).resolve().parent.parent / 'src/renderer/pet-assets'
folder.mkdir(parents=True, exist_ok=True)
for state in ['idle', 'working', 'waiting', 'completed', 'error', 'unknown']:
    frames=[]
    for n in range(16):
        scale=3
        im=Image.new('RGBA',(192*scale,160*scale),(0,0,0,0)); d=ImageDraw.Draw(im)
        def ellipse(box, fill): d.ellipse(tuple(int(v*scale) for v in box),fill=fill)
        def rect(box, radius, fill): d.rounded_rectangle(tuple(int(v*scale) for v in box),int(radius*scale),fill=fill)
        def line(points,fill,width=3): d.line([(int(x*scale),int(y*scale)) for x,y in points],fill=fill,width=int(width*scale))
        t=n/16*math.tau; bounce=math.sin(t)*(3 if state in ['working','completed'] else 1.5)
        c='#8cdec4' if state not in ['error','unknown'] else '#f3a1a4' if state=='error' else '#abbccd'
        ellipse((49,139,143,147),'#1c4548')
        # Floating docking companion with two fins and luminous antenna.
        line([(96,39+bounce),(96,25+bounce)],'#5ea79f',3)
        ellipse((90,18+bounce,102,30+bounce),'#f8cc77' if state=='waiting' else c)
        rect((51,111+bounce,75,140+bounce),10,'#459f92');rect((117,111+bounce,141,140+bounce),10,'#459f92')
        rect((37,68+bounce,55,105+bounce),8,'#56b8a2');rect((137,68+bounce,155,105+bounce),8,'#56b8a2')
        rect((48,39+bounce,144,128+bounce),27,c)
        rect((56,49+bounce,136,99+bounce),17,'#183b43')
        # Eyes blink, glance, or curve into smiles.
        blink=n in [12,13] and state in ['idle','unknown']
        if state=='completed':
            for x in [77,111]: line([(x-6,77+bounce),(x,70+bounce),(x+6,77+bounce)],c,3)
        elif state=='error':
            for x in [77,111]:
                line([(x-5,66+bounce),(x+5,78+bounce)],c,3);line([(x+5,66+bounce),(x-5,78+bounce)],c,3)
        else:
            for x in [77,111]: rect((x-4,69+bounce,x+4,71+bounce if blink else 80+bounce),3,c)
        rect((86,110+bounce,106,116+bounce),3,'#367d76')
        # State props stay distinct in monochrome and small sizes.
        if state=='working':
            rect((60,117,132,137),5,'#224e56')
            for i in range(5): rect((67+i*12,123,73+i*12,127+(3 if (n//2)%5==i else 0)),1,'#8cdec4')
            for i in range(3): ellipse((152,43+i*10,157,48+i*10),'#f8cc77' if n%3==i else '#39766f')
        elif state=='waiting':
            ellipse((144,30,174,60),'#f8cc77');line([(155,39),(163,39),(164,44),(159,47),(159,49)],'#5d441b',2);ellipse((158,53,160,55),'#5d441b')
        elif state=='completed':
            for x,y,p in [(34,40,0),(158,53,1),(149,115,2)]:
                length=4+math.sin(t+p)*2;line([(x-length,y),(x+length,y)],'#f8cc77',2);line([(x,y-length),(x,y+length)],'#f8cc77',2)
        elif state=='error':
            ellipse((145,29,174,58),'#f3a1a4');rect((158,35,161,47),1,'#5d303e');ellipse((158,51,161,54),'#5d303e')
        elif state=='unknown':
            for i in range(3): ellipse((148+i*9,45,152+i*9,49),'#becbd8' if n//3%3==i else '#49616f')
        im=im.resize((192,160),Image.Resampling.LANCZOS)
        # Dedicated transparent palette index prevents animation halos/black backgrounds.
        alpha=im.getchannel('A'); rgb=Image.new('RGB', im.size, '#14262c');rgb.paste(im,mask=alpha)
        pal=rgb.quantize(colors=255);mask=alpha.point(lambda a:255 if a<100 else 0);pal.paste(255,mask=mask);pal.info['transparency']=255
        frames.append(pal)
    frames[0].save(folder/(state+'.gif'),save_all=True,append_images=frames[1:],duration=100,loop=0,transparency=255,disposal=2,optimize=False)
