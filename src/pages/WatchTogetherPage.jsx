// Watch Together: create or join a room by link or code, watch in sync, chat and
// react. See utils/watchParty.js for the connection and the sync itself.

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import OnlinePlayer from "../components/OnlinePlayer";
import { CloseIcon, ListIcon, SearchIcon, SendIcon, UsersIcon } from "../components/Icons";
import { imgUrl, tmdbFetch } from "../utils/api";
import { storage, STORAGE_KEYS } from "../utils/storage";
import { RoomConnection, createRoom, expectedPosition, fetchRoom, getWtPeerSecret, normalizeRoomCode } from "../utils/watchParty";

const REACTIONS = ["😂", "😮", "😢", "🔥", "❤️"];
const TOAST_MS = 3000;
const REACTION_MS = 2600;
const FLASH_MS = 5000;
const STATUS_DEBOUNCE_MS = 800;
const SAME_POSITION_S = 1;
// A play or pause keeps the room's position unless this viewer is about level with it.
const OWN_POSITION_S = 2;
const DETAILS_WAIT_MS = 2000;
// Releases of one film differ by seconds; beyond this it is another cut.
const OTHER_CUT_S = 60;

const ERRORS = {
  not_allowed: "Сейчас управляет только ведущий",
  too_fast: "Не так быстро",
  network: "Нет связи, попробуйте ещё раз",
};

// Space on a reaction or an arrow in a list must not reach the player's hotkeys.
const keepKeysHere = (event) => event.stopPropagation();

const firstLetter = (name) => (name || "?").trim().charAt(0).toUpperCase() || "?";

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const episodeLabel = (media) => (media?.type === "tv" ? `Сезон ${media.season}, серия ${media.episode}` : "");

function nextEpisode(details, media) {
  if (media?.type !== "tv") return null;
  const seasons = (details?.seasons || []).filter((s) => s.season_number > 0);
  const current = seasons.find((s) => s.season_number === media.season);
  if (current && media.episode < current.episode_count) return { season: media.season, episode: media.episode + 1 };
  const following = seasons.find((s) => s.season_number > media.season);
  return following ? { season: following.season_number, episode: 1 } : null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch { /* no clipboard at all */ }
    area.remove();
    return copied;
  }
}

