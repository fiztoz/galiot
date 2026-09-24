import { describe, expect, test } from 'bun:test';
import { corsConfigToAwsJson, corsConfigToXml, corsRuleToXml } from './corsPolicy';
import { buildCorsRemediation, posixQuote, psQuote, safeDelimiter, type CorsRemediationContext } from './corsRemediation';
import type { CorsConfiguration, CorsRule } from './client';

const rule = (overrides: Partial<CorsRule> = {}): CorsRule => ({
  allowedOrigins: ['http://localhost:5173'],
  allowedMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'],
  allowedHeaders: ['*'],
  exposeHeaders: ['ETag'],
  maxAgeSeconds: 3600,
  ...overrides,
});

const config = (rules: CorsRule[] = [rule()]): CorsConfiguration => ({ rules });

describe('corsRuleToXml', () => {
  test('emits every allowed origin, not just the first', () => {
    const xml = corsRuleToXml(
      rule({ allowedOrigins: ['https://a.example', 'https://b.example', '*'] }),
    );
    expect(xml).toContain('<AllowedOrigin>https://a.example</AllowedOrigin>');
    expect(xml).toContain('<AllowedOrigin>https://b.example</AllowedOrigin>');
    expect(xml).toContain('<AllowedOrigin>*</AllowedOrigin>');
    expect(xml.match(/<AllowedOrigin>/g)).toHaveLength(3);
  });

  test('falls back to a wildcard origin when none is set', () => {
    expect(corsRuleToXml(rule({ allowedOrigins: [] }))).toContain('<AllowedOrigin>*</AllowedOrigin>');
  });

  test('escapes XML metacharacters in every field', () => {
    const xml = corsRuleToXml(
      rule({
        allowedOrigins: ['https://x.example/?a=1&b=2'],
        allowedHeaders: ['<script>'],
        exposeHeaders: ['"ETag"'],
      }),
    );
    expect(xml).toContain('a=1&amp;b=2');
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).toContain('&quot;ETag&quot;');
    expect(xml).not.toMatch(/<script>/);
  });
});

describe('corsConfigToXml', () => {
  test('produces a full document with every rule', () => {
    const xml = corsConfigToXml(config([rule(), rule({ allowedOrigins: ['https://other'] })]));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<CORSConfiguration>');
    expect(xml).toContain('</CORSConfiguration>');
    expect(xml.match(/<CORSRule>/g)).toHaveLength(2);
  });

  test('handles an empty configuration', () => {
    const xml = corsConfigToXml({ rules: [] });
    expect(xml).toContain('<CORSConfiguration>');
    expect(xml).not.toContain('<CORSRule>');
  });
});

