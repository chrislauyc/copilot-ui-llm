/**
 * Decision logic for whether the app is running under AI Studio (and
 * should therefore use the native runner instead of Docker). Pure: reads
 * only `process.env`, no `fs`/`child_process`/network access -- the second
 * reference case for the `*.pure.ts` convention (issue #320), alongside
 * `buildAuditorSessionSettingsPure` in `src/utils/auditorHelper.pure.ts`.
 */
export function isAIStudio(): boolean {
  return process.env.AI_STUDIO === "true" || process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}
