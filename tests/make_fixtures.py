from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont
out=Path(__file__).parent/'fixtures'
out.mkdir(exist_ok=True)
font_path='C:/Windows/Fonts/malgun.ttf'
pdfmetrics.registerFont(TTFont('Korean',font_path))
c=canvas.Canvas(str(out/'text-questions.pdf'),pagesize=(595,842))
for page in range(2):
    c.setFont('Korean',13)
    for n,y in [(page*2+1,760),(page*2+2,375)]:
        for j,text in enumerate([f'{n:02d}. 다음 수열의 빈칸에 들어갈 수를 고르시오.', '2, 4, 8, 16, ( ? )','① 20     ② 24     ③ 28     ④ 30     ⑤ 32']):
            c.drawString(40,y-j*38,text)
        c.rect(40,y-165,500,38)
        c.drawString(55,y-151,'원본 표·문자·이미지 자르기 검증용 자체 제작 문제')
    c.setFont('Korean',9);c.drawString(280,20,str(page+1));c.showPage()
c.save()
im=Image.new('RGB',(1190,1684),'white');d=ImageDraw.Draw(im);f=ImageFont.truetype(font_path,28)
for n,y in [(1,160),(2,880)]:
    d.text((80,y),f'{n:02d}. 스캔형 PDF 자르기 검증용 문항',font=f,fill='black')
    d.text((80,y+80),'3, 6, 12, 24, ( ? )',font=f,fill='black')
    d.text((80,y+160),'① 30   ② 36   ③ 40   ④ 42   ⑤ 48',font=f,fill='black')
    d.rectangle((80,y+240,1090,y+340),outline='black',width=3)
    d.text((100,y+260),'텍스트 레이어가 없는 이미지 PDF',font=f,fill='black')
im.save(out/'scan-source.png')
c=canvas.Canvas(str(out/'scan-questions.pdf'),pagesize=(595,842));c.drawImage(ImageReader(im),0,0,width=595,height=842);c.save()
print('Created text-questions.pdf (2 pages) and scan-questions.pdf (1 page).')
