import { describe, expect, test } from 'bun:test';
import { xmlTextValues, xmlBlocks, xmlFirst } from './xml';

const LIST_PARTS = `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>galiot-test</Bucket>
  <UploadId>abc-123</UploadId>
  <Part>
    <PartNumber>1</PartNumber>
    <ETag>&quot;7d793037a0760186574b0282f2f435e7&quot;</ETag>
    <Size>5242880</Size>
  </Part>
  <Part>
    <PartNumber>2</PartNumber>
    <ETag>&quot;4e9f091a5a1b40b2fa3b4c0d1b2e3f45&quot;</ETag>
    <Size>1234</Size>
  </Part>
</ListPartsResult>`;

describe('xmlTextValues', () => {
  test('extracts repeated elements in order', () => {
    expect(xmlTextValues(LIST_PARTS, 'PartNumber')).toEqual(['1', '2']);
    expect(xmlTextValues(LIST_PARTS, 'Size')).toEqual(['5242880', '1234']);
  });

  test('decodes entities', () => {
    const etags = xmlTextValues(LIST_PARTS, 'ETag');
    expect(etags[0]).toBe('"7d793037a0760186574b0282f2f435e7"');
  });

  test('ignores namespace prefixes on both tags', () => {
    const xml = '<s3:CORSRule><s3:AllowedMethod>GET</s3:AllowedMethod></s3:CORSRule>';
    expect(xmlTextValues(xml, 'AllowedMethod')).toEqual(['GET']);
  });

  test('returns an empty array for missing tags', () => {
    expect(xmlTextValues(LIST_PARTS, 'Nope')).toEqual([]);
  });

  test('handles self-closing and empty elements', () => {
    expect(xmlTextValues('<a><b></b><c/></a>', 'b')).toEqual(['']);
    expect(xmlTextValues('<a><b></b><c/></a>', 'c')).toEqual([]);
  });

  test('decodes numeric entities', () => {
    expect(xmlTextValues('<a><b>&#65;&#66;</b></a>', 'b')).toEqual(['AB']);
  });
});

describe('xmlBlocks and xmlFirst', () => {
  test('returns inner XML for each block', () => {
    const blocks = xmlBlocks(LIST_PARTS, 'Part');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('<PartNumber>1</PartNumber>');
  });

  test('xmlFirst returns the first value or undefined', () => {
    expect(xmlFirst(LIST_PARTS, 'UploadId')).toBe('abc-123');
    expect(xmlFirst(LIST_PARTS, 'Missing')).toBeUndefined();
  });
});
