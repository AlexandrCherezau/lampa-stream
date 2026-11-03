// Site-password gate for the web build. Shown as a full-screen overlay before
// the React app mounts, until the visitor enters the site password. The
// password hash is baked in at build time via VITE_SITE_PWD_HASH env (SHA-256 of
// the password). On success we set a localStorage flag so the password is
// NEVER asked again on this device.
//
// This is a light gate against casual visitors, not real security — the "secret"
// is a hash shipped in the client bundle. For stronger auth, run the Express
// server (server/index.js) on a VPS instead of Vercel static.

const LS_FLAG = "lampa_stream_site_pwd";

function pwdHash(s) {
  // SHA-256 via SubtleCrypto (async). Returns hex.
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(s))
    .then((buf) =>
      [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
}

export async function ensureSiteGate() {
  try {
    if (localStorage.getItem(LS_FLAG) === "ok") return;
  } catch {}
  const expected = import.meta.env.VITE_SITE_PWD_HASH || "";
  if (!expected) {
    // No password configured → no gate (open site).
    return;
  }
  // If React already rendered, hide it until authed.
  const root = document.getElementById("root");
  if (root) root.style.visibility = "hidden";

  const gate = document.createElement("div");
  gate.id = "ls-site-gate";
  gate.innerHTML = `
    <div style="min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#f0f0f0;font-family:system-ui,sans-serif;padding:20px">
      <form id="ls-gate-form" style="background:#111;border:1px solid #2a2a2a;border-radius:14px;padding:32px 28px;width:100%;max-width:360px;box-sizing:border-box">
        <h1 style="font-size:20px;margin:0 0 6px;text-align:center">Nahflix</h1>
        <p style="color:#909090;margin:0 0 22px;text-align:center;font-size:13px">Введите пароль сайта</p>
        <input id="ls-gate-pw" type="password" placeholder="Пароль" autofocus
          style="width:100%;box-sizing:border-box;padding:13px 14px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:9px;color:#fff;font-size:15px;margin-bottom:14px">
        <button type="submit" style="width:100%;padding:13px;background:#e50914;color:#fff;border:none;border-radius:9px;font-size:15px;cursor:pointer;font-weight:600">Войти</button>
        <div id="ls-gate-err" style="color:#ff6b6b;font-size:13px;text-align:center;margin-top:12px;min-height:18px"></div>
        <div style="color:#606060;font-size:11px;text-align:center;margin-top:16px;line-height:1.5">После входа введите свой TMDB Read Access Token</div>
      </form>
    </div>`;
  (document.body || document.documentElement).appendChild(gate);
  const form = gate.querySelector("#ls-gate-form");
  const input = gate.querySelector("#ls-gate-pw");
  const err = gate.querySelector("#ls-gate-err");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const hash = await pwdHash(input.value);
    if (hash === expected) {
      try { localStorage.setItem(LS_FLAG, "ok"); } catch {}
      gate.remove();
      if (root) root.style.visibility = "";
    } else {
      err.textContent = "Неверный пароль";
      input.select();
    }
  });
}
