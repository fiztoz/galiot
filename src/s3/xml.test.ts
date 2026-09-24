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

  test('preserves surrounding whitespace, because S3 keys may contain it', () => {
    // DOMParser.textContent returned these verbatim, and a key like
    // " report.csv" is legal. Trimming here would silently rename the object.
    expect(xmlTextValues('<a><Key> report.csv</Key></a>', 'Key')).toEqual([' report.csv']);
    expect(xmlTextValues('<a><Key>report.csv </Key></a>', 'Key')).toEqual(['report.csv ']);
    expect(xmlTextValues('<a><Key>  </Key></a>', 'Key')).toEqual(['  ']);
  });

  test('preserves whitespace inside pretty-printed leaf elements', () => {
    expect(xmlTextValues('<a>\n  <Key>reports/q3.csv</Key>\n</a>', 'Key')).toEqual([
      'reports/q3.csv',
    ]);
  });

  test('decodes ampersands in a key without eating the rest of the value', () => {
    expect(xmlTextValues('<a><Key>a&amp;b</Key></a>', 'Key')).toEqual(['a&b']);
    // &amp; is replaced last precisely so &amp;lt; does not become '<'.
    expect(xmlTextValues('<a><Key>&amp;lt;</Key></a>', 'Key')).toEqual(['&lt;']);
  });
});

describe('ListObjectsV2 shapes the client parses', () => {
  const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name><Prefix></Prefix><KeyCount>3</KeyCount><MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated><NextContinuationToken>token-abc</NextContinuationToken>
  <Contents><Key>reports/q3.csv</Key><LastModified>2026-01-02T10:00:00.000Z</LastModified>
    <ETag>&quot;etag-1&quot;</ETag><Size>2048</Size><StorageClass>STANDARD</StorageClass></Contents>
  <Contents><Key>reports/q4.csv</Key><LastModified>2026-01-03T10:00:00.000Z</LastModified>
    <ETag>&quot;etag-2&quot;</ETag><Size>4096</Size><StorageClass>GLACIER</StorageClass></Contents>
  <Contents><Key>archive/</Key><LastModified>2026-01-04T10:00:00.000Z</LastModified>
    <ETag>&quot;etag-3&quot;</ETag><Size>0</Size></Contents>
  <CommonPrefixes><Prefix>photos/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>videos/</Prefix></CommonPrefixes>
</ListBucketResult>`;

  test('reads every object, including one with no StorageClass', () => {
    const blocks = xmlBlocks(LISTING, 'Contents');
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => xmlFirst(b, 'Key'))).toEqual([
      'reports/q3.csv',
      'reports/q4.csv',
      'archive/',
    ]);
    expect(xmlFirst(blocks[0]!, 'Size')).toBe('2048');
    expect(xmlFirst(blocks[1]!, 'StorageClass')).toBe('GLACIER');
    // Absent element, not an empty one.
    expect(xmlFirst(blocks[2]!, 'StorageClass')).toBeUndefined();
  });

  test('reads common prefixes from their wrapper element', () => {
    const prefixes = xmlBlocks(LISTING, 'CommonPrefixes').map((b) => xmlFirst(b, 'Prefix'));
    expect(prefixes).toEqual(['photos/', 'videos/']);
  });

  test('reads pagination fields', () => {
    expect((xmlFirst(LISTING, 'IsTruncated') ?? '').trim()).toBe('true');
    expect(xmlFirst(LISTING, 'NextContinuationToken')).toBe('token-abc');
  });

  test('a false or missing IsTruncated reads as not truncated', () => {
    expect((xmlFirst('<a><IsTruncated>false</IsTruncated></a>', 'IsTruncated') ?? '').trim()).toBe(
      'false',
    );
    expect((xmlFirst('<a></a>', 'IsTruncated') ?? '').trim()).toBe('');
  });
});

describe('CORS configuration shapes the client parses', () => {
  const CORS = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>http://localhost:5173</AllowedOrigin>
    <AllowedOrigin>https://app.example.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader><ExposeHeader>x-amz-request-id</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
  <CORSRule>
    <AllowedOrigin>https://other.example.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <MaxAgeSeconds>60</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

  test('reads each rule independently, so one rule cannot leak into the next', () => {
    const rules = xmlBlocks(CORS, 'CORSRule');
    expect(rules).toHaveLength(2);

    expect(xmlTextValues(rules[0]!, 'AllowedOrigin')).toEqual([
      'http://localhost:5173',
      'https://app.example.com',
    ]);
    expect(xmlTextValues(rules[0]!, 'AllowedMethod')).toEqual(['GET', 'PUT']);
    expect(xmlTextValues(rules[0]!, 'ExposeHeader')).toEqual(['ETag', 'x-amz-request-id']);
    expect(parseInt(xmlFirst(rules[0]!, 'MaxAgeSeconds') ?? '0', 10)).toBe(3600);

    // The second rule has no headers and no expose list.
    expect(xmlTextValues(rules[1]!, 'AllowedHeader')).toEqual([]);
    expect(xmlTextValues(rules[1]!, 'ExposeHeader')).toEqual([]);
    expect(parseInt(xmlFirst(rules[1]!, 'MaxAgeSeconds') ?? '0', 10)).toBe(60);
  });
});

describe('DeleteObjects shapes the client parses', () => {
  const RESULT = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Deleted><Key>gone.txt</Key></Deleted>
  <Deleted><Key>also-gone.txt</Key></Deleted>
  <Error><Key>locked.txt</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>
</DeleteResult>`;

  test('separates deleted keys from errors', () => {
    expect(xmlBlocks(RESULT, 'Deleted').map((b) => xmlFirst(b, 'Key'))).toEqual([
      'gone.txt',
      'also-gone.txt',
    ]);
    const errors = xmlBlocks(RESULT, 'Error').map((b) => ({
      key: xmlFirst(b, 'Key'),
      code: xmlFirst(b, 'Code'),
      message: xmlFirst(b, 'Message'),
    }));
    expect(errors).toEqual([
      { key: 'locked.txt', code: 'AccessDenied', message: 'Access Denied' },
    ]);
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
