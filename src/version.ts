/** Filled in by the build from package.json (see scripts/build.mjs), so there is one version number. */
declare const __AEGIS_VERSION__: string | undefined;
export const VERSION: string = typeof __AEGIS_VERSION__ === 'string' ? __AEGIS_VERSION__ : '0.0.0-dev';