describe('corsConfigToAwsJson', () => {
  test('uses the plural keys the AWS CLI expects', () => {
    const json = JSON.parse(corsConfigToAwsJson(config())) as {
      CORSRules: Record<string, unknown>[];
    };
    expect(json.CORSRules).toHaveLength(1);
    const entry = json.CORSRules[0]!;
    expect(entry.AllowedOrigins).toEqual(['http://localhost:5173']);
    expect(entry.AllowedMethods).toEqual(['GET', 'HEAD', 'PUT', 'POST', 'DELETE']);
    expect(entry.AllowedHeaders).toEqual(['*']);
    expect(entry.ExposeHeaders).toEqual(['ETag']);
    expect(entry.MaxAgeSeconds).toBe(3600);
    // The singular XML names must not leak into the JSON.
    expect(entry).not.toHaveProperty('AllowedOrigin');
    expect(entry).not.toHaveProperty('ExposeHeader');
  });

  test('omits empty collections rather than sending invalid empty arrays', () => {
    const json = JSON.parse(
      corsConfigToAwsJson(config([rule({ allowedHeaders: [], exposeHeaders: [] })])),
    ) as { CORSRules: Record<string, unknown>[] };
    expect(json.CORSRules[0]).not.toHaveProperty('AllowedHeaders');
    expect(json.CORSRules[0]).not.toHaveProperty('ExposeHeaders');
  });

  test('is valid JSON for every rule', () => {
    const json = corsConfigToAwsJson(config([rule(), rule({ allowedOrigins: ['*'] })]));
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe('shell quoting', () => {
  test('POSIX quoting survives an embedded single quote', () => {
    expect(posixQuote("it's")).toBe(`'it'\\''s'`);
    expect(posixQuote('a b; rm -rf /')).toBe(`'a b; rm -rf /'`);
  });

  test('PowerShell quoting doubles an embedded single quote', () => {
    expect(psQuote("it's")).toBe(`'it''s'`);
  });

  test('a heredoc delimiter cannot be closed by the payload', () => {
    expect(safeDelimiter('harmless')).toBe('GALIOT_EOF');
    const evil = 'GALIOT_EOF';
    const delimiter = safeDelimiter(evil);
    expect(delimiter).not.toBe('GALIOT_EOF');
    expect(evil.includes(delimiter)).toBe(false);
  });
});

const ctx = {
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'erc2_tpa_dev',
  config: config(),
  presignedUrl:
    'https://s3.example.com/erc2_tpa_dev/?cors=&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret/with+chars=',
  includeSecrets: false,
  shell: 'posix' as const,
};

const option = (id: string, overrides: Partial<CorsRemediationContext> = {}) => {
  const built = buildCorsRemediation({ ...ctx, ...overrides });
  const found = built.find((o) => o.id === id);
  if (!found) throw new Error(`no ${id} option`);
  return found;
};

describe('buildCorsRemediation', () => {
  test('offers curl, mc, aws and the dashboard', () => {
    expect(buildCorsRemediation(ctx).map((o) => o.id)).toEqual([
      'curl',
      'mc',
      'aws',
      'dashboard',
    ]);
  });

  test('curl needs no tooling and carries no secret', () => {
    const curl = option('curl');
    expect(curl.containsSecret).toBe(false);
    expect(curl.script).toContain('curl -X PUT');
    expect(curl.script).toContain('X-Amz-Signature=deadbeef');
    expect(curl.script).toContain("'Content-Type: application/xml'");
    expect(curl.script).toContain('<AllowedOrigin>http://localhost:5173</AllowedOrigin>');
    expect(curl.script).not.toContain(ctx.secretAccessKey);
  });

  test('mc needs no prior alias and prompts for the keys by default', () => {
    const mc = option('mc');
    expect(mc.script).toContain("mc alias set galiot 'http://127.0.0.1:9000'");
    // No key arguments: mc asks for them interactively.
    expect(mc.script).not.toContain(ctx.accessKeyId);
    expect(mc.script).not.toContain(ctx.secretAccessKey);
    expect(mc.script).toContain('mc cors set galiot/erc2_tpa_dev');
    // The alias it creates is removed again.
    expect(mc.script).toContain('mc alias rm galiot');
    expect(mc.containsSecret).toBe(false);
  });

  test('aws needs no profile and prompts for the keys by default', () => {
    const aws = option('aws');
    expect(aws.script).toContain('--endpoint-url');
    expect(aws.script).toContain("'http://127.0.0.1:9000'");
    expect(aws.script).toContain("'erc2_tpa_dev'");
    expect(aws.script).toContain("read -rsp 'Secret access key: '");
    expect(aws.script).toContain('unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY');
    expect(aws.script).not.toContain(ctx.secretAccessKey);
    expect(aws.containsSecret).toBe(false);
  });

  test('aws sends the AWS JSON shape, not XML', () => {
    const aws = option('aws');
    expect(aws.script).toContain('"CORSRules"');
    expect(aws.script).toContain('"AllowedOrigins"');
    expect(aws.script).not.toContain('<CORSConfiguration>');
  });

  test('the file URI is a real file:// URI', () => {
    expect(option('aws').script).toContain('file:///tmp/galiot-cors.json');
  });

  test('includeSecrets fills the keys in and flags that the block now holds them', () => {
    const aws = option('aws', { includeSecrets: true });
    expect(aws.containsSecret).toBe(true);
    expect(aws.script).toContain("export AWS_ACCESS_KEY_ID='AKIAEXAMPLE'");
    // A secret with / + = must survive quoting intact.
    expect(aws.script).toContain("export AWS_SECRET_ACCESS_KEY='secret/with+chars='");

    const mc = option('mc', { includeSecrets: true });
    expect(mc.containsSecret).toBe(true);
    expect(mc.script).toContain("'AKIAEXAMPLE' 'secret/with+chars='");
  });

  test('a quote in the secret cannot break out of the command', () => {
    const aws = option('aws', {
      includeSecrets: true,
      secretAccessKey: "x'; rm -rf ~; echo '",
    });
    // The payload stays inside one quoted argument.
    expect(aws.script).toContain(`export AWS_SECRET_ACCESS_KEY='x'\\''; rm -rf ~; echo '\\'''`);
    expect(aws.script.split('\n').filter((l) => l.includes('rm -rf'))).toHaveLength(1);
  });

  test('a quote in the endpoint is quoted, not executed', () => {
    const mc = option('mc', { endpoint: "http://x.example/'; touch /tmp/pwn; echo '" });
    expect(mc.script).toContain(`'http://x.example/'\\''; touch /tmp/pwn; echo '\\'''`);
  });

  test('a payload containing the heredoc delimiter cannot close the heredoc early', () => {
    const hostile = config([
      rule({ allowedOrigins: ['https://ok.example', 'GALIOT_EOF\nrm -rf ~'] }),
    ]);
    const aws = option('aws', { config: hostile });
    // The delimiter is extended, so the payload line is just data.
    expect(aws.script).toContain('GALIOT_EOF_');
    const lines = aws.script.split('\n');
    const first = lines.findIndex((l) => l.startsWith('cat >'))!;
    expect(lines[first]).toBe("cat > '/tmp/galiot-cors.json' <<GALIOT_EOF_");
  });

  test('PowerShell scripts use Windows conventions and a masked prompt', () => {
    const aws = option('aws', { shell: 'powershell' });
    expect(aws.script).toContain("$env:AWS_ACCESS_KEY_ID = Read-Host 'Access key id'");
    expect(aws.script).toContain('Read-Host -AsSecureString');
    expect(aws.script).toContain('Join-Path $env:TEMP');
    expect(aws.script).toContain("file:///$($corsJson -replace '\\\\', '/')");
    expect(aws.script).not.toContain('/tmp/');
  });

  test('PowerShell mc uses the same interactive alias path', () => {
    const mc = option('mc', { shell: 'powershell' });
    expect(mc.script).toContain("mc alias set galiot 'http://127.0.0.1:9000'");
    expect(mc.script).not.toContain(ctx.secretAccessKey);
  });

  test('the dashboard option carries the JSON for pasting', () => {
    const dashboard = option('dashboard');
    expect(dashboard.script).toBe('');
    expect(dashboard.containsSecret).toBe(false);
  });

  test('every option states what it needs', () => {
    for (const o of buildCorsRemediation(ctx)) {
      expect(o.requires.length).toBeGreaterThan(0);
    }
  });
});
