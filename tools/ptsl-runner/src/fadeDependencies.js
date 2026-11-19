// Crossfade arms can merely touch an outer fade boundary. Strict interval
// overlap alone misses the arm at an asymmetric edit point.
export function fadeUsesClip(fade, clip) {
  if (fade.destinationTrack !== clip.destinationTrack) return false;
  if (Array.isArray(fade.requiredClipNames)) return fade.requiredClipNames.includes(clip.name);
  return fadeTouchesClip(fade, clip);
}

export function fadeTouchesClip(fade, clip) {
  if (fade.destinationTrack !== clip.destinationTrack) return false;
  if (clip.timelineStartSamples < fade.timelineEndSamples && fade.timelineStartSamples < clip.timelineEndSamples) return true;
  const cut=fade.timelineEditBoundarySamples;
  return fade.type==='crossfade' && Number.isSafeInteger(cut)
    && (clip.timelineStartSamples===cut || clip.timelineEndSamples===cut);
}