// ── Page: choose or restore a room, then show it ─────────────────────────────
export default function WatchTogetherPage({ apiKey, initialCode = null, onInitialCodeUsed }) {
  const secret = useMemo(() => getWtPeerSecret(), []);
  const [name, setName] = useState(() => storage.get(STORAGE_KEYS.WT_NAME) || "");
  const [code, setCode] = useState(null);
  const [invite, setInvite] = useState(null);
  const [joinInput, setJoinInput] = useState(initialCode || "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(!!initialCode || !!storage.get(STORAGE_KEYS.WT_LAST_CODE));

  const saveName = () => {
    const clean = name.trim();
    storage.set(STORAGE_KEYS.WT_NAME, clean);
    return clean;
  };

  const enter = useCallback((roomCode) => {
    storage.set(STORAGE_KEYS.WT_LAST_CODE, roomCode);
    setInvite(null);
    setMessage("");
    setCode(roomCode);
  }, []);

  // An invitation shows who invites and to what. A remembered room is rejoined at
  // once, so a reload or a trip to another tab does not throw anyone out.
  useEffect(() => {
    const invited = initialCode ? normalizeRoomCode(initialCode) : null;
    const last = storage.get(STORAGE_KEYS.WT_LAST_CODE);
    const target = invited || last;
    if (!target || !secret) { setBusy(false); return undefined; }
    if (invited) onInitialCodeUsed?.();
    let active = true;
    fetchRoom(secret, target)
      .then(({ room }) => {
        if (!active) return;
        if (!room) {
          if (invited) setMessage("Комната не найдена. Возможно, её уже закрыли.");
          storage.remove(STORAGE_KEYS.WT_LAST_CODE);
        } else if (invited && target !== last) setInvite(room);
        else enter(target);
      })
      .catch(() => {
        if (!active) return;
        setJoinInput(target);
        setMessage("Не удалось связаться с сервером комнат. Нажмите «Войти», чтобы попробовать ещё раз.");
      })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
    // Runs for the code the page opened with; later visits start from storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    const hostName = saveName();
    setBusy(true);
    setMessage("");
    try {
      enter(await createRoom(secret, hostName || "Ведущий"));
    } catch {
      setMessage("Не удалось создать комнату. Проверьте соединение и попробуйте ещё раз.");
    }
    setBusy(false);
  };

  const join = async (event) => {
    event?.preventDefault();
    const target = normalizeRoomCode(joinInput);
    if (!target) { setMessage("Введите код комнаты."); return; }
    saveName();
    setBusy(true);
    setMessage("");
    try {
      const { room } = await fetchRoom(secret, target);
      if (room) enter(target);
      else setMessage("Комната не найдена. Проверьте код.");
    } catch {
      setMessage("Не удалось связаться с сервером комнат. Попробуйте ещё раз.");
    }
    setBusy(false);
  };

  const exit = useCallback((why = "") => {
    storage.remove(STORAGE_KEYS.WT_LAST_CODE);
    setCode(null);
    setJoinInput("");
    setMessage(why);
  }, []);

  if (code) return <Room key={code} code={code} secret={secret} name={name.trim()} apiKey={apiKey} onExit={exit} />;

  const nameField = (
    <label className="wt-field">
      <span>Как вас назвать</span>
      <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="Имя видно остальным" autoComplete="nickname" />
    </label>
  );

  if (invite) {
    const inviter = invite.who[invite.hostId]?.name;
    const others = Object.keys(invite.who).length;
    return (
      <div className="fade-in wt-landing">
        <form className="wt-invite" onSubmit={(e) => { e.preventDefault(); saveName(); enter(invite.code); }}>
          {invite.media?.posterPath && <img className="wt-invite__poster" src={imgUrl(invite.media.posterPath, "w342")} alt="" />}
          <div className="wt-invite__body">
            <p className="wt-kicker">{inviter ? `${inviter} зовёт смотреть вместе` : "Вас зовут смотреть вместе"}</p>
            <h1 className="wt-invite__title">{invite.media?.title || "Фильм ещё выбирают"}</h1>
            {invite.media && <p className="wt-muted">{[episodeLabel(invite.media), others ? `в комнате: ${others}` : ""].filter(Boolean).join(" · ")}</p>}
            {nameField}
            <button className="btn btn-primary" type="submit">Присоединиться</button>
            <button className="btn btn-ghost" type="button" onClick={() => { setInvite(null); setJoinInput(""); }}>Не сейчас</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="fade-in wt-landing">
      <header className="wt-landing__head">
        <h1>Смотрим вместе</h1>
        <p className="wt-muted">Один фильм на всех: пауза и перемотка срабатывают у каждого сразу, а реакции и чат видны прямо во время просмотра.</p>
      </header>
      {busy && !message ? (
        <div className="loader"><div className="spinner" /></div>
      ) : (
        <div className="wt-landing__grid">
          <section className="wt-card">
            <h2>Новая комната</h2>
            <p className="wt-muted">Выберите фильм и отправьте другу ссылку.</p>
            {nameField}
            <button className="btn btn-primary" onClick={create} disabled={busy || !apiKey}>Создать комнату</button>
            {!apiKey && <p className="wt-muted">Чтобы выбирать фильмы, нужен токен TMDB в настройках. Войти по коду можно и без него.</p>}
          </section>
          <form className="wt-card" onSubmit={join}>
            <h2>У меня есть код</h2>
            <p className="wt-muted">Шесть символов из приглашения.</p>
            <label className="wt-field">
              <span>Код комнаты</span>
              <input className="wt-code-input" value={joinInput} maxLength={12} onChange={(e) => setJoinInput(e.target.value.toUpperCase())} placeholder="ABC123" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
            </label>
            <button className="btn btn-secondary" type="submit" disabled={busy}>Войти</button>
          </form>
        </div>
      )}
      {message && <p className="wt-message" role="status">{message}</p>}
    </div>
  );
}

// ── Room ─────────────────────────────────────────────────────────────────────
function Room({ code, secret, name, apiKey, onExit }) {
  const [room, setRoom] = useState(null);
  const [me, setMe] = useState(null);
  const [link, setLink] = useState("connecting");
  const [fetched, setFetched] = useState({ key: null, data: null });
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [floats, setFloats] = useState([]);
  const [notes, setNotes] = useState([]);
  const [flash, setFlash] = useState(null);
  const [nextOffer, setNextOffer] = useState(null);
  const [chatInput, setChatInput] = useState("");
  const connRef = useRef(null);
  const chatRef = useRef(null);
  const toastTimer = useRef(null);
  const flashTimer = useRef(null);
  const statusTimer = useRef(null);
  const lastStatus = useRef("");
  const currentStatus = useRef(null);
  const seenPlay = useRef(null);
  const seenRev = useRef(null);
  const seenChat = useRef(null);
  const noteId = useRef(0);
  const floatId = useRef(0);

  const say = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), TOAST_MS);
  }, []);

  useEffect(() => {
    const addNote = (text) => {
      noteId.current += 1;
      setNotes((list) => [...list.slice(-20), { id: `note-${noteId.current}`, text, ts: connRef.current?.now() ?? Date.now() }]);
    };
    const conn = new RoomConnection({
      code, secret, name,
      onRoom: (next) => { setRoom(next); setMe(conn.peerId); },
      onLink: (state) => {
        setLink(state);
        // The server may have restarted without what was last reported.
        if (state === "live" && currentStatus.current) {
          lastStatus.current = JSON.stringify(currentStatus.current);
          conn.send({ t: "status", ...currentStatus.current });
        }
      },
      onClosed: (reason) => onExit(reason === "room_full" ? "В комнате уже нет мест." : "Комната закрыта."),
      onEvent: (event) => {
        if (event.type === "reaction") {
          floatId.current += 1;
          const id = floatId.current;
          setFloats((list) => [...list.slice(-12), { id, emoji: event.emoji, left: 10 + Math.random() * 80 }]);
          setTimeout(() => setFloats((list) => list.filter((f) => f.id !== id)), REACTION_MS);
        } else if (event.type === "joined" && event.by !== conn.peerId) addNote(`${event.name} присоединяется`);
        else if (event.type === "left" && event.by !== conn.peerId) addNote(`${event.name} выходит из комнаты`);
        else if (event.type === "error" && ERRORS[event.error]) say(ERRORS[event.error]);
      },
    });
    connRef.current = conn;
    conn.start();
    const timers = { toast: toastTimer, flash: flashTimer, status: statusTimer };
    return () => {
      conn.stop();
      connRef.current = null;
      Object.values(timers).forEach((timer) => clearTimeout(timer.current));
    };
    // The name is sent when connecting; the room does not reconnect while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, secret]);

  const media = room?.media || null;
  const play = room?.play || null;
  const isHost = !!room && room.hostId === me;
  const canControl = !!room && (room.control === "all" || isHost);
  const peers = useMemo(() => Object.entries(room?.who || {})
    .map(([id, peer]) => ({ id, ...peer, host: id === room.hostId, mine: id === me }))
    .sort((a, b) => a.joinedAt - b.joinedAt), [room?.who, room?.hostId, me]);

  // Say what someone else just did, and show their messages over a fullscreen video.
  useEffect(() => {
    if (!play) return;
    const previous = seenPlay.current;
    seenPlay.current = play;
    if (!previous || play.seq === previous.seq || !play.by || play.by === me || room.rev !== seenRev.current) return;
    const who = room.who[play.by]?.name || "Кто-то";
    if (play.playing !== previous.playing) say(`${who}: ${play.playing ? "продолжаем" : "пауза"}`);
    else if (Math.abs(play.position - expectedPosition(previous, connRef.current?.now() ?? Date.now())) > 5) say(`${who}: перемотка на ${clock(play.position)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play?.seq]);

  useEffect(() => {
    if (!room) return;
    const previous = seenRev.current;
    seenRev.current = room.rev;
    setNextOffer(null);
    if (previous != null && room.rev !== previous && room.media && room.play.by !== me) {
      const who = room.who[room.play.by]?.name || "Кто-то";
      say(`${who}: ${room.media.title}${room.media.type === "tv" ? `, ${episodeLabel(room.media).toLowerCase()}` : ""}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.rev]);

  const lastMessage = room?.chat?.at(-1);
  useEffect(() => {
    if (!lastMessage) return;
    const previous = seenChat.current;
    seenChat.current = lastMessage.id;
    if (previous == null || lastMessage.id === previous || lastMessage.by === me) return;
    setFlash(lastMessage);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessage?.id]);

  const timeline = useMemo(() => [...(room?.chat || []), ...notes].sort((a, b) => a.ts - b.ts), [room?.chat, notes]);
  const lastLine = timeline.at(-1)?.id;
  useEffect(() => {
    const box = chatRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lastLine]);

  // The player starts once details are known (or late), because its source search
  // restarts when they change under it.
  const mediaKey = media ? `${media.type}:${media.tmdbId}` : null;
  useEffect(() => {
    if (!mediaKey || !apiKey || fetched.key === mediaKey) return undefined;
    let active = true;
    const settle = (data) => {
      if (!active) return;
      active = false;
      setFetched({ key: mediaKey, data });
    };
    const timer = setTimeout(() => settle(null), DETAILS_WAIT_MS);
    tmdbFetch(`/${media.type}/${media.tmdbId}`, apiKey).then(settle).catch(() => settle(null));
    return () => { active = false; clearTimeout(timer); };
  }, [mediaKey, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const details = fetched.key === mediaKey ? fetched.data : null;
  const playerReady = !!media && (!apiKey || fetched.key === mediaKey);

  // Everything the player needs to find the title, so a guest needs no TMDB token.
  const playerItem = useMemo(() => {
    if (!media) return null;
    const movie = media.type === "movie";
    return {
      id: media.tmdbId,
      media_type: media.type,
      poster_path: media.posterPath,
      imdb_id: media.imdbId || undefined,
      runtime: media.runtime || undefined,
      original_language: media.originalLanguage || undefined,
      ...(movie
        ? { title: media.title, original_title: media.originalTitle || undefined, release_date: media.releaseDate || undefined }
        : { name: media.title, original_name: media.originalTitle || undefined, first_air_date: media.releaseDate || undefined }),
    };
  }, [media]);

  const syncClock = useCallback(() => connRef.current?.now() ?? Date.now(), []);

  const onPlaybackState = useCallback((state) => {
    const conn = connRef.current;
    const current = conn?.room;
    if (!current?.media) return;
    const expected = expectedPosition(current.play, conn.now());
    const position = state.seeked || Math.abs(state.position - expected) < OWN_POSITION_S ? state.position : expected;
    const unchanged = state.playing === current.play.playing
      && Math.abs(state.rate - current.play.rate) < 0.01
      && Math.abs(position - expected) < SAME_POSITION_S;
    if (unchanged) return;
    const play = { playing: state.playing, position, rate: state.rate };
    conn.setPlayLocally({ ...play, updatedAt: conn.now(), by: conn.peerId });
    conn.send({ t: "play", ...play, rev: current.rev }).then((result) => {
      if (result?.error && ERRORS[result.error]) say(ERRORS[result.error]);
    });
  }, [say]);

  const onSyncStatus = useCallback((status) => {
    currentStatus.current = status;
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => {
      const key = JSON.stringify(status);
      if (key === lastStatus.current) return;
      lastStatus.current = key;
      connRef.current?.send({ t: "status", ...status });
    }, STATUS_DEBOUNCE_MS);
  }, []);

  const sendMedia = async (next) => {
    const result = await connRef.current?.send({ t: "media", media: next });
    if (result?.error) say(ERRORS[result.error] || "Не удалось выбрать фильм");
  };

  const pickTitle = async (result) => {
    setPickerOpen(false);
    const tv = result.media_type === "tv";
    let full = null;
    try {
      full = await tmdbFetch(`/${result.media_type}/${result.id}?append_to_response=external_ids`, apiKey);
    } catch { /* the search result alone is enough to play */ }
    await sendMedia({
      type: result.media_type,
      tmdbId: result.id,
      title: result.title || result.name,
      originalTitle: result.original_title || result.original_name || null,
      originalLanguage: result.original_language || null,
      releaseDate: result.release_date || result.first_air_date || null,
      posterPath: result.poster_path || null,
      imdbId: full?.imdb_id || full?.external_ids?.imdb_id || null,
      runtime: full?.runtime || null,
      ...(tv ? { season: 1, episode: 1 } : {}),
    });
    if (tv) setEpisodesOpen(true);
  };

  const pickEpisode = (season, episode) => {
    setEpisodesOpen(false);
    sendMedia({ ...media, season, episode });
  };

  const invite = async () => {
    const url = `${location.origin}/?room=${encodeURIComponent(code)}`;
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title: "Смотрим вместе", text: media ? `Смотрим «${media.title}»` : "Смотрим вместе", url });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    say(await copyText(url) ? "Ссылка скопирована" : `Код комнаты: ${code}`);
  };

  const copyCode = async () => say(await copyText(code) ? "Код скопирован" : `Код комнаты: ${code}`);

  const sendChat = async (event) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    setChatInput("");
    const result = await connRef.current?.send({ t: "chat", text });
    if (result?.error) {
      setChatInput((current) => current || text);
      say(ERRORS[result.error] || "Сообщение не отправилось");
    }
  };

  const leave = async () => {
    const conn = connRef.current;
    await Promise.race([conn?.send({ t: "leave" }), new Promise((resolve) => { setTimeout(resolve, 300); })]);
    onExit();
  };

  const closeRoom = () => {
    if (window.confirm("Закрыть комнату для всех?")) connRef.current?.send({ t: "close" });
  };

  const onNext = useCallback(() => {
    const current = connRef.current?.room?.media;
    setNextOffer(nextEpisode(details, current));
  }, [details]);

  const mine = peers.find((peer) => peer.mine);
  const otherCut = mine?.duration
    ? peers.find((peer) => !peer.mine && peer.duration && Math.abs(peer.duration - mine.duration) > OTHER_CUT_S)
    : null;
  const waitingFor = peers.filter((peer) => !peer.mine && peer.buffering).map((peer) => peer.name);

  const overlay = (
    <div className="wt-overlay">
      {floats.map((float) => <span key={float.id} className="wt-float" style={{ left: `${float.left}%` }}>{float.emoji}</span>)}
      {toast && <div className="wt-toast" role="status">{toast}</div>}
      {flash && <div className="wt-flash"><b>{flash.name}</b> {flash.text}</div>}
      {nextOffer && canControl && (
        <button type="button" className="btn btn-primary wt-next" onClick={() => pickEpisode(nextOffer.season, nextOffer.episode)}>
          Следующая серия: {nextOffer.episode}{nextOffer.season !== media?.season ? `, сезон ${nextOffer.season}` : ""}
        </button>
      )}
    </div>
  );

  if (!room) {
    return (
      <div className="wt-room wt-room--loading">
        <div className="loader"><div className="spinner" /></div>
        <p className="wt-muted">{link === "lost" ? "Нет связи, пробуем подключиться…" : "Подключаемся к комнате…"}</p>
        <button className="btn btn-ghost" onClick={() => onExit()}>Отмена</button>
      </div>
    );
  }

  return (
    <div className="fade-in wt-room">
      <header className="wt-bar" onKeyDown={keepKeysHere}>
        <button className="wt-icon wt-bar__leave" onClick={leave} aria-label="Выйти из комнаты" title="Выйти из комнаты"><CloseIcon /></button>
        <div className="wt-bar__title">
          <strong>{media?.title || "Смотрим вместе"}</strong>
          <span className="wt-muted">
            {episodeLabel(media) || (room.control === "host" && !isHost ? "Управляет ведущий" : "Управляют все")}
          </span>
        </div>
        <button className="wt-code" onClick={copyCode} title="Скопировать код комнаты">{code}</button>
        <button className="wt-avatars" aria-label={`Участники: ${peers.length}`} aria-expanded={peopleOpen} onClick={() => setPeopleOpen((open) => !open)}>
          {peers.slice(0, 4).map((peer) => <span key={peer.id} className={"wt-avatar" + (peer.host ? " is-host" : "")}>{firstLetter(peer.name)}</span>)}
          {peers.length > 4 && <span className="wt-avatar">+{peers.length - 4}</span>}
        </button>
        {canControl && media?.type === "tv" && !!apiKey && (
          <button className="btn btn-ghost wt-bar__btn" onClick={() => setEpisodesOpen((open) => !open)} aria-label="Серии" title="Серии"><ListIcon /><span>Серии</span></button>
        )}
        {canControl && !!apiKey && media && (
          <button className="btn btn-ghost wt-bar__btn" onClick={() => setPickerOpen(true)} aria-label="Сменить фильм" title="Сменить фильм"><SearchIcon /><span>Сменить</span></button>
        )}
        <button className="btn btn-primary wt-bar__btn" onClick={invite} aria-label="Пригласить" title="Пригласить"><UsersIcon /><span>Пригласить</span></button>
      </header>

      {link === "lost" && <div className="wt-banner" role="status">Нет связи, переподключаемся. Видео продолжает идти.</div>}
      {otherCut && <div className="wt-banner">У {otherCut.name} другая версия видео, разница {Math.round(Math.abs(otherCut.duration - mine.duration) / 60)} мин. Выберите один источник, иначе картинка разойдётся.</div>}

      <div className="wt-stage">
        <div className="wt-player">
          {!media && overlay}
          {media && !playerReady && <div className="loader wt-player__wait"><div className="spinner" /></div>}
          {media && playerReady ? (
            <OnlinePlayer
              provider="lampac"
              apiKey={apiKey}
              item={playerItem}
              details={details}
              type={media.type}
              season={media.type === "tv" ? media.season : null}
              episode={media.type === "tv" ? media.episode : null}
              progressKey={media.type === "tv" ? `tv_${media.tmdbId}_s${media.season}e${media.episode}` : `movie_${media.tmdbId}`}
              saveProgress={() => {}}
              onMarkWatched={() => {}}
              watchedThreshold={100}
              syncRole={canControl ? "host" : "follower"}
              syncState={play}
              syncClock={syncClock}
              onPlaybackState={canControl ? onPlaybackState : null}
              onSyncStatus={onSyncStatus}
              onNext={canControl && media.type === "tv" ? onNext : null}
              overlay={overlay}
            />
          ) : media ? null : canControl && apiKey ? (
            <TitlePicker apiKey={apiKey} onPick={pickTitle} />
          ) : (
            <div className="wt-empty">
              <p>{canControl ? "Чтобы выбрать фильм, добавьте токен TMDB в настройках." : "Ждём, пока выберут фильм."}</p>
            </div>
          )}
        </div>

        <aside className="wt-panel" onKeyDown={keepKeysHere}>
          <section className={"wt-people" + (peopleOpen ? " is-open" : "")} aria-label="Участники">
            <button className="wt-link wt-people__code" onClick={copyCode}>Код комнаты: {code}</button>
            {peers.map((peer) => (
              <div key={peer.id} className="wt-person">
                <span className={"wt-avatar" + (peer.host ? " is-host" : "")} aria-hidden="true">{firstLetter(peer.name)}</span>
                <span className="wt-person__name">{peer.name}{peer.mine ? " (вы)" : ""}</span>
                {peer.host && <span className="wt-tag">ведущий</span>}
                {peer.buffering && media && <span className="wt-tag wt-tag--wait">загружается</span>}
                {isHost && !peer.mine && <button className="wt-link" onClick={() => connRef.current?.send({ t: "host", target: peer.id })}>сделать ведущим</button>}
              </div>
            ))}
            {isHost && (
              <div className="wt-host-tools">
                <label className="wt-switch">
                  <input
                    type="checkbox"
                    checked={room.control === "all"}
                    onChange={(e) => connRef.current?.send({ t: "control", mode: e.target.checked ? "all" : "host" })}
                  />
                  <span>Паузу и перемотку могут все</span>
                </label>
                <button className="wt-link wt-link--danger" onClick={closeRoom}>Закрыть комнату</button>
              </div>
            )}
          </section>

          <div className="wt-chat" ref={chatRef} role="log" aria-live="polite" aria-label="Чат">
            {peers.length < 2 && timeline.length === 0 && (
              <div className="wt-alone">
                <p>Пока вы здесь один. Отправьте ссылку, и друг окажется в этой же комнате.</p>
                <button className="btn btn-secondary" onClick={invite}>Скопировать ссылку</button>
              </div>
            )}
            {peers.length >= 2 && timeline.length === 0 && <p className="wt-muted wt-chat__empty">Сообщений пока нет.</p>}
            {timeline.map((item) => (item.by ? (
              <div key={item.id} className={"wt-msg" + (item.by === me ? " is-mine" : "")}>
                <span className="wt-msg__name">{item.name}</span>
                <span className="wt-msg__text">{item.text}</span>
              </div>
            ) : (
              <p key={item.id} className="wt-note">{item.text}</p>
            )))}
            {waitingFor.length > 0 && play?.playing && <p className="wt-note">Загружается: {waitingFor.join(", ")}</p>}
          </div>

          <div className="wt-reactions" role="group" aria-label="Реакции">
            {REACTIONS.map((emoji) => (
              <button key={emoji} type="button" aria-label={`Реакция ${emoji}`} onClick={() => connRef.current?.send({ t: "react", emoji })}>{emoji}</button>
            ))}
          </div>
          <form className="wt-send" onSubmit={sendChat}>
            <input value={chatInput} maxLength={500} onChange={(e) => setChatInput(e.target.value)} placeholder="Сообщение" aria-label="Сообщение" enterKeyHint="send" />
            <button type="submit" className="wt-icon" aria-label="Отправить" title="Отправить" disabled={!chatInput.trim()}><SendIcon /></button>
          </form>
        </aside>
      </div>

      {episodesOpen && media?.type === "tv" && (
        <div className="wt-sheet" onKeyDown={keepKeysHere} onClick={() => setEpisodesOpen(false)}>
          <div className="wt-sheet__box" onClick={(e) => e.stopPropagation()}>
            <EpisodePicker apiKey={apiKey} details={details} media={media} onPick={pickEpisode} onClose={() => setEpisodesOpen(false)} />
          </div>
        </div>
      )}
      {pickerOpen && (
        <div className="wt-sheet" onKeyDown={keepKeysHere} onClick={() => setPickerOpen(false)}>
          <div className="wt-sheet__box wt-sheet__box--wide" onClick={(e) => e.stopPropagation()}>
            <TitlePicker apiKey={apiKey} onPick={pickTitle} onClose={() => setPickerOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Choosing a title ─────────────────────────────────────────────────────────
function TitlePicker({ apiKey, onPick, onClose = null }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const text = query.trim();
    const path = text ? `/search/multi?query=${encodeURIComponent(text)}&page=1` : "/trending/all/week";
    setFailed(false);
    const timer = setTimeout(() => {
      tmdbFetch(path, apiKey, { signal: controller.signal })
        .then((data) => setResults((data.results || []).filter((r) => r.media_type === "movie" || r.media_type === "tv").slice(0, 18)))
        .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    }, text ? 350 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, apiKey]);

  return (
    <div className="wt-picker">
      <div className="wt-picker__head">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти фильм или сериал" aria-label="Найти фильм или сериал" autoFocus={!!onClose} />
        {onClose && <button className="wt-icon" onClick={onClose} aria-label="Закрыть"><CloseIcon /></button>}
      </div>
      <p className="wt-muted">{query.trim() ? "Результаты" : "Сейчас смотрят"}</p>
      {failed && <p className="wt-message">Не удалось загрузить список. Попробуйте ещё раз.</p>}
      {!failed && results === null && <div className="loader"><div className="spinner" /></div>}
      {!failed && results?.length === 0 && <p className="wt-muted">Ничего не нашлось.</p>}
      <div className="wt-picker__grid">
        {(results || []).map((result) => {
          const title = result.title || result.name;
          const year = (result.release_date || result.first_air_date || "").slice(0, 4);
          return (
            <button key={`${result.media_type}-${result.id}`} type="button" className="wt-title" onClick={() => onPick(result)}>
              {result.poster_path
                ? <img src={imgUrl(result.poster_path, "w185")} alt="" loading="lazy" />
                : <span className="wt-title__blank">{title}</span>}
              <span className="wt-title__name">{title}</span>
              <span className="wt-muted">{[year, result.media_type === "tv" ? "сериал" : "фильм"].filter(Boolean).join(" · ")}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EpisodePicker({ apiKey, details, media, onPick, onClose }) {
  const [season, setSeason] = useState(media.season ?? 1);
  const [episodes, setEpisodes] = useState(null);

  useEffect(() => {
    if (!apiKey) return undefined;
    let active = true;
    setEpisodes(null);
    tmdbFetch(`/tv/${media.tmdbId}/season/${season}`, apiKey)
      .then((data) => { if (active) setEpisodes(data.episodes || []); })
      .catch(() => { if (active) setEpisodes([]); });
    return () => { active = false; };
  }, [apiKey, media.tmdbId, season]);

  const seasons = (details?.seasons || []).filter((s) => s.season_number >= 0);
  const today = new Date();

  return (
    <div className="wt-episodes">
      <div className="wt-picker__head">
        <strong>Серии</strong>
        <select value={season} onChange={(e) => setSeason(Number(e.target.value))} aria-label="Сезон">
          {seasons.length === 0 && <option value={season}>Сезон {season}</option>}
          {seasons.map((s) => <option key={s.season_number} value={s.season_number}>{s.season_number === 0 ? "Спецвыпуски" : `Сезон ${s.season_number}`}</option>)}
        </select>
        <button className="wt-icon" onClick={onClose} aria-label="Закрыть"><CloseIcon /></button>
      </div>
      {episodes === null && <div className="loader"><div className="spinner" /></div>}
      {episodes?.length === 0 && <p className="wt-muted">В этом сезоне нет серий.</p>}
      <div className="wt-episodes__list">
        {(episodes || []).map((episode) => {
          const unreleased = episode.air_date ? new Date(episode.air_date) > today : false;
          const current = media.season === season && media.episode === episode.episode_number;
          return (
            <button key={episode.episode_number} type="button" className={"wt-episode" + (current ? " is-current" : "")} disabled={unreleased} onClick={() => onPick(season, episode.episode_number)}>
              <span className="wt-episode__num">{episode.episode_number}</span>
              <span className="wt-episode__name">{episode.name || `Серия ${episode.episode_number}`}</span>
              {unreleased && <span className="wt-tag">скоро</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
