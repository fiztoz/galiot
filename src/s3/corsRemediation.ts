import type { CorsConfiguration } from './client';
import { corsConfigToAwsJson, corsConfigToXml } from './corsPolicy';

/**
 * Self-contained CORS remediation commands.
 *
 * The chicken-and-egg this exists to solve: a user cannot configure `mc` or
 * `aws` because they have no profile yet, and they cannot create a profile
 * because the connection fails on CORS. So none of these commands may assume
 * existing configuration. Every one is a complete copy-paste block carrying its
 * own endpoint, bucket, region and policy — no `mc alias set`, no
 * `aws configure`, no hand-written `cors.xml`.
 *
 * Pure string building, so every escaping decision here is unit-tested.
 */

export type RemediationShell = 'posix' | 'powershell';

export interface CorsRemediationContext {
  endpoint: string;
  region: string;
  bucket: string;
  config: CorsConfiguration;
  /** Presigned PutBucketCors URL, for the curl option. */
  presignedUrl: string;
  /**
   * The caller's keys, when it has them. Omitted when the credentials came
   * from the vault as a sealed blob — the main thread never sees them, and the
   * commands then prompt for the keys like the default does.
   */
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Whether to embed the keys in the command. Off by default: a command
   * containing the secret key is written to the user's shell history, so the
   * default scripts prompt for the keys and never put them in the command.
   * Ignored when no keys are available.
   */
  includeSecrets: boolean;
  shell: RemediationShell;
}

export interface RemediationOption {
  id: 'curl' | 'mc' | 'aws' | 'dashboard';
  label: string;
  /** What the user needs for this option to work. */
  requires: string;
  /** The copy-paste block. Empty for the dashboard option. */
  script: string;
  /** True when the block contains the secret key in plaintext. */
  containsSecret: boolean;
}

const XML_DELIMITER_BASE = 'GALIOT_EOF';

/** POSIX single-quoting: the only safe way to embed arbitrary text. */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted strings escape an embedded quote by doubling it. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A heredoc delimiter the payload provably cannot contain.
 *
 * A crafted `AllowedOrigin` could otherwise contain the delimiter and end the
 * heredoc early, turning a policy into arbitrary shell.
 */
export function safeDelimiter(payload: string, base: string = XML_DELIMITER_BASE): string {
  let delimiter = base;
  while (payload.includes(delimiter)) delimiter += '_';
  return delimiter;
}

/**
 * Writes `payload` to a file, POSIX or PowerShell.
 *
 * `fileName` is the bare name (PowerShell joins it onto $env:TEMP and keeps the
 * result in a variable); `resolvedPath` is the concrete POSIX path. Passing the
 * wrong one of the pair produced a script that wrote the policy to the current
 * directory and then read it from /tmp.
 */
function writeFileScript(
  shell: RemediationShell,
  fileVar: string,
  fileName: string,
  resolvedPath: string,
  payload: string,
): string {
  if (shell === 'powershell') {
    // @' … '@ is a literal here-string; its terminator must start at column 0.
    const delimiter = safeDelimiter(payload, "'@");
    return [
      `${fileVar} = Join-Path $env:TEMP ${psQuote(fileName)}`,
      `$cors = @'`,
      payload,
      delimiter,
      `Set-Content -LiteralPath ${fileVar} -Value $cors -NoNewline`,
    ].join('\n');
  }

  const delimiter = safeDelimiter(payload);
  return [`cat > ${posixQuote(resolvedPath)} <<${delimiter}`, payload, delimiter].join('\n');
}

/** A path that works in the chosen shell. */
function filePath(shell: RemediationShell, name: string): string {
  return shell === 'powershell' ? name : `/tmp/${name}`;
}

/** `file://` URI for the AWS CLI, which wants a URI rather than a bare path. */
function fileUri(shell: RemediationShell, path: string): string {
  // PowerShell gets the file's absolute path, with backslashes turned into
  // forward slashes, because `file://C:\…` is not a URI the CLI accepts.
  return shell === 'powershell' ? `"file:///$(${path} -replace '\\\\', '/')"` : `file://${path}`;
}

/**
 * Whether the keys can be embedded, i.e. the caller asked for it *and* has
 * them. Written as a type predicate so the call sites narrow to non-optional.
 */
function canEmbedKeys(
  ctx: CorsRemediationContext,
): ctx is CorsRemediationContext & { accessKeyId: string; secretAccessKey: string } {
  return (
    ctx.includeSecrets &&
    typeof ctx.accessKeyId === 'string' &&
    ctx.accessKeyId.length > 0 &&
    typeof ctx.secretAccessKey === 'string' &&
    ctx.secretAccessKey.length > 0
  );
}

/**
 * Environment setup for the AWS CLI.
 *
 * With the keys embedded, the command contains the secret. Otherwise they are
 * prompted for and never appear in the command — a `read -s` on POSIX, a masked
 * `Read-Host -AsSecureString` on PowerShell. That is the default both because a
 * command line is saved in shell history and because the main thread may not
 * hold the keys at all when they came out of the vault sealed.
 */
