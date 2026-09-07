"""Offline structural checks using pypdf, not PDF-header/regex validity claims."""

import hashlib
import importlib.util
import importlib.metadata
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

from fontTools.ttLib import TTFont
from pypdf import PdfReader
from pypdf.errors import FileNotDecryptedError, PdfReadError
from pypdf.generic import ContentStream

ROOT = Path(__file__).resolve().parents[1]
PDFS = ROOT / 'fixtures' / 'pdfs'
MANIFEST = json.loads((PDFS / 'manifest.json').read_text(encoding='utf-8'))


class Fixtures(unittest.TestCase):
    def test_manifest_and_parse_every_page(self):
        expected_names = {'basic.pdf', 'navigation.pdf', 'page-sizes.pdf', 'cjk-embedded.pdf',
                          'scan.pdf', 'encrypted.pdf', 'corrupt.pdf', 'long-text.pdf', 'image-heavy.pdf'}
        self.assertEqual({e['file'] for e in MANIFEST['fixtures']}, expected_names)
        self.assertEqual({p.name for p in PDFS.glob('*.pdf')}, expected_names)
        for entry in MANIFEST['fixtures']:
            with self.subTest(file=entry['file']):
                data = (PDFS / entry['file']).read_bytes()
                self.assertEqual(len(data), entry['bytes'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry['sha256'])
                self.assertEqual(entry['license'], 'CC0-1.0')
                self.assertIn('Original synthetic', entry['provenance'])
                expected = entry['expected']
                self.assertTrue(expected['behavior'])
                if entry['file'] == 'corrupt.pdf':
                    with self.assertRaises(PdfReadError):
                        PdfReader(io.BytesIO(data), strict=True)
                    continue
                reader = PdfReader(io.BytesIO(data), strict=True)
                if reader.is_encrypted:
                    self.assertTrue(reader.decrypt(expected['passwords']['user']))
                self.assertEqual(len(reader.pages), expected['pages'])
                if expected.get('outline') == []:
                    self.assertEqual(reader.outline, [])
                for page in reader.pages:
                    self.assertGreater(len(ContentStream(page['/Contents'], reader).operations), 0)
                    text = page.extract_text()
                    if 'text' in expected:
                        if expected['text']:
                            self.assertIn(expected['text'], text)
                        else:
                            self.assertEqual(text, '')
                    if 'imagesPerPage' in expected:
                        images = page['/Resources']['/XObject']
                        self.assertEqual(len(images), expected['imagesPerPage'])
                        for ref in images.values():
                            image = ref.get_object()
                            self.assertEqual(image['/Subtype'], '/Image')
                            self.assertEqual([image['/Width'], image['/Height']], expected['imagePixels'])
                            self.assertEqual(len(image.get_data()), image['/Width']*image['/Height']*3)

    def test_navigation(self):
        reader = PdfReader(PDFS / 'navigation.pdf', strict=True)
        named = reader.named_destinations
        self.assertEqual(list(named), ['chapter-three'])
        self.assertEqual(reader.get_destination_page_number(named['chapter-three']), 2)
        self.assertEqual(named['chapter-three'].typ, '/FitH')
        self.assertEqual(named['chapter-three'].top, 740)
        # Walk raw parsed outline dictionaries to retain broken and absent destinations.
        def walk(item):
            result = []
            while item:
                obj = item.get_object()
                record = {'title': str(obj['/Title'])}
                dest = obj.get('/Dest', obj.get('/A', {}).get('/D'))
                if isinstance(dest, str):
                    record['name'] = dest
                    record['page'] = reader.get_destination_page_number(named[dest])+1 if dest in named else None
                elif dest is not None:
                    record['page'] = reader.get_page_number(dest[0].get_object())+1
                    self.assertEqual(dest[1], '/Fit')
                if '/First' in obj:
                    record['children'] = walk(obj['/First'])
                result.append(record)
                item = obj.get('/Next')
            return result
        expected = next(e['expected'] for e in MANIFEST['fixtures'] if e['file'] == 'navigation.pdf')
        self.assertEqual(walk(reader.trailer['/Root']['/Outlines']['/First']), expected['outline'])
        self.assertEqual(len(reader.pages[0]['/Annots']), 3)
        direct, named_link, broken = [ref.get_object()['/Dest'] for ref in reader.pages[0]['/Annots']]
        self.assertEqual(reader.get_page_number(direct[0].get_object()), 1)
        self.assertEqual(list(direct[1:]), ['/XYZ', 40, 700, 1.25])
        self.assertEqual(named_link, 'chapter-three')
        self.assertEqual(broken, 'does-not-exist')
        self.assertNotIn(broken, named)

    def test_sizes_and_rotation(self):
        reader = PdfReader(PDFS / 'page-sizes.pdf', strict=True)
        self.assertEqual([list(p.mediabox) for p in reader.pages],
                         [[0, 0, 612, 792], [0, 0, 842, 595], [0, 0, 300, 300]])
        self.assertEqual([p.rotation for p in reader.pages], [0, 0, 90])

    def test_embedded_cjk_font(self):
        reader = PdfReader(PDFS / 'cjk-embedded.pdf', strict=True)
        font = reader.pages[0]['/Resources']['/Font']['/F1']
        self.assertEqual(font['/Subtype'], '/Type0')
        self.assertEqual(font['/Encoding'], '/Identity-H')
        cid = font['/DescendantFonts'][0].get_object()
        self.assertEqual(cid['/CIDToGIDMap'], '/Identity')
        data = cid['/FontDescriptor']['/FontFile2'].get_data()
        embedded = TTFont(io.BytesIO(data), checkChecksums=2)
        self.assertEqual(set(embedded.getBestCmap()), {0x65E5, 0x672C, 0x4E2D, 0x6587})
        for code, name in embedded.getBestCmap().items():
            self.assertGreater(embedded['glyf'][name].numberOfContours, 0)
        self.assertEqual(reader.pages[0].extract_text(), '\u65e5\u672c\u4e2d\u6587')

    def test_passwords(self):
        for password, status in [('wrong-password', 0), ('core02-user', 1), ('core02-owner', 2)]:
            reader = PdfReader(PDFS / 'encrypted.pdf', strict=True)
            self.assertTrue(reader.is_encrypted)
            with self.assertRaises(FileNotDecryptedError):
                len(reader.pages)
            self.assertEqual(reader.decrypt(password), status)
            if status:
                self.assertEqual(len(reader.pages), 1)
                self.assertIn('Encrypted synthetic', reader.pages[0].extract_text())
            else:
                with self.assertRaises(FileNotDecryptedError):
                    len(reader.pages)
                self.assertEqual(reader.decrypt('core02-user'), 1)
                self.assertEqual(len(reader.pages), 1)

    def test_performance_content(self):
        reader = PdfReader(PDFS / 'long-text.pdf', strict=True)
        self.assertEqual(len(reader.pages), 300)
        for number, page in enumerate(reader.pages, 1):
            text = page.extract_text()
            self.assertIn(f'Long text page {number:03d} of 300', text)
            self.assertEqual(text.count('Synthetic reading'), 35)
        reader = PdfReader(PDFS / 'image-heavy.pdf', strict=True)
        images = [p['/Resources']['/XObject']['/Im1'].get_data() for p in reader.pages]
        self.assertEqual(len(set(hashlib.sha256(data).digest() for data in images)), 12)
        self.assertEqual(sum(map(len, images)), 9437184)

    def test_reproducible(self):
        for package, version in MANIFEST['tools'].items():
            self.assertEqual(importlib.metadata.version(package), version)
        spec = importlib.util.spec_from_file_location('generate_fixtures', ROOT / 'scripts' / 'generate-fixtures.py')
        generator = importlib.util.module_from_spec(spec)
        sys.dont_write_bytecode = True
        spec.loader.exec_module(generator)
        with tempfile.TemporaryDirectory(prefix='core02-') as directory:
            output = Path(directory)
            generator.generate(output)
            for name in ['manifest.json'] + [e['file'] for e in MANIFEST['fixtures']]:
                self.assertEqual((output / name).read_bytes(), (PDFS / name).read_bytes(), name)


if __name__ == '__main__':
    unittest.main(verbosity=2)
