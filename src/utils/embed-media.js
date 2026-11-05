// Lets a third-party player in an iframe stand in for the <video> element. The
// real element stays mounted and hidden: its media properties are overridden and
// the iframe's messages become ordinary media events on it, so the player's
// controls, progress saving and room sync work without knowing the difference.
const OVERRIDES = ["currentTime", "duration", "paused", "ended", "seeking", "readyState", "buffered", "play", "pause"];
const EMPTY_RANGES = { length: 0, start: () => 0, end: () => 0 };
const SEEK_ANSWER_MS = 4000;

function parseMessage(data) {
  try {
    const message = typeof data === "string" ? JSON.parse(data) : data;
    return typeof message?.event === "string" ? message : null;
  } catch {
    return null;
  }
}

export function createEmbedMedia({ video, frame, url, onReady, target = window }) {
  const origin = new URL(url).origin;
  let time = 0, duration = NaN, paused = true, ended = false, seeking = false;
  let ready = false, responded = false, wantsPlay = false, destroyed = false, metadataSent = false, seekTimer;

  const fire = (type) => video.dispatchEvent(new Event(type));
  // The player only understands commands sent as JSON strings.
  const send = (command) => frame.contentWindow?.postMessage(JSON.stringify(command), origin);
  const finishSeek = () => {
    clearTimeout(seekTimer);
    if (!seeking) return;
    seeking = false;
    fire("seeked");
  };

  const properties = {
    currentTime: { get: () => time, set: (value) => {
      time = value;
      seeking = true;
      clearTimeout(seekTimer);
      seekTimer = setTimeout(finishSeek, SEEK_ANSWER_MS);
      fire("seeking");
      send({ api: "seek", value });
    } },
    duration: { get: () => duration },
    paused: { get: () => paused },
    ended: { get: () => ended },
    seeking: { get: () => seeking },
    readyState: { get: () => (ready ? 4 : 0) },
    buffered: { get: () => EMPTY_RANGES },
    play: { value: () => {
      wantsPlay = true;
      send({ api: "play" });
      return Promise.resolve();
    } },
    pause: { value: () => {
      wantsPlay = false;
      send({ api: "pause" });
    } },
  };
  for (const name of OVERRIDES) Object.defineProperty(video, name, { configurable: true, ...properties[name] });

  const markReady = () => {
    ready = true;
    send({ api: "duration" });
    onReady?.();
  };

  const onMessage = (event) => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    const message = parseMessage(event.data);
    if (!message) return;
    if (!responded) {
      responded = true;
      // Sent before the frame had loaded, the first play request was lost.
      if (wantsPlay) send({ api: "play" });
    }
    const value = Number(message.time);
    if (message.event === "timeupdate") {
      // A tick already in flight when a seek was sent still carries the old time.
      if (!Number.isFinite(value) || seeking) return;
      time = value;
      ended = false;
      if (!ready && value > 0) markReady();
      if (ready && !Number.isFinite(duration)) send({ api: "duration" });
      fire("timeupdate");
    } else if (message.event === "play") {
      paused = false;
      ended = false;
      fire("play");
      fire("playing");
    } else if (message.event === "pause") {
      paused = true;
      fire("pause");
    } else if (message.event === "seek") {
      if (Number.isFinite(value)) time = value;
      seeking = true; // the viewer may have seeked inside the frame's own menus
      finishSeek();
      fire("timeupdate");
    } else if (message.event === "duration") {
      if (Number.isFinite(value) && value > 0) {
        duration = value;
        fire("durationchange");
        if (ready && !metadataSent) {
          metadataSent = true;
          for (const type of ["loadedmetadata", "loadeddata", "canplay"]) fire(type);
        }
      }
    } else if (message.event === "ended") {
      paused = true;
      ended = true;
      fire("ended");
    }
  };
  target.addEventListener("message", onMessage);

  return {
    get responded() { return responded; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(seekTimer);
      target.removeEventListener("message", onMessage);
      for (const name of OVERRIDES) delete video[name];
    },
  };
}
