// Lets a third-party player in an iframe stand in for the <video> element. The
// real element stays mounted and hidden: its media properties are overridden and
// the iframe's messages become ordinary media events on it, so the player's
// controls, progress saving and room sync work without knowing the difference.
const OVERRIDES = ["currentTime", "duration", "paused", "ended", "seeking", "readyState", "buffered", "play", "pause"];
const EMPTY_RANGES = { length: 0, start: () => 0, end: () => 0 };
const SEEK_ANSWER_MS = 4000;
const PLAY_RETRY_MS = 1000;
const PLAY_RETRIES = 10;

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
  let ready = false, responded = false, wantsPlay = false, destroyed = false, metadataSent = false, seekTimer, playRetry;

  const fire = (type) => video.dispatchEvent(new Event(type));
  // The player only understands commands sent as JSON strings.
  const stopPlayRetry = () => clearInterval(playRetry);
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
      stopPlayRetry();
      send({ api: "pause" });
    } },
  };
  for (const name of OVERRIDES) Object.defineProperty(video, name, { configurable: true, ...properties[name] });

  const markReady = () => {
    ready = true;
    send({ api: "duration" });
    onReady?.();
  };

  // The player is silent until it plays and registers its listener some time after
  // load, so an early command is lost and a waiting player looks like a dead one.
  const onLoad = () => {
    responded = true;
    if (!wantsPlay) return;
    send({ api: "play" });
    let retries = 0;
    stopPlayRetry();
    playRetry = setInterval(() => {
      send({ api: "play" });
      retries += 1;
      if (retries >= PLAY_RETRIES) stopPlayRetry();
    }, PLAY_RETRY_MS);
  };
  frame.addEventListener("load", onLoad);

  const onMessage = (event) => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    const message = parseMessage(event.data);
    if (!message) return;
    if (!responded) {
      responded = true;
      // Sent before the frame had loaded, the first play request was lost.
      if (wantsPlay) send({ api: "play" });
    }
    if (message.event === "play" || message.event === "timeupdate") stopPlayRetry();
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
      stopPlayRetry();
      frame.removeEventListener("load", onLoad);
      target.removeEventListener("message", onMessage);
      for (const name of OVERRIDES) delete video[name];
    },
  };
}
