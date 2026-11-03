import { useState, useEffect, useRef } from "react";
import { StreambertLogo, PlayIcon } from "./Icons";
import { tmdbApiBase, withLanguage } from "../utils/api";

async function validateToken(token) {
  const TMDB_BASE = tmdbApiBase();
  // Validate with /movie/550 (Fight Club) — a stable, lightweight, well-cached
  // endpoint. We previously used /configuration, but TMDB has a per-token
  // backend routing bug: certain endpoints hang ~8s for some Read Access
  // Tokens depending on query-param order (see withLanguage in utils/api.js).
  // /movie/550 with the canonicalized query order responds in ~0.3s for every
  // token we've tested. 401 = invalid token, 200 = valid.
  const probePath = withLanguage("/movie/550");
  try {
    const pingRes = await fetch(`${TMDB_BASE}${probePath}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(11000),
    });

    if (pingRes.status === 401) {
      return { ok: false, reason: "invalid_token" };
    }
    if (pingRes.status === 403) {
      return { ok: false, reason: "forbidden" };
    }
    if (pingRes.status === 504) {
      return { ok: false, reason: "timeout" };
    }
    if (!pingRes.ok) {
      return { ok: false, reason: "tmdb_error", status: pingRes.status };
    }

    return { ok: true };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    // Network failure — TMDB not reachable
    return { ok: false, reason: "unreachable" };
  }
}

function errorMessage(reason, status) {
  switch (reason) {
    case "invalid_token":
      return {
        title: "Invalid token",
        body: "TMDB rejected the token (401 Unauthorized). Make sure you copied the long JWT Read Access Token, not the shorter API Key.",
      };
    case "forbidden":
      return {
        title: "Access denied",
        body: "TMDB returned 403 Forbidden. Your account may be suspended or the token may have been revoked.",
      };
    case "timeout":
      return {
        title: "Request timed out",
        body: "TMDB took too long to respond. Check your internet connection and try again.",
      };
    case "unreachable":
      return {
        title: "Cannot reach TMDB",
        body: "No connection to api.themoviedb.org. Check your internet connection.",
      };
    default:
      return {
        title: "Something went wrong",
        body: `TMDB returned an unexpected error${status ? ` (HTTP ${status})` : ""}. Try again in a moment.`,
      };
  }
}

function ExternalLink({ href, className, children }) {
  return (
    <a
      className={className}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        window.electron.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

export default function SetupScreen({ onSave, onSkip }) {
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null); // { title, body }
  const inputRef = useRef(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      window.focus();
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = async () => {
    const token = key.trim();
    if (!token) return;
    setChecking(true);
    setError(null);
    const result = await validateToken(token);
    setChecking(false);
    if (result.ok) {
      onSave(token);
    } else {
      setError(errorMessage(result.reason, result.status));
    }
  };

  return (
    <div className="apikey-modal">
      <div className="apikey-box">
        <div className="apikey-logo">
          <StreambertLogo />
        </div>
        <div className="apikey-title">NAHFLIX</div>
        <p className="apikey-sub">
          Чтобы начать, введите <strong>бесплатный</strong> токен TMDB{" "}
          <strong>Read Access Token</strong>.
          <br />
          Откройте{" "}
          <ExternalLink
            className="apikey-link"
            href="https://www.themoviedb.org/settings/api"
          >
            themoviedb.org → Settings → API
          </ExternalLink>{" "}
          и скопируйте <em>API Read Access Token</em>: это длинный токен, а не
          короткий API Key под ним.
          <br />
          <ExternalLink
            className="apikey-link"
            href="https://github.com/truelockmc/streambert/blob/main/tmdb-tutorial.md"
          >
            Пошаговая инструкция, как получить токен
          </ExternalLink>
        </p>
        <input
          className={`apikey-input${error ? " apikey-input-error" : ""}`}
          placeholder="Токен TMDB (eyJ…)"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && !checking && handleSubmit()}
          ref={inputRef}
          disabled={checking}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            borderColor: error ? "#f44336" : focused ? "var(--red)" : undefined,
          }}
        />

        {error && (
          <div className="apikey-error-box">
            <div className="apikey-error-title">⚠ {error.title}</div>
            <div className="apikey-error-body">{error.body}</div>
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{
            width: "100%",
            justifyContent: "center",
            padding: "13px",
            marginTop: error ? 0 : undefined,
          }}
          onClick={handleSubmit}
          disabled={!key.trim() || checking}
        >
          {checking ? (
            <>
              <span className="apikey-spinner" /> Checking…
            </>
          ) : (
            <>
              <PlayIcon /> Начать
            </>
          )}
        </button>

        {onSkip && (
          <button
            onClick={onSkip}
            style={{
              marginTop: 14,
              background: "none",
              border: "none",
              color: "var(--text3)",
              fontSize: 13,
              cursor: "pointer",
              padding: "6px 0",
              width: "100%",
              textAlign: "center",
              transition: "color 0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text2)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text3)")}
          >
            Пока пропустить
          </button>
        )}
      </div>
    </div>
  );
}
