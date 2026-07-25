/** Minimal `unknown`-narrowing helpers for parsing wire JSON, mirroring the pattern established
 * by src/agent-cli-provider/json.ts: narrow field-by-field with `typeof`/predicate guards instead
 * of casting, so the compiler (and `@typescript-eslint/no-unsafe-type-assertion`) can verify each
 * step. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
