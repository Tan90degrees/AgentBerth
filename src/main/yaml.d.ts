declare module 'js-yaml' {
  export const JSON_SCHEMA: unknown;
  export function load(text: string, options?: { schema?: unknown; json?: boolean }): unknown;
  export function dump(value: unknown, options?: { schema?: unknown; noRefs?: boolean; sortKeys?: boolean; lineWidth?: number }): string;
}
