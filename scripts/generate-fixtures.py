"""Generate original, deterministic PDFs. Dev-only: see fixtures/README.md."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import zlib

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject,
    NameObject, NumberObject, TextStringObject,
)


def dictionary(**values):
    return DictionaryObject({NameObject('/' + key): value for key, value in values.items()})


def array(*values):
    return ArrayObject([NumberObject(v) if isinstance(v, int) else v for v in values])


def stream(writer, data, **values):
    obj = DecodedStreamObject()
    obj.set_data(data)
    obj.update(dictionary(**values))
    return writer._add_object(obj)


def text_page(writer, text, size=(612, 792)):
    page = writer.add_blank_page(*size)
    font = dictionary(Type=NameObject('/Font'), Subtype=NameObject('/Type1'),
                      BaseFont=NameObject('/Helvetica'))
    page[NameObject('/Resources')] = dictionary(Font=dictionary(F1=font))
    lines = text.split('\n')
    content = 'BT /F1 14 Tf 40 %d Td 18 TL\n' % (size[1] - 50)
    for line in lines:
        escaped = line.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        content += '(' + escaped + ') Tj T*\n'
    page[NameObject('/Contents')] = stream(writer, (content + 'ET\n').encode('ascii'))
    return page


def image_page(writer, pixels, width, height):
    page = writer.add_blank_page(612, 792)
    image = stream(writer, zlib.compress(pixels, 9), Type=NameObject('/XObject'),
                   Subtype=NameObject('/Image'), Width=NumberObject(width),
                   Height=NumberObject(height), ColorSpace=NameObject('/DeviceRGB'),
                   BitsPerComponent=NumberObject(8), Filter=NameObject('/FlateDecode'))
    page[NameObject('/Resources')] = dictionary(XObject=dictionary(Im1=image))
    page[NameObject('/Contents')] = stream(writer, b'q 532 0 0 532 40 130 cm /Im1 Do Q\n')


def cjk_font():
    # Original rectangular strokes for U+65E5, U+672C, U+4E2D, U+6587.
    # This intentionally tiny test font is not a general-purpose CJK font.
    strokes = [
        [(200, 100, 260, 900), (740, 100, 800, 900), (200, 840, 800, 900),
         (200, 470, 800, 530), (200, 100, 800, 160)],
        [(470, 50, 530, 950), (100, 670, 900, 730), (300, 170, 700, 230),
         [(470, 680), (520, 640), (160, 200), (100, 250)],
         [(480, 640), (530, 680), (900, 250), (840, 200)]],
        [(150, 300, 210, 800), (790, 300, 850, 800), (150, 740, 850, 800),
         (150, 300, 850, 360), (470, 50, 530, 950)],
        [(460, 840, 540, 950), (100, 740, 900, 800),
         [(250, 730), (310, 740), (550, 330), (900, 80), (850, 30), (500, 280)],
         [(690, 740), (750, 730), (500, 280), (150, 30), (100, 80), (450, 330)]],
    ]
    names = ['.notdef', 'uni65E5', 'uni672C', 'uni4E2D', 'uni6587']
    glyphs = {}
    for name, shapes in zip(names, [[]] + strokes):
        pen = TTGlyphPen(None)
        for shape in shapes:
            if isinstance(shape, tuple):
                x0, y0, x1, y1 = shape
                shape = [(x0, y0), (x0, y1), (x1, y1), (x1, y0)]
            pen.moveTo(shape[0])
            for point in shape[1:]:
                pen.lineTo(point)
            pen.closePath()
        glyphs[name] = pen.glyph()
    font = FontBuilder(1000, isTTF=True)
    font.setupGlyphOrder(names)
    font.setupCharacterMap(dict(zip([0x65E5, 0x672C, 0x4E2D, 0x6587], names[1:])))
    font.setupGlyf(glyphs)
    font.setupHorizontalMetrics({name: (1000, 0) for name in names})
    font.setupHorizontalHeader(ascent=1000, descent=0)
    font.setupNameTable({'familyName': 'CoreFixtureCJK', 'styleName': 'Regular',
                        'uniqueFontIdentifier': 'CoreFixtureCJK-1',
                        'fullName': 'CoreFixtureCJK Regular', 'psName': 'CoreFixtureCJK',
                        'copyright': 'Original fixture font; CC0-1.0'})
    font.setupOS2(sTypoAscender=1000, sTypoDescender=0, usWinAscent=1000, usWinDescent=0)
    font.setupPost()
    font.setupMaxp()
    font.font['head'].created = font.font['head'].modified = 2082844800
    font.font.recalcTimestamp = False
    output = io.BytesIO()
    font.save(output)
    return output.getvalue()


def generate(output):
    output.mkdir(parents=True, exist_ok=True)
    entries = []

    def save(name, writer, **expected):
        if isinstance(writer, bytes):
            data = writer
        else:
            writer.add_metadata({'/Producer': 'CORE-02 synthetic fixture generator',
                                 '/CreationDate': 'D:20000101000000Z'})
            buffer = io.BytesIO()
            writer.write(buffer)
            data = buffer.getvalue()
        (output / name).write_bytes(data)
        entries.append({'file': name, 'bytes': len(data),
                        'sha256': hashlib.sha256(data).hexdigest(),
                        'license': 'CC0-1.0', 'provenance': 'Original synthetic data; scripts/generate-fixtures.py',
                        'expected': expected})

    writer = PdfWriter()
    text_page(writer, 'CORE-02 basic text\nSelect and copy this sentence.')
    save('basic.pdf', writer, pages=1, outline=[], text='CORE-02 basic text',
         behavior='Selectable text; no table of contents.')

    writer = PdfWriter()
    for number in range(1, 5):
        text_page(writer, f'Navigation page {number}')
    root = writer.add_outline_item('Chapter 1 (direct)', 0)
    child = writer.add_outline_item('Section 1.1 (named)', 2, parent=root)
    named = writer.add_named_destination('chapter-three', 2)
    named.get_object()['/D'][2] = NumberObject(740)
    del child.get_object()[NameObject('/A')]
    child.get_object()[NameObject('/Dest')] = TextStringObject('chapter-three')
    group = writer.add_outline_item('Group without destination', None)
    writer.add_outline_item('Final page (direct)', 3, parent=group)
    broken = writer.add_outline_item('Missing named target', None)
    broken.get_object()[NameObject('/Dest')] = TextStringObject('does-not-exist')
    writer.add_outline_item('<b>literal outline title</b>', 1)
    links = [array(writer.pages[1].indirect_reference, NameObject('/XYZ'), 40, 700, FloatObject(1.25)),
             TextStringObject('chapter-three'), TextStringObject('does-not-exist')]
    annotations = ArrayObject()
    for index, destination in enumerate(links):
        annotations.append(writer._add_object(dictionary(Type=NameObject('/Annot'), Subtype=NameObject('/Link'),
                              Rect=array(40, 620-index*35, 300, 645-index*35),
                              Border=array(0, 0, 1), Dest=destination)))
    writer.pages[0][NameObject('/Annots')] = annotations
    save('navigation.pdf', writer, pages=4,
         namedDestinations={'chapter-three': {'page': 3, 'fit': 'FitH', 'top': 740}},
         directOutlineFit='Fit',
         outline=[{'title': 'Chapter 1 (direct)', 'page': 1, 'children': [
             {'title': 'Section 1.1 (named)', 'name': 'chapter-three', 'page': 3}]},
             {'title': 'Group without destination', 'children': [{'title': 'Final page (direct)', 'page': 4}]},
             {'title': 'Missing named target', 'name': 'does-not-exist', 'page': None},
             {'title': '<b>literal outline title</b>', 'page': 2}],
         links=[{'page': 2, 'fit': 'XYZ', 'left': 40, 'top': 700, 'zoom': 1.25},
                {'name': 'chapter-three', 'page': 3}, {'name': 'does-not-exist', 'page': None}],
         behavior='Nested tree; destinationless parent expands; missing target is nonfatal; HTML-like title is literal text.')

    writer = PdfWriter()
    sizes = [(612, 792), (842, 595), (300, 300)]
    for number, size in enumerate(sizes, 1):
        text_page(writer, f'Size page {number}: {size[0]} x {size[1]} points', size)
    writer.pages[2].rotate(90)
    save('page-sizes.pdf', writer, pages=3, outline=[], mediaBoxes=sizes, rotations=[0, 0, 90],
         behavior='Letter portrait, A4-like landscape, square rotated 90 degrees; fit/zoom follows each page.')

    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    font_data = cjk_font()
    descriptor = writer._add_object(dictionary(Type=NameObject('/FontDescriptor'),
        FontName=NameObject('/CoreFixtureCJK'), Flags=NumberObject(4), FontBBox=array(0, 0, 1000, 1000),
        ItalicAngle=NumberObject(0), Ascent=NumberObject(1000), Descent=NumberObject(0),
        CapHeight=NumberObject(1000), StemV=NumberObject(60),
        FontFile2=stream(writer, font_data, Length1=NumberObject(len(font_data)))))
    descendant = writer._add_object(dictionary(Type=NameObject('/Font'), Subtype=NameObject('/CIDFontType2'),
        BaseFont=NameObject('/CoreFixtureCJK'), CIDSystemInfo=dictionary(
            Registry=TextStringObject('Adobe'), Ordering=TextStringObject('Identity'), Supplement=NumberObject(0)),
        FontDescriptor=descriptor, DW=NumberObject(1000), CIDToGIDMap=NameObject('/Identity')))
    cmap = b'''/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /CoreFixtureCJK-UCS def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
4 beginbfchar <0001> <65E5> <0002> <672C> <0003> <4E2D> <0004> <6587> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end
'''
    font = writer._add_object(dictionary(Type=NameObject('/Font'), Subtype=NameObject('/Type0'),
        BaseFont=NameObject('/CoreFixtureCJK'), Encoding=NameObject('/Identity-H'),
        DescendantFonts=array(descendant), ToUnicode=stream(writer, cmap)))
    page[NameObject('/Resources')] = dictionary(Font=dictionary(F1=font))
    page[NameObject('/Contents')] = stream(writer, b'BT /F1 48 Tf 40 650 Td <0001000200030004> Tj ET\n')
    save('cjk-embedded.pdf', writer, pages=1, outline=[], text='\u65e5\u672c\u4e2d\u6587',
         embeddedFont='CoreFixtureCJK', glyphs=4,
         behavior='Four original CJK glyphs (Japanese/Chinese shared characters), embedded TrueType and ToUnicode; no system font needed. Not full CJK coverage.')

    writer = PdfWriter()
    # Raster-only SCAN 01 in original 5x7 bitmap lettering; deliberately no OCR layer.
    letters = ['01111 10000 10000 01110 00001 00001 11110',
               '01111 10000 10000 10000 10000 10000 01111',
               '01110 10001 10001 11111 10001 10001 10001',
               '10001 11001 11001 10101 10011 10011 10001',
               '00000 00000 00000 00000 00000 00000 00000',
               '01110 10001 10011 10101 11001 10001 01110',
               '00100 01100 00100 00100 00100 00100 01110']
    pixels = bytearray(b'\xff' * (256 * 256 * 3))
    for index, letter in enumerate(letters):
        for row, bits in enumerate(letter.split()):
            for col, bit in enumerate(bits):
                if bit == '1':
                    for dy in range(4):
                        for dx in range(4):
                            offset = ((100+row*4+dy)*256 + 40+index*24+col*4+dx)*3
                            pixels[offset:offset+3] = b'\x20\x20\x20'
    image_page(writer, bytes(pixels), 256, 256)
    save('scan.pdf', writer, pages=1, outline=[], text='', imagesPerPage=1,
         imagePixels=[256, 256], behavior='Synthetic image-only scan reads SCAN 01; selection yields no text; no OCR.')

    writer = PdfWriter()
    text_page(writer, 'Encrypted synthetic test document')
    writer.encrypt('core02-user', 'core02-owner', algorithm='RC4-128')
    save('encrypted.pdf', writer, pages=1, outline=[], text='Encrypted synthetic test document',
         passwords={'user': 'core02-user', 'owner': 'core02-owner', 'wrong': 'wrong-password'},
         encryption='RC4-128', behavior='Prompt without password; wrong password retries; user/owner opens. Cancel/close must preserve other sessions (CORE-04/05). RC4 is test coverage, not security advice.')

    save('corrupt.pdf', b'%PDF-1.7\nThis is deliberately truncated, not a PDF object graph.\n',
         pages=None, behavior='Parser rejects; reader reports recoverable error and can open basic.pdf next.')

    writer = PdfWriter()
    for number in range(1, 301):
        text_page(writer, f'Long text page {number:03d} of 300\n' + '\n'.join(
            f'Line {line:02d}: Synthetic reading and scrolling performance content.' for line in range(1, 36)))
    save('long-text.pdf', writer, pages=300, outline=[],
         behavior='Manual performance: first page, jump 150/300, rapid scroll, zoom, repeated open/close; bounded rendering resources. Not a measured performance budget.')

    writer = PdfWriter()
    for number in range(12):
        pixels = hashlib.shake_256(f'CORE-02 image page {number}'.encode('ascii')).digest(512*512*3)
        image_page(writer, pixels, 512, 512)
    save('image-heavy.pdf', writer, pages=12, outline=[], text='', imagesPerPage=1,
         imagePixels=[512, 512], decodedImageBytes=12*512*512*3,
         behavior='Distinct deterministic RGB noise pages; manual byte-transport, decode/cache and open/close checks. Synthetic stress, not a representative photographed book.')
    manifest = {'schemaVersion': 1, 'generator': 'scripts/generate-fixtures.py',
                'tools': {'pypdf': '6.1.1', 'fonttools': '4.59.2'}, 'fixtures': entries}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + '\n', encoding='utf-8', newline='\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'fixtures' / 'pdfs')
    args = parser.parse_args()
    manifest = generate(args.output)
    for entry in manifest['fixtures']:
        print(f"{entry['file']}: {entry['expected']['pages']} pages, {entry['bytes']} bytes")
