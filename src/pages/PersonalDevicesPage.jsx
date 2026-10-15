import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import {
  approveDevicePairing, beginDevicePairing, claimDevicePairing,
  createViewingProfile, disconnectViewingProfile, getViewingProfileSnapshot,
  pollDevicePairing, revokeProfileDevice, subscribeViewingProfile,
} from "../utils/viewingProfile";

const statusText = (status) => ({ ready: "Синхронизация включена", local: "Локальный профиль", syncing: "Синхронизируем…", offline: "Офлайн · изменения сохраняются локально", error: "Нужна проверка профиля" }[status] || "Подключаемся");
const expiryLabel = (value) => value ? new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "через несколько минут";

export default function PersonalDevicesPage({ initialPairToken, apiKey, onNavigateSettings }) {
  const snapshot = useSyncExternalStore(subscribeViewingProfile, getViewingProfileSnapshot, getViewingProfileSnapshot);
  const [displayName, setDisplayName] = useState(snapshot.displayName || "Мой кинотеатр");
  const [deviceName, setDeviceName] = useState("");
  const [shortCode, setShortCode] = useState("");
  const [activePair, setActivePair] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [qrData, setQrData] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [joinDeviceName, setJoinDeviceName] = useState("");
  const [joinMode, setJoinMode] = useState(false);
  const initialClaimed = useRef(false);

  const shareUrl = useMemo(() => {
    if (!activePair?.requestToken || typeof window === "undefined") return "";
    const origin = /^https?:$/.test(window.location.protocol) ? window.location.origin : "https://lampa-stream-six.vercel.app";
    return `${origin}/devices#pair=${encodeURIComponent(activePair.requestToken)}`;
  }, [activePair]);
  useEffect(() => {
    if (!shareUrl) { setQrData(""); return; }
    let alive = true;
    QRCode.toDataURL(shareUrl, { width: 240, margin: 1, color: { dark: "#111018", light: "#ffffff" } }).then((url) => { if (alive) setQrData(url); }).catch(() => { if (alive) setQrData(""); });
    return () => { alive = false; };
  }, [shareUrl]);

  useEffect(() => {
    if (!activePair?.requestId || !activePair?.pollToken) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await pollDevicePairing({ requestId: activePair.requestId, pollToken: activePair.pollToken, requestToken: activePair.requestToken });
        if (stopped) return;
        if (result.status === "approved") { setActivePair(null); setNotice("Устройство подключено к твоему кинотеатру."); }
        else if (result.status === "expired" || result.status === "revoked") { setError("Код истёк. Создай новую ссылку для подключения."); setActivePair(null); }
        else window.setTimeout(poll, 2500);
      } catch (failure) { if (!stopped) { setError(failure.message || "Не удалось проверить подключение"); if (failure.status === 410) setActivePair(null); else window.setTimeout(poll, 5000); } }
    };
    const timer = window.setTimeout(poll, 1800);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [activePair]);

  useEffect(() => {
    if (!initialPairToken || initialClaimed.current || snapshot.profileId) return;
    initialClaimed.current = true;
    setClaiming(true); setError("");
    claimDevicePairing({ requestToken: initialPairToken, deviceName: joinDeviceName || undefined })
      .then((result) => { setActivePair({ ...result, requestToken: initialPairToken }); setNotice("Запрос отправлен. Подтверди это устройство на уже подключённом экране."); })
      .catch((failure) => setError(failure.message || "Ссылка подключения недействительна или устарела"))
      .finally(() => setClaiming(false));
  }, [initialPairToken, joinDeviceName, snapshot.profileId]);

  const run = async (action, success) => {
    setBusy(true); setError(""); setNotice("");
    try { const result = await action(); if (success) setNotice(success(result)); return result; }
    catch (failure) { setError(failure.message || "Не удалось выполнить действие"); return null; }
    finally { setBusy(false); }
  };
  const create = () => run(() => createViewingProfile({ displayName: displayName.trim() || "Мой кинотеатр", deviceName: deviceName.trim() || undefined, tmdbToken: apiKey }), () => "Личный кинотеатр создан и доступен на этом устройстве.");
  const beginPair = async () => {
    const result = await run(beginDevicePairing);
    if (result?.requestToken) setActivePair(result);
  };
  const claim = async (tokenOrCode = shortCode) => {
    const clean = tokenOrCode.trim(); if (!clean) return;
    setBusy(true); setClaiming(true); setError(""); setNotice("");
    try {
      const result = await claimDevicePairing({ ...(clean.length > 12 ? { requestToken: clean } : { shortCode: clean }), deviceName: joinDeviceName.trim() || undefined });
      setActivePair({ ...result, requestToken: clean.length > 12 ? clean : undefined });
      setShortCode(""); setNotice("Запрос отправлен. Подтверди это устройство на уже подключённом экране.");
    } catch (failure) { setError(failure.message || "Код не найден или уже истёк"); }
    finally { setBusy(false); setClaiming(false); }
  };
  const copy = async (value, label) => {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} скопирован.`); } catch { setError("Браузер запретил доступ к буферу обмена."); }
  };
  const activeDevices = snapshot.devices.filter((device) => device.active !== false && device.deviceId !== snapshot.deviceId);
  const revokedDevices = snapshot.devices.filter((device) => device.active === false || device.revokedAt);

  return <main className="personal-page devices-page">
    <header className="personal-page-head"><div><h1>Устройства</h1><p>Продолжай просмотр на телевизоре, ноутбуке или телефоне.</p></div><div className="profile-status" data-status={snapshot.status}><i />{statusText(snapshot.status)}</div></header>
    {(error || notice || snapshot.error) && <div className={`personal-notice${error || snapshot.error ? " is-error" : ""}`} role="status">{error || snapshot.error || notice}</div>}
    {!snapshot.profileId ? <section className="device-onboard">
      <div className="device-onboard-copy"><h2>Один профиль для всех устройств</h2><p>Сохраним место остановки, историю и оценки, чтобы продолжить с любого твоего устройства. Данные доступны только подключённым экранам.</p>
        {activePair ? <div className="device-join-wait"><span className="device-pair-wait"><i/>Запрос отправлен. Подтверди подключение на основном устройстве…</span><button className="btn btn-ghost" onClick={() => setActivePair(null)}>Закрыть ожидание</button></div> : initialPairToken ? <div className="device-form"><label>Как назвать это устройство<input value={joinDeviceName} onChange={(event) => setJoinDeviceName(event.target.value)} placeholder="Например, телефон" /></label><button className="btn btn-primary" disabled={claiming || busy} onClick={() => claim(initialPairToken)}>{claiming ? "Подключаем…" : "Подключить к профилю"}</button></div> : joinMode ? <div className="device-form"><label>Имя этого устройства<input value={joinDeviceName} onChange={(event) => setJoinDeviceName(event.target.value)} placeholder="Телефон" /></label><label>Короткий код с основного экрана<input value={shortCode} onChange={(event) => setShortCode(event.target.value.toUpperCase().slice(0, 10))} placeholder="ABCD-1234" autoComplete="one-time-code" /></label><button className="btn btn-primary" disabled={busy || shortCode.trim().length < 4} onClick={() => claim()}>{busy ? "Отправляем запрос…" : "Запросить подключение"}</button><button className="btn btn-ghost" onClick={() => setJoinMode(false)}>Создать новый профиль</button></div> : <div className="device-form device-create-form"><label>Название кинотеатра<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={48} /></label><label>Имя этого устройства<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={48} placeholder="Компьютер" /></label><button className="btn btn-primary" disabled={busy || !apiKey} onClick={create}>{busy ? "Создаём…" : "Создать профиль"}</button><button className="btn btn-ghost" onClick={() => setJoinMode(true)}>Уже есть код? Подключить экран</button><small>{apiKey ? "Каталог фильмов подключится к профилю безопасно. Секретный токен не попадёт в QR-код." : <>Для нового профиля сначала подключи каталог: <button className="device-inline-link" type="button" onClick={onNavigateSettings}>добавить TMDB-токен в Настройках</button>. Подключиться к существующему профилю по коду можно уже сейчас.</>}</small></div>}
      </div>
    </section> : <>
      <section className="device-profile-banner"><div className="device-profile-monogram">{(snapshot.displayName || displayName || "К").slice(0, 1).toLocaleUpperCase("ru-RU")}</div><div><h2>{snapshot.displayName || displayName}</h2><p>{activeDevices.length + 1} {activeDevices.length === 0 ? "устройство подключено" : "устройства подключены"}</p></div><button className="btn btn-ghost" disabled={busy} onClick={() => run(disconnectViewingProfile, () => "Профиль отключён на этом устройстве. Локальные данные сохранены.")}>Отключить этот экран</button></section>
      <div className="device-columns"><section className="device-panel device-pair-panel"><div className="device-panel-heading"><h2>Подключи ещё одно устройство</h2></div>
        {activePair ? <div className="device-pair-active">{qrData && <img className="device-qr" src={qrData} alt="QR-код для безопасного подключения устройства" />}<div className="device-pair-code"><span>КОД ПОДКЛЮЧЕНИЯ</span><strong>{activePair.shortCode || "Открой ссылку на втором устройстве"}</strong><small>Действует до {expiryLabel(activePair.expiresAt)}. Код одноразовый; незавершённая привязка истечёт автоматически.</small><div className="device-inline-actions"><button className="btn btn-secondary" onClick={() => copy(activePair.shortCode || shareUrl, activePair.shortCode ? "Код" : "Ссылка")}>Копировать {activePair.shortCode ? "код" : "ссылку"}</button><button className="btn btn-ghost" onClick={() => setActivePair(null)}>Скрыть код</button></div></div><div className="device-pair-wait"><i /> Ждём подтверждения на этом устройстве…</div></div> : <button className="btn btn-primary" disabled={busy || snapshot.status === "offline"} onClick={beginPair}>Создать код и QR</button>}
        <div className="device-divider"><span>Или введи код</span></div><div className="device-join-row"><input value={shortCode} onChange={(event) => setShortCode(event.target.value.toUpperCase().slice(0, 10))} placeholder="ABCD-1234" aria-label="Код подключения" /><button className="btn btn-secondary" disabled={busy || shortCode.trim().length < 4} onClick={() => claim()}>Подключить</button></div><small className="device-local-note">На втором устройстве открой эту страницу и используй короткий код или ссылку с QR.</small>
      </section>
      <section className="device-panel"><div className="device-panel-heading"><h2>Подключённые экраны</h2></div>
        {snapshot.pairings.length > 0 && <div className="device-requests"><h3>Ждут твоего разрешения</h3>{snapshot.pairings.map((pair) => <div className="device-row" key={pair.requestId}><span className="device-row-icon">⌁</span><div><strong>{pair.deviceName || "Новое устройство"}</strong><small>Одноразовый запрос на подключение</small></div><button className="btn btn-primary" disabled={busy} onClick={() => run(() => approveDevicePairing(pair.requestId), () => "Запрос подтверждён. Второй экран завершит подключение.")}>Разрешить</button></div>)}</div>}
        {activeDevices.length ? <div className="device-list">{activeDevices.map((device) => <div className="device-row" key={device.deviceId}><span className="device-row-icon">{/телефон|phone|mobile/i.test(device.name || "") ? "▯" : "▣"}</span><div><strong>{device.name || "Устройство"}</strong><small>Подключено {device.createdAt ? new Date(device.createdAt).toLocaleDateString("ru-RU") : "к профилю"}{device.lastSeenAt ? ` · был онлайн ${new Date(device.lastSeenAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}` : ""}</small></div><button className="device-revoke" disabled={busy} onClick={() => run(() => revokeProfileDevice(device.deviceId), () => "Доступ устройства отозван.")}>Отозвать доступ</button></div>)}</div> : <div className="device-empty">Пока подключён только этот экран. Добавь телефон или телевизор, чтобы продолжать просмотр.</div>}
        {revokedDevices.length > 0 && <details className="device-revoked"><summary>Отключённые устройства · {revokedDevices.length}</summary>{revokedDevices.map((device) => <div className="device-row is-revoked" key={device.deviceId}><span className="device-row-icon">×</span><div><strong>{device.name || "Устройство"}</strong><small>Доступ отозван</small></div></div>)}</details>}
      </section></div>
    </>}
    <footer className="device-privacy"><p><strong>Безопасность и приватность</strong><br/>Связь использует короткоживущий одноразовый код. Отозванное устройство больше не получит обновления профиля. Просмотр доступен локально даже без сети.</p></footer>
  </main>;
}
