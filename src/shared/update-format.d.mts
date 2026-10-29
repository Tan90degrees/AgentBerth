export interface UpdateManifest {
  schema: 1; bootstrap: 1; version: string; electron: string; platform: 'win32'; arch: 'x64'; protocol: 1; minimumBackendApi: number;
  bundle: { name: string; size: number; sha256: string };
  files: { path: string; size: number; sha256: string }[];
}
export const UPDATE_SCHEMA: 1;
export const UPDATE_BOOTSTRAP: 1;
export const RELEASE_REPOSITORY: string;
export const RELEASE_API: string;
export const RELEASES_URL: string;
export function stableVersion(value: unknown): string;
export function compareVersions(a: string, b: string): number;
export function updateNames(version: string): { bundle: string; manifest: string };
export function updatePath(value: unknown): string;
export function parseUpdateManifest(value: unknown): UpdateManifest;
export function releaseAsset(release: unknown, name: string): { name: string; size: number; browser_download_url: string };
