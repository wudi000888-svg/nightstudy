"""Create the exact machine-readable Wordbook v1 examples, without hidden metadata or macros."""
from pathlib import Path
import argparse

HEADER = 'NIGHTSTUDY-WORDBOOK v1'
WORDS = ['rain', 'window', 'quiet', 'learn', 'story', 'river', 'travel', 'friend', 'morning', 'garden']
parser = argparse.ArgumentParser()
parser.add_argument('--format', choices=['txt', 'docx', 'pdf'], required=True)
parser.add_argument('--output', default='docs/templates')
args = parser.parse_args()
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
target = out / f'nightstudy-wordbook-template.{args.format}'
if args.format == 'txt':
    target.write_text('\n'.join([HEADER] + WORDS) + '\n', encoding='utf-8')
elif args.format == 'docx':
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Inches(8.5), Inches(11)
    sec.top_margin = sec.bottom_margin = sec.left_margin = sec.right_margin = Inches(1)
    for name in ['Normal', 'Title']:
        style = doc.styles[name]
        style.font.name = 'Liberation Mono'
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.font.size = Pt(12 if name == 'Normal' else 16)
        style.paragraph_format.space_after = Pt(10)
        style.font.underline = False
        for border in style._element.xpath('.//w:pBdr'):
            border.getparent().remove(border)
        for fonts in style._element.xpath('.//w:rFonts'):
            for key in list(fonts.attrib):
                if key.endswith('Theme') or key.endswith('theme'):
                    del fonts.attrib[key]
    doc.add_paragraph(HEADER, 'Title')
    for word in WORDS:
        doc.add_paragraph(word)
    doc.core_properties.author = 'NightStudy'
    doc.core_properties.title = 'NightStudy Wordbook v1'
    doc.core_properties.subject = 'Standard word-per-line import template'
    doc.save(target)
else:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter
    c = canvas.Canvas(str(target), pagesize=letter, invariant=1)
    c.setTitle('NightStudy Wordbook v1')
    c.setAuthor('NightStudy')
    c.setFont('Courier-Bold', 16)
    c.drawString(72, 720, HEADER)
    c.setFont('Courier', 12)
    for i, word in enumerate(WORDS):
        c.drawString(72, 677 - i * 26, word)
    c.showPage()
    c.save()
print(target)
