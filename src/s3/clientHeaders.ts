/** A write precondition must identify one strong entity tag. */
export function isStrongETag(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value);
}
