// ── Watch Together: Rave-style watch-party tab ───────────────────────────────
// Create or join a room (shareable code/link), watch a movie/series in sync
// with another person, text-chat alongside. Host-leader model: the host's
// play/pause/seek is authoritative; followers sync to it (drift-corrected). If
// the host leaves, the backend auto-promotes the longest-present follower.
//
// Room state lives in a shared Upstash Redis and is polled adaptively. Each
// peer resolves the Collaps stream from its OWN IP
// (existing client-side resolver), so IP-bound CDN tokens still work per-peer —
// we sync playback position/state, not stream bytes.

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import OnlinePlayer from "../components/OnlinePlayer";
import { tmdbFetch, imgUrl } from "../utils/api";
import { storage, STORAGE_KEYS } from "../utils/storage";
import {
  createRoom,
  pollRoom,
  hostPushPlay,
  hostPushMedia,
  heartbeat,
  sendChat,
  closeRoom,
  myPeerId,
  roomEndpoint,
  getWtPeerSecret,
} from "../utils/watchParty";
import {
  CloseIcon,
  SettingsIcon,
  SearchIcon,
  UsersIcon,
  ListIcon,
  AtIcon,
  ImageIcon,
  LinkIcon,
  SendIcon,
} from "../components/Icons";

// Poll cadence. Tuned to minimize follower-perceived latency:
// FAST runs right after a detected state change (seq bump) so the follower
// picks up the host's play/pause/seek quickly; STEADY is the idle cadence;
// PAUSED is slow (host paused → nothing changes → save requests). The old
// 2500ms steady meant a follower could wait up to 2.5s before even noticing a
// host play/pause — the dominant chunk of the 3-4s lag.
const POLL_FAST = 400;
const POLL_STEADY = 1500;
const POLL_PAUSED = 3000;
const HEARTBEAT_MS = 15000;
// How long to stay in FAST after a state change before falling back to STEADY.
const FAST_WINDOW_MS = 3000;

