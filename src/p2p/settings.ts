// Shared per-call settings. Both parties see and control ONE settings object
// per call (reset to defaults each call); changes sync over the call's control
// data channel with per-key last-writer-wins (see network.ts).
//
// To add a future setting: extend CallSettings, DEFAULT_SETTINGS, and
// SETTING_VALIDATORS, then handle its side effect in Network.settingChanged.

export const VIDEO_QUALITIES = ['auto', 'high', 'medium', 'low'] as const
export type VideoQuality = (typeof VIDEO_QUALITIES)[number]

export interface CallSettings {
  videoQuality: VideoQuality
}

export const DEFAULT_SETTINGS: CallSettings = {videoQuality: 'auto'}

/** Encoder caps for each preset, applied by EACH side to its own outgoing
 *  video (the setting is symmetric). 'auto' clears all caps and leaves
 *  adaptation entirely to the browser's congestion control; the others are
 *  proactive ceilings for slow or metered links. */
export const QUALITY_PARAMS: Record<
  VideoQuality,
  {maxBitrate?: number; scaleResolutionDownBy?: number; maxFramerate?: number}
> = {
  auto: {},
  high: {maxBitrate: 2_500_000, maxFramerate: 30},
  medium: {maxBitrate: 800_000, scaleResolutionDownBy: 2, maxFramerate: 24},
  low: {maxBitrate: 200_000, scaleResolutionDownBy: 4, maxFramerate: 15}
}

/** Settings arrive over the network, so every value is validated before use. */
export const SETTING_VALIDATORS: {
  [K in keyof CallSettings]: (v: unknown) => v is CallSettings[K]
} = {
  videoQuality: (v): v is VideoQuality =>
    (VIDEO_QUALITIES as readonly unknown[]).includes(v)
}
