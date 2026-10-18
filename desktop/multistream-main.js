'use strict';

// The main-process half of the bot's multistream relay (desktop/bot/relay.js):
// signing in to YouTube with Google, and sending to TikTok. Reading YouTube
// and TikTok chat is done by desktop/sources/, like for the reader.

const { ipcMain, shell } = require('electron');
const crypto = require('node:crypto');
const http = require('node:http');
const { TikTokSender } = require('./sources/tiktok');

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const LOGIN_TIMEOUT_MS = 5 * 60000;

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let pendingLogin = null;   // { server, reject }

function cancelLogin(why = 'Cancelled') {
  if (!pendingLogin) return;
  const { server, reject } = pendingLogin;
  pendingLogin = null;
  server.close();
  reject(new Error(why));
}

const DONE_PAGE = (ok) => `<!doctype html><meta charset="utf-8"><title>Chat Reader</title>
<body style="font:16px system-ui;padding:40px;background:#18171e;color:#ecebf1">
<h1 style="font-size:20px">${ok ? 'YouTube is connected.' : 'That didn’t work.'}</h1>
<p>${ok ? 'You can close this tab and go back to Chat Reader.' : 'Go back to Chat Reader and try again.'}</p></body>`;

// Google's sign-in for desktop apps: the browser comes back to a one-off
// server on 127.0.0.1 with a code, which is swapped for tokens (with PKCE).
function googleLogin(clientId, clientSecret) {
  cancelLogin('Started again');
  return new Promise((resolve, reject) => {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));
    let redirect = '';
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const code = url.searchParams.get('code');
      const ok = !!code && url.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DONE_PAGE(ok));
      if (!pendingLogin || pendingLogin.server !== server) return;
      pendingLogin = null;
      server.close();
      if (!ok) { reject(new Error(url.searchParams.get('error') || 'Google didn’t give a code')); return; }
      try {
        const tokenRes = await fetch(GOOGLE_TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
        });
        const body = await tokenRes.json();
        if (!tokenRes.ok) throw new Error(body.error_description || body.error || `Google said ${tokenRes.status}`);
        resolve({ accessToken: body.access_token, refreshToken: body.refresh_token || '', expiresAt: Date.now() + (body.expires_in || 3600) * 1000 });
      } catch (err) {
        reject(err);
      }
    });
    server.on('error', (err) => { pendingLogin = null; reject(err); });
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}/`;
      pendingLogin = { server, reject };
      const params = new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: YOUTUBE_SCOPE,
        access_type: 'offline', prompt: 'consent select_account', code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      shell.openExternal(`${GOOGLE_AUTH}?${params}`);
      setTimeout(() => { if (pendingLogin && pendingLogin.server === server) cancelLogin('Nothing came back from Google in five minutes'); }, LOGIN_TIMEOUT_MS);
    });
  });
}

function setup({ getSecret }) {
  const tiktok = new TikTokSender();

  ipcMain.handle('youtube:login', async (_event, { clientId = '' } = {}) => {
    const secret = getSecret('youtube-client-secret') || '';
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(String(clientId))) return { error: 'That doesn’t look like a Google OAuth Client ID (it ends in .apps.googleusercontent.com)' };
    if (!secret) return { error: 'Enter the Client secret too' };
    try {
      return { tokens: await googleLogin(String(clientId), secret) };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('youtube:cancel-login', () => { cancelLogin(); return true; });

  ipcMain.handle('tiktok:send', async (_event, { handle = '', text = '' } = {}) => {
    const clean = String(handle).replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_.]{2,24}$/.test(clean)) return { error: 'No TikTok username to send to' };
    let session = {};
    try { session = JSON.parse(getSecret('tiktok-session') || '{}'); } catch {}
    try {
      await tiktok.send(clean, String(text), { apiKey: getSecret('tiktok-sign-key') || '', sessionId: session.sessionId || '', ttTargetIdc: session.ttTargetIdc || '' });
      return { ok: true };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });
}

module.exports = { setup };