export default function WatchTogetherPage({
  apiKey,
  initialCode = null,
  progress,
  watched,
  onMarkWatched,
  onMarkUnwatched,
}) {
  const [screen, setScreen] = useState(initialCode ? "joining" : "landing");
  const [code, setCode] = useState(initialCode || "");
  const [room, setRoom] = useState(null);
  const [name, setName] = useState(() => storage.get(STORAGE_KEYS.WT_NAME) || "");
  const [peerId, setPeerId] = useState(null);
  const [details, setDetails] = useState(null);
  const [chatInput, setChatInput] = useState("");
  const [status, setStatus] = useState(""); // transient status line
  const [searchOpen, setSearchOpen] = useState(false);
  const [eppickerOpen, setEppickerOpen] = useState(false);
  const [joinInput, setJoinInput] = useState(initialCode || "");
  const chatBoxRef = useRef(null);
  const lastSeqRef = useRef(-1);
  const changedUntilRef = useRef(0);
const pushTimerRef = useRef(null);

  // The WT Bearer + identity is a per-browser random secret (NOT the TMDB
  // token). See getWtPeerSecret: this gives each visitor a unique peerId even
  // when the Express server hands everyone the same shared TMDB token, and
  // avoids sending the TMDB token to /api/room. Stable for the browser's life
  // (persisted in localStorage), so a host stays host across reloads.
  const wtToken = useMemo(() => getWtPeerSecret(), []);
  const endpointOk = !!roomEndpoint();

  // Resolve our peer id once the token is available.
  useEffect(() => {
    if (!wtToken) return;
    myPeerId(wtToken).then(setPeerId).catch(() => {});
  }, [wtToken]);

  // Persist + use the display name.
  const commitName = useCallback((n) => {
    setName(n);
    storage.set(STORAGE_KEYS.WT_NAME, n);
  }, []);

  const isHost = !!(room && peerId && room.hostId === peerId);
  const media = room?.media || null;
  const play = room?.play || null;

  // ── Participant list (used by the voice-mesh effect + the right panel UI) ────
  // Declared up here — BEFORE the polling/voice effects that close over it — so
  // the closure binding is initialised on every render, including the early
  // "landing"/"joining" return below. (Previously this lived below the early
  // return at line ~443; when a re-render reached that point with `voiceOn`
  // already true from a prior session, the effect callback ran in TDZ and
  // threw `Cannot access 'participants' before initialization` in production.)
  // useMemo keeps the reference stable between renders that don't actually
  // change the participant set.
  const participants = useMemo(
    () =>
      room?.who
        ? Object.entries(room.who).map(([pid, v]) => ({
            pid,
            name: v.name,
            host: pid === room.hostId,
          }))
        : [],
    [room?.who, room?.hostId],
  );

  // Fetch details for the current media (for OnlinePlayer's anime-skip etc.).
  useEffect(() => {
    setDetails(null);
    if (!media || !apiKey) return;
    let cancelled = false;
    tmdbFetch(`/${media.type}/${media.tmdbId}`, apiKey)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [media, apiKey]);

  // Build the `item` prop for OnlinePlayer from the room media.
  const playerItem = useMemo(() => {
    if (!media) return null;
    return {
      id: media.tmdbId,
      title: media.type === "movie" ? media.title : undefined,
      name: media.type === "tv" ? media.title : undefined,
      poster_path: media.posterPath || null,
      media_type: media.type,
    };
  }, [media]);

  // ── Polling + heartbeat loop (in room) ──────────────────────────────────────
  useEffect(() => {
    if (screen !== "inRoom" || !code || !wtToken) return;
    let active = true;
    let pollTimer = null;
    let beatTimer = null;

    const doPoll = async () => {
      // `r` is declared in the doPoll scope (not inside try) so the post-catch
      // poll-delay logic below can read it. Declaring it inside `try` made it
      // block-scoped and threw ReferenceError after the first poll — silently
      // killing the polling loop (room created, but no sync/chat/presence
      // updates ever landed).
      let r = null;
      try {
        r = (await pollRoom(wtToken, code)).room;
        if (!active) return;
        if (!r) {
          setStatus("Комната закрыта или срок её действия истёк.");
          setScreen("landing");
          return;
        }
        // Detect a state change (seq bump) to switch to fast polling briefly.
        const seq = r.play?.seq ?? 0;
        if (seq !== lastSeqRef.current && lastSeqRef.current !== -1) {
          changedUntilRef.current = Date.now() + FAST_WINDOW_MS;
        }
        lastSeqRef.current = seq;
        setRoom(r);
      } catch {
        // network blip — keep trying
      }
      const paused = !r?.play?.playing;
      const changed = Date.now() < changedUntilRef.current;
      const delay = paused ? POLL_PAUSED : changed ? POLL_FAST : POLL_STEADY;
      pollTimer = setTimeout(doPoll, delay);
    };

    const doBeat = () => heartbeat(wtToken, code, name || "Зритель").catch(() => {});
    doBeat();
    beatTimer = setInterval(doBeat, HEARTBEAT_MS);
    pollTimer = setTimeout(doPoll, 300);

    return () => {
      active = false;
      clearTimeout(pollTimer);
      clearInterval(beatTimer);
    };
  }, [screen, code, wtToken, name]);

  // Auto-scroll chat to bottom on new messages.
  useEffect(() => {
    if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
  }, [room?.chat?.length]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const doCreate = async () => {
    if (!wtToken || !endpointOk) { setStatus("Сервер синхронизации не настроен."); return; }
    const n = (name || "").trim() || "Ведущий";
    commitName(n);
    try {
      const { code: c } = await createRoom(wtToken, { name: n, media: null });
      storage.set(STORAGE_KEYS.WT_LAST_CODE, c);
      setCode(c);
      lastSeqRef.current = -1;
      setScreen("inRoom");
      setSearchOpen(true); // host picks a title immediately
    } catch (e) { setStatus("Не удалось создать комнату: " + e.message); }
  };

  const doJoin = async () => {
    const c = (joinInput || "").trim();
    if (!c) return;
    if (!wtToken || !endpointOk) { setStatus("Сервер синхронизации не настроен."); return; }
    const n = (name || "").trim() || "Зритель";
    commitName(n);
    try {
      const { room: r } = await pollRoom(wtToken, c);
      if (!r) { setStatus("Комната не найдена. Проверьте код."); return; }
      await heartbeat(wtToken, c, n);
      storage.set(STORAGE_KEYS.WT_LAST_CODE, c);
      setCode(c);
      lastSeqRef.current = r.play?.seq ?? -1;
      setRoom(r);
      setScreen("inRoom");
    } catch (e) { setStatus("Не удалось войти в комнату: " + e.message); }
  };

  const doLeave = () => {
    setScreen("landing");
    setCode("");
    setRoom(null);
    setJoinInput("");
    setStatus("");
  };

  const doClose = async () => {
    if (!code || !wtToken) return;
    try { await closeRoom(wtToken, code); } catch {}
    doLeave();
  };

  const onPickMedia = async (m) => {
    setSearchOpen(false);
    if (!code || !wtToken) return;
    try {
      await hostPushMedia(wtToken, code, m);
      // For a series, open the episode picker so the host can choose the exact
      // episode instead of everyone landing on the S1E1 default.
      if (m.type === "tv") setEppickerOpen(true);
    } catch (e) { setStatus("Не удалось отправить сообщение: " + e.message); }
  };

  // Host switches the room's current episode. Re-uses hostPushMedia with the
  // same title but a new season/episode — the backend resets room.play on
  // op=media, so followers re-resolve to the new episode and sync-seek to 0.
  const onPickEpisode = async (s, e) => {
    if (!code || !wtToken || !media) return;
    try { await hostPushMedia(wtToken, code, { ...media, season: s, episode: e }); }
    catch { setStatus("Не удалось переключить эпизод."); }
  };

  const onPlaybackState = useCallback((st) => {
    if (!code || !wtToken) return;
    // Push host state to the room ASAP. We DON'T debounce play/pause — a 400ms
    // wait was adding ~0.4s of avoidable latency to every play/pause/seek the
    // follower sees (on top of the poll interval). keepalive:true on
    // hostPushPlay makes each push a fire-and-forget that survives navigation.
    // A tiny 80ms coalesce handles the play-after-seek burst (two events fire
    // back-to-back) without measurable added latency.
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      hostPushPlay(wtToken, code, st).catch(() => {});
    }, 80);
  }, [code, wtToken]);

  const onSendChat = async (e) => {
    e?.preventDefault();
    const txt = (chatInput || "").trim();
    if (!txt || !code || !wtToken) return;
    setChatInput("");
    try { await sendChat(wtToken, code, txt); } catch {}
  };

  

  // ── Auto-join from a ?room=CODE share link ──────────────────────────────────
  // `initialCode` pre-fills joinInput and starts us in the "joining" screen, but
  // without this effect the user still has to click Join themselves — contradict
  // ing the share-link UX. Auto-join once the WT token + endpoint are ready.
  // doJoin flips screen to "inRoom" on success, so this won't re-enter.
  useEffect(() => {
    if (screen !== "joining" || !initialCode || !wtToken || !endpointOk) return;
    doJoin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, initialCode, wtToken, endpointOk]);

  // The syncState we feed to OnlinePlayer (followers only).
  const syncState = !isHost && play ? play : null;

  // ── Landing ─────────────────────────────────────────────────────────────────
  if (screen === "landing" || screen === "joining") {
    return (
      <div className="fade-in page-pad" style={{ paddingTop: 48 }}>
        <div className="library-header" style={{ padding: "0 0 16px" }}>
          <div className="library-title">Смотрим вместе</div>
          <div className="library-sub">Смотрите фильм или сериал одновременно с друзьями</div>
        </div>
        {!endpointOk && (
          <div style={{ color: "var(--red)", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
            Watch Together needs a free Upstash Redis to sync rooms between
            viewers. Ask whoever runs this site to add the
            <code style={{ background: "var(--surface2)", padding: "1px 5px", borderRadius: 4, margin: "0 4px" }}>UPSTASH_REDIS_REST_URL</code>
            and
            <code style={{ background: "var(--surface2)", padding: "1px 5px", borderRadius: 4, margin: "0 4px" }}>UPSTASH_REDIS_REST_TOKEN</code>
            env vars (Vercel project → Settings → Environment Variables) and redeploy.
          </div>
        )}
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 24, flexWrap: "wrap" }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name && commitName(name)}
            placeholder="Ваше имя (его увидят остальные)"
            style={inputStyle}
          />
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={cardStyle}>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Создать комнату</div>
            <div style={{ fontSize: 13, color: "var(--text3)", marginBottom: 16, lineHeight: 1.5 }}>
              Start a new session, pick a title, and share the link with a friend.
            </div>
            <button className="btn btn-primary" onClick={doCreate} disabled={!apiKey}>Создать комнату</button>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Войти в комнату</div>
            <div style={{ fontSize: 13, color: "var(--text3)", marginBottom: 16, lineHeight: 1.5 }}>
              Enter the 6-character code a friend shared with you.
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
                placeholder="ABC123"
                style={{ ...inputStyle, textTransform: "uppercase", letterSpacing: 2, maxWidth: 140 }}
              />
              <button className="btn" onClick={doJoin} disabled={!apiKey}>Войти</button>
            </div>
          </div>
        </div>
        {status && <div style={{ marginTop: 16, color: "var(--text2)", fontSize: 13 }}>{status}</div>}
      </div>
    );
  }

  // ── In room ─────────────────────────────────────────────────────────────────
  const shareLink = `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
  const copyLink = () => {
    try { navigator.clipboard?.writeText(shareLink); setStatus("Ссылка скопирована!"); setTimeout(() => setStatus(""), 2000); } catch {}
  };
  // Round avatar fallback (first letter on a dark disc) used by the mobile chat
  // rows + the top-overlay participant avatars. Returns "?" for empty names.
  const initialOf = (nm) => (nm || "?").trim().charAt(0).toUpperCase() || "?";
  const avatarParticipants = participants.slice(0, 5);
  const avatarOverflow = participants.length - avatarParticipants.length;
  // Copy just the 6-char room code (vs. the full URL link) — easier to dictate
  // over voice or paste into another app.
  const copyCode = () => {
    try {
      navigator.clipboard?.writeText(code);
      setStatus("Код скопирован!");
      setTimeout(() => setStatus(""), 2000);
    } catch {}
  };

  return (
    <div className="fade-in wt-room">
      {/* Desktop room bar (hidden on mobile via @media). */}
      <div className="wt-roombar">
        <div className="wt-roombar-title">Смотрим вместе</div>
        <div className="wt-roombar-code">Код: <b>{code}</b></div>
        <button className="btn" onClick={copyCode} title="Скопировать код комнаты">Копировать код</button>
        <button className="btn" onClick={copyLink} title="Скопировать ссылку-приглашение">Копировать ссылку</button>
        {media?.type === "tv" && (
          <button className="btn" onClick={() => setEppickerOpen((v) => !v)}>
            {eppickerOpen ? "Скрыть эпизоды" : "Эпизоды"}
          </button>
        )}
        {isHost ? (
          <>
            <button className="btn" onClick={() => setSearchOpen(true)}>Сменить фильм или сериал</button>
            <button className="btn wt-btn-danger" onClick={doClose}>Закрыть комнату</button>
          </>
        ) : null}
        {/* Participant avatars — circular with host ring + overflow chip.
            Lets the host see at a glance who's in the room. Hidden when
            the room is empty (no one has joined yet). */}
        {participants.length > 0 && (
          <div className="wt-roombar-avatars" aria-label={`Participants: ${participants.map((p) => p.name).join(", ")}`}>
            {avatarParticipants.map((p) => (
              <div
                key={p.pid}
                className={"wt-roombar-avatar" + (p.host ? " host" : "")}
                title={p.name + (p.host ? " · host" : "")}
              >
                {initialOf(p.name)}
              </div>
            ))}
            {avatarOverflow > 0 && (
              <div
                className="wt-roombar-avatar wt-roombar-avatar-more"
                title={`${avatarOverflow} more`}
              >
                +{avatarOverflow}
              </div>
            )}
          </div>
        )}
        <button className="btn wt-roombar-leave" onClick={doLeave}>Выйти</button>
      </div>

      {/* Mobile immersive top overlay (hidden on desktop via CSS, shown ≤768px).
          Floats over the edge-to-edge video: close, settings, participant avatars,
          then on the right change-title (host), invite, episodes (TV). Re-uses the
          same handlers as the desktop bar so sync/leave behaviour is identical. */}
      <div className="wt-topbar-mobile">
        <button className="wt-top-icon" onClick={doLeave} aria-label="Выйти" title="Выйти">
          <CloseIcon />
        </button>
        <button className="wt-top-icon" aria-label="Настройки" title="Настройки">
          <SettingsIcon />
        </button>
        <div className="wt-avatars" aria-label={`Participants: ${participants.map((p) => p.name).join(", ")}`}>
          {avatarParticipants.map((p) => (
            <div key={p.pid} className={"wt-avatar" + (p.host ? " host" : "")} title={p.name + (p.host ? " · host" : "")}>
              {initialOf(p.name)}
            </div>
          ))}
          {avatarOverflow > 0 && (
            <div className="wt-avatar wt-avatar-more" title={`${avatarOverflow} more`}>+{avatarOverflow}</div>
          )}
        </div>
        <div className="wt-top-actions">
          {isHost && (
            <button className="wt-top-icon" onClick={() => setSearchOpen(true)} aria-label="Сменить фильм или сериал" title="Сменить фильм или сериал">
              <SearchIcon />
            </button>
          )}
          <button className="wt-top-icon" onClick={copyLink} aria-label="Пригласить" title="Скопировать ссылку-приглашение">
            <UsersIcon />
          </button>
          {media?.type === "tv" && (
            <button className="wt-top-icon" onClick={() => setEppickerOpen((v) => !v)} aria-label="Эпизоды" title="Эпизоды">
              <ListIcon />
            </button>
          )}
        </div>
      </div>

      <div className="wt-stage">
        {/* Player area — edge-to-edge on mobile, centered max-width on desktop. */}
        <div className="wt-player">
          {media && playerItem ? (
            <div className="wt-player-inner">
              <OnlinePlayer
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
                syncRole={isHost ? "host" : "follower"}
                syncState={syncState}
                onPlaybackState={isHost ? onPlaybackState : null}
              />
            </div>
          ) : (
            <div className="wt-player-empty">
              {isHost ? "Выберите фильм или сериал, чтобы начать просмотр." : "Ждём, пока ведущий выберет фильм или сериал…"}
            </div>
          )}
        </div>

        {/* Right panel: participants + chat (desktop sidebar; mobile = chat only
            over a dark gradient, participants move into the top avatars). */}
        <div className="wt-panel">
          <div className="wt-participants">
            <div className="wt-participants-label">Участники</div>
            {participants.map((p) => (
              <div key={p.pid} className={"wt-participant"}>
                <span className="wt-presence-dot" />
                <span>{p.name}{p.host ? " · host" : ""}</span>
              </div>
            ))}
          </div>
          <div className="wt-chat" ref={chatBoxRef}>
            {(room?.chat || []).length === 0 && (
              <div className="wt-chat-empty">Сообщений пока нет.</div>
            )}
            {(room?.chat || []).map((m) => (
              <div key={m.id} className="wt-chat-msg">
                <div className="wt-chat-avatar" aria-hidden="true">{initialOf(m.name)}</div>
                <div className="wt-chat-body">
                  <span className="wt-chat-name">{m.name}</span>
                  <span className="wt-chat-sep">: </span>
                  <span className="wt-chat-text">{m.text}</span>
                </div>
              </div>
            ))}
          </div>
          {/* Chat input. Plain input + "Send" button — desktop and mobile share the
              same form, mobile CSS adds a frosted bar above the safe-area. */}
          <form onSubmit={onSendChat} className="wt-chat-form">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Сообщение…"
              className="wt-chat-input"
            />
            <div className="wt-input-actions">
              <button type="button" className="wt-input-icon" aria-label="Упомянуть участника" title="Упомянуть участника"><AtIcon /></button>
              <button type="button" className="wt-input-icon" aria-label="Изображение" title="Изображение"><ImageIcon /></button>
              <button type="button" className="wt-input-icon" aria-label="Ссылка" title="Ссылка"><LinkIcon /></button>
              <button type="submit" className="btn wt-input-send" aria-label="Отправить" title="Отправить">
                <span className="wt-send-text">Отправить</span>
                <span className="wt-send-icon"><SendIcon /></span>
              </button>
            </div>
          </form>
        </div>
      </div>
      {/* Episode picker. Desktop: inline panel under the stage. Mobile: a frosted
          bottom sheet (the .wt-eppicker-wrap becomes a fixed overlay ≤768px and
          the backdrop tap closes it). Re-uses the same EpisodePicker + onPickEpisode
          so host switches series and followers auto-follow via hostPushMedia. */}
      {eppickerOpen && media?.type === "tv" && (
        <div className="wt-eppicker-wrap">
          <div className="wt-eppicker-backdrop" onClick={() => setEppickerOpen(false)} />
          <EpisodePicker
            apiKey={apiKey}
            details={details}
            media={media}
            isHost={isHost}
            onPick={onPickEpisode}
          />
        </div>
      )}
      {status && <div className="wt-toast">{status}</div>}
      {searchOpen && (
        <MediaPicker apiKey={apiKey} onPick={onPickMedia} onClose={() => setSearchOpen(false)} />
      )}
    </div>
  );
}

const inputStyle = {
  padding: "10px 12px",
  background: "var(--surface2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 14,
};
const cardStyle = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 24,
  flex: "1 1 280px",
  maxWidth: 360,
};

// ── Media picker (host picks a title for the room) ────────────────────────────
function MediaPicker({ apiKey, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (!q.trim() || !apiKey) { setResults([]); return; }
    let active = true;
    const t = setTimeout(async () => {
      try {
        const d = await tmdbFetch(`/search/multi?query=${encodeURIComponent(q)}&page=1`, apiKey);
        if (!active) return;
        setResults((d.results || []).filter((r) => r.media_type === "movie" || r.media_type === "tv").slice(0, 12));
      } catch {}
    }, 350);
    return () => { active = false; clearTimeout(t); };
  }, [q, apiKey]);
  return (
    <div onClick={onClose} className="wt-picker-overlay">
      <div onClick={(e) => e.stopPropagation()} className="wt-picker">
        <div className="wt-picker-head">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти фильм или сериал…" className="wt-picker-input" />
          <button className="btn" onClick={onClose}>Закрыть</button>
        </div>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
          {results.map((r) => {
            const title = r.title || r.name;
            const media = {
              type: r.media_type,
              tmdbId: r.id,
              title,
              posterPath: r.poster_path || null,
              season: r.media_type === "tv" ? 1 : null,
              episode: r.media_type === "tv" ? 1 : null,
            };
            return (
              <button key={r.id} onClick={() => onPick(media)} style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, padding: 0, cursor: "pointer", overflow: "hidden", textAlign: "left" }}>
                {r.poster_path ? (
                  <img src={imgUrl(r.poster_path, "w200")} alt={title} style={{ width: "100%", display: "block" }} />
                ) : (
                  <div style={{ aspectRatio: "2/3", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontSize: 12 }}>Нет изображения</div>
                )}
                <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text)" }}>{title}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Episode picker (TV series in a Watch Together room) ──────────────────────
// Host browses seasons/episodes and switches the room's current episode. The
// change goes through hostPushMedia (same title, new season/episode), so every
// follower's OnlinePlayer re-resolves to the new episode and sync-seeks to 0
// (the backend resets room.play on op=media). Followers get a read-only list —
// they can browse seasons and see the current episode highlighted, but only the
// host can actually switch.
function EpisodePicker({ apiKey, details, media, isHost, onPick }) {
  const [season, setSeason] = useState(media?.season ?? 1);
  const [seasonData, setSeasonData] = useState(null);
  const [loading, setLoading] = useState(false);

  // Keep the browsing season aligned with the room's current season whenever the
  // host changes it, so a follower's view follows the room.
  useEffect(() => {
    if (media?.season != null) setSeason(media.season);
  }, [media?.season]);

  // Fetch the episode list for the browsing season.
  useEffect(() => {
    if (!apiKey || !details?.id || season == null) return;
    let cancelled = false;
    setLoading(true);
    setSeasonData(null);
    tmdbFetch(`/tv/${details.id}/season/${season}`, apiKey)
      .then((d) => { if (!cancelled) setSeasonData(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiKey, details?.id, season]);

  if (!details) {
    return (
      <div className="wt-eppicker">
        <div className="wt-eppicker-list"><div className="loader"><div className="spinner" /></div></div>
      </div>
    );
  }

  const seasons = (details.seasons || []).filter((s) => s.season_number >= 0);
  const episodes = seasonData?.episodes || [];
  const today = new Date();

  return (
    <div className="wt-eppicker">
      <div className="wt-eppicker-head">
        <span className="wt-eppicker-title">Эпизоды</span>
        <select
          className="wt-eppicker-season"
          value={season}
          onChange={(e) => setSeason(Number(e.target.value))}
        >
          {seasons.map((s) => (
            <option key={s.season_number} value={s.season_number}>
              {s.season_number === 0 ? "Спецвыпуски" : `Сезон ${s.season_number}`}
            </option>
          ))}
        </select>
        {!isHost && <span className="wt-eppicker-hint">Переключать эпизоды может только ведущий</span>}
      </div>
      <div className="wt-eppicker-list">
        {loading && <div className="loader"><div className="spinner" /></div>}
        {!loading && episodes.length === 0 && (
          <div className="wt-eppicker-empty">В этом сезоне нет эпизодов.</div>
        )}
        {!loading && episodes.map((ep) => {
          const cur = media?.season === season && media?.episode === ep.episode_number;
          const unreleased = ep.air_date ? new Date(ep.air_date) > today : false;
          return (
            <button
              key={ep.episode_number}
              className={"wt-eppicker-ep" + (cur ? " active" : "")}
              disabled={!isHost || unreleased}
              onClick={() => onPick(season, ep.episode_number)}
              title={ep.overview || ""}
            >
              <span className="wt-eppicker-ep-num">E{ep.episode_number}</span>
              <span className="wt-eppicker-ep-name">{ep.name || `Episode ${ep.episode_number}`}</span>
              {unreleased && <span className="wt-eppicker-ep-soon">soon</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