function awsCredentialScript(shell: RemediationShell, ctx: CorsRemediationContext): string {
  const region = shell === 'powershell' ? psQuote(ctx.region) : posixQuote(ctx.region);

  if (canEmbedKeys(ctx)) {
    const quote = shell === 'powershell' ? psQuote : posixQuote;
    return [
      `${shell === 'powershell' ? '$env:' : 'export '}AWS_ACCESS_KEY_ID=${quote(ctx.accessKeyId)}`,
      `${shell === 'powershell' ? '$env:' : 'export '}AWS_SECRET_ACCESS_KEY=${quote(ctx.secretAccessKey)}`,
      `${shell === 'powershell' ? '$env:' : 'export '}AWS_DEFAULT_REGION=${region}`,
    ].join('\n');
  }

  if (shell === 'powershell') {
    return [
      `$env:AWS_ACCESS_KEY_ID = Read-Host 'Access key id'`,
      `$env:AWS_SECRET_ACCESS_KEY = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Secret access key')).Password`,
      `$env:AWS_DEFAULT_REGION = ${region}`,
    ].join('\n');
  }

  return [
    `read -rp 'Access key id: ' AWS_ACCESS_KEY_ID`,
    `read -rsp 'Secret access key: ' AWS_SECRET_ACCESS_KEY; echo`,
    `export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY`,
    `export AWS_DEFAULT_REGION=${region}`,
  ].join('\n');
}

/** Clears the credentials the script exported. */
function awsCleanupScript(shell: RemediationShell): string {
  return shell === 'powershell'
    ? `Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue`
    : `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY`;
}

function awsCommand(
  shell: RemediationShell,
  ctx: CorsRemediationContext,
  jsonFile: string,
): string {
  const quote = shell === 'powershell' ? psQuote : posixQuote;
  const cont = shell === 'powershell' ? '`' : '\\';
  // --endpoint-url is always sent: required for MinIO/R2/B2, and for AWS it is
  // the exact endpoint the user typed into Galiot.
  return [
    `aws s3api put-bucket-cors ${cont}`,
    `  --endpoint-url ${quote(ctx.endpoint)} ${cont}`,
    `  --bucket ${quote(ctx.bucket)} ${cont}`,
    `  --cors-configuration ${fileUri(shell, jsonFile)}`,
  ].join('\n');
}

function mcCommand(shell: RemediationShell, ctx: CorsRemediationContext, xmlFile: string): string {
  const quote = shell === 'powershell' ? psQuote : posixQuote;
  // `mc alias set <name> <url>` with no key arguments prompts for both keys
  // interactively. That is the "nothing configured yet" path, and the alias is
  // removed afterwards so nothing is left behind.
  const aliasLine = canEmbedKeys(ctx)
    ? `mc alias set galiot ${quote(ctx.endpoint)} ${quote(ctx.accessKeyId)} ${quote(ctx.secretAccessKey)}`
    : `mc alias set galiot ${quote(ctx.endpoint)}`;

  return [
    aliasLine,
    `mc cors set galiot/${ctx.bucket} ${quote(xmlFile)}`,
    `mc alias rm galiot`,
  ].join('\n');
}

function curlCommand(shell: RemediationShell, ctx: CorsRemediationContext, xmlFile: string): string {
  if (shell === 'powershell') {
    return `curl.exe -X PUT "${ctx.presignedUrl}" -H "Content-Type: application/xml" --data-binary "@${xmlFile}"`;
  }
  return [
    `curl -X PUT ${posixQuote(ctx.presignedUrl)} \\`,
    `  -H 'Content-Type: application/xml' \\`,
    `  --data-binary @${xmlFile}`,
  ].join('\n');
}

export function buildCorsRemediation(ctx: CorsRemediationContext): RemediationOption[] {
  const xml = corsConfigToXml(ctx.config);
  const json = corsConfigToAwsJson(ctx.config);
  const xmlName = 'galiot-cors.xml';
  const jsonName = 'galiot-cors.json';
  const xmlFile = filePath(ctx.shell, xmlName);
  const jsonFile = filePath(ctx.shell, jsonName);

  const writeXml = writeFileScript(ctx.shell, '$corsFile', xmlName, xmlFile, xml);
  const writeJson = writeFileScript(ctx.shell, '$corsJson', jsonName, jsonFile, json);

  return [
    {
      id: 'curl',
      label: 'curl',
      requires: 'Nothing to install or configure — curl is already on your machine',
      script: `${writeXml}\n\n${curlCommand(ctx.shell, ctx, xmlFile)}`,
      // A presigned URL carries a signature scoped to this one request, never
      // the key itself.
      containsSecret: false,
    },
    {
      id: 'mc',
      label: 'MinIO client (mc)',
      requires: 'The mc binary — no alias or profile configured',
      script: `${writeXml}\n\n${mcCommand(ctx.shell, ctx, xmlFile)}`,
      containsSecret: canEmbedKeys(ctx),
    },
    {
      id: 'aws',
      label: 'AWS CLI (aws)',
      requires: 'The aws binary — no profile configured',
      script: [
        writeJson,
        '',
        awsCredentialScript(ctx.shell, ctx),
        '',
        awsCommand(ctx.shell, ctx, ctx.shell === 'powershell' ? '$corsJson' : jsonFile),
        '',
        awsCleanupScript(ctx.shell),
      ].join('\n'),
      containsSecret: canEmbedKeys(ctx),
    },
    {
      id: 'dashboard',
      label: 'Provider dashboard',
      requires: 'Your provider’s web console — paste this JSON',
      script: '',
      containsSecret: false,
    },
  ];
}
