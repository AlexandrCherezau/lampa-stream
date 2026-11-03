// Off-screen laughter and applause in a Watch Together room. Web Audio, because a
// sound here starts from someone else's press: iOS lets an <audio> element play only
// inside a gesture on this page, while an AudioContext stays unlocked after the first.

const SOURCES = {
  laugh: "sounds/laugh.mp3",
  applause: "sounds/applause.mp3",
};
const VOLUME = 0.6; // Over the film, not instead of it.
const MAX_AT_ONCE = 2;

export function createRoomSounds() {
  let context = null;
  const buffers = {};
  const playing = {};

  const ready = () => {
    if (!context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return null;
      context = new Context();
    }
    if (context.state === "suspended") context.resume().catch(() => {});
    return context;
  };

  const load = (id) => {
    buffers[id] ??= fetch(`${import.meta.env.BASE_URL}${SOURCES[id]}`)
      .then((response) => response.arrayBuffer())
      .then((data) => ready().decodeAudioData(data))
      .catch(() => { delete buffers[id]; return null; });
    return buffers[id];
  };

  return {
    // Call from a gesture: this is what unlocks audio for later sounds.
    unlock: ready,
    preload: () => { if (ready()) Object.keys(SOURCES).forEach(load); },
    async play(id) {
      if (!SOURCES[id] || !ready() || (playing[id] || 0) >= MAX_AT_ONCE) return;
      const buffer = await load(id);
      if (!buffer) return;
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = VOLUME;
      source.buffer = buffer;
      source.connect(gain).connect(context.destination);
      playing[id] = (playing[id] || 0) + 1;
      source.onended = () => { playing[id] -= 1; };
      source.start();
    },
    close() { context?.close().catch(() => {}); context = null; },
  };
}
