// True only when a validated playing sample naturally advances across a known
// media time. Callers reset the prior sample on seek, pause, or buffering.
export function crossedPlaybackPosition(previousTime, currentTime, target, wallElapsed) {
  const values = [previousTime, currentTime, target, wallElapsed];
  if (!values.every(Number.isFinite) || target < 0 || wallElapsed <= 0 || wallElapsed > 2200) return false;
  const mediaElapsed = currentTime - previousTime;
  if (mediaElapsed <= 0.08 || mediaElapsed > wallElapsed / 1000 * 2.2 + 0.15) return false;
  return previousTime < target && currentTime >= target;
}

// True only when a validated playing sample naturally advances across the
// watched threshold. A jump to the end cannot satisfy the media-clock bound.
export function crossedWatchedThreshold(previousTime, currentTime, duration, threshold, wallElapsed) {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  const usableThreshold = Math.min(Math.max(0, threshold), duration * 0.5);
  const boundary = duration - usableThreshold;
  return crossedPlaybackPosition(previousTime, currentTime, boundary, wallElapsed);
}

// A native ended event can arrive after a resume seek without the sampler ever
// crossing the watched threshold. Require real, validated playback samples so
// an initial seek to the tail cannot create a completed episode/movie.
export function hasGenuinePlaybackForEnd(playedMediaSeconds, duration) {
  if (!Number.isFinite(playedMediaSeconds) || playedMediaSeconds <= 0) return false;
  const minimum = Number.isFinite(duration) && duration > 0 ? Math.min(2, duration * 0.02) : 2;
  return playedMediaSeconds >= minimum;
}

export function shouldApplyResumePosition({ position, progressPercent, hasExplicitCheckpoint = false, duration = Infinity, completedPercent = 95, completedTailSeconds = 10 } = {}) {
  if (!Number.isFinite(position) || position < 0.5) return false;
  // A checkpoint stores an exact paused position. The legacy "start over when
  // almost finished" heuristic only applies to old percentage/time maps.
  if (hasExplicitCheckpoint) return true;
  if (typeof progressPercent === "number" && progressPercent >= completedPercent) return false;
  if (Number.isFinite(duration) && position > duration - completedTailSeconds) return false;
  return true;
}
