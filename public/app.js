(() => {
  // Replaced by the server's list (STUN + TURN) once the user can call.
  let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  const $ = (id) => document.getElementById(id);
  const gate = $('gate'), call = $('call'), stage = $('stage');
  const remoteVideo = $('remoteVideo'), localVideo = $('localVideo');
  const statusText = $('statusText'), lamp = $('lamp'), placeholder = $('placeholder');
  const nextBtn = $('nextBtn'), stopBtn = $('stopBtn'), reportBtn = $('reportBtn');
  const micBtn = $('micBtn'), camBtn = $('camBtn');

  let me = null;           // { email, verified, suspended } from the server session
  let ws = null;
  let pc = null;
  let localStream = null;
  let pendingCandidates = [];
  let searching = false;
  let chan = null;          // WebRTC data channel for text chat
  let typingTimer = null;
  let lastTypingSent = 0;
  let reconnectTries = 0;

  // state: '' (idle), 'searching', or 'live'
  function setStatus(text, state = '') {
    statusText.textContent = text;
    lamp.className = 'lamp' + (state ? ' ' + state : '');
  }

  // mode: 'idle', 'searching', or 'error'
  function showPlaceholder(text, mode = 'idle') {
    $('placeholderText').textContent = text;
    placeholder.className = 'placeholder ' + mode;
    placeholder.hidden = false;
  }

  // ---------- Accounts ----------
  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  function showGate(view) {
    stopMedia();
    call.hidden = true;
    gate.hidden = false;
    $('bootView').hidden = true;
    for (const id of ['authView', 'verifyView', 'suspendedView']) $(id).hidden = id !== view;
  }

  // Sends the user to the right screen for their account state.
  async function route() {
    if (!me) return showGate('authView');
    if (me.suspended) return showGate('suspendedView');
    if (!me.verified) {
      $('verifyWho').textContent = me.email;
      return showGate('verifyView');
    }
    $('whoami').textContent = me.email;
    await enterCall();
  }

  let mode = 'login';
  function setMode(next) {
    mode = next;
    $('tabs').dataset.mode = mode;
    $('loginTab').setAttribute('aria-selected', String(mode === 'login'));
    $('signupTab').setAttribute('aria-selected', String(mode === 'signup'));
    $('authBtn').textContent = mode === 'login' ? 'Log in' : 'Create account';
    $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('agreeRow').hidden = mode === 'login';
    $('pwHint').hidden = mode === 'login';
    $('authError').textContent = '';
  }
  $('loginTab').addEventListener('click', () => setMode('login'));
  $('signupTab').addEventListener('click', () => setMode('signup'));

  $('pwToggle').addEventListener('click', () => {
    const show = $('password').type === 'password';
    $('password').type = show ? 'text' : 'password';
    $('pwToggle').setAttribute('aria-pressed', String(show));
    $('pwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('authError');
    err.textContent = '';
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
    if (mode === 'signup') {
      if (password.length < 8) { err.textContent = 'Use a password of at least 8 characters.'; return; }
      if (!$('agree').checked) { err.textContent = 'Confirm you are 18 or older and agree to the Terms.'; return; }
    }
    $('authBtn').disabled = true;
    try {
      ({ user: me } = await api(mode === 'login' ? '/api/login' : '/api/signup', { email, password }));
      $('password').value = '';
      $('password').type = 'password';
      await route();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      $('authBtn').disabled = false;
    }
  });

  // The date picker shouldn't offer dates in the future.
  $('dob').max = new Date().toISOString().slice(0, 10);

  $('verifyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('formError');
    err.textContent = '';
    if (!$('dob').value) { err.textContent = 'Enter your date of birth.'; return; }
    $('verifyBtn').disabled = true;
    try {
      ({ user: me } = await api('/api/verify/age', { dob: $('dob').value }));
      await route();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      $('verifyBtn').disabled = false;
    }
  });

  async function logout() {
    stopMedia();
    await api('/api/logout', {}).catch(() => {});
    me = null;
    setMode('login');
    showGate('authView');
  }
  document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', logout));

  // ---------- Feedback ----------
  const feedbackDialog = $('feedbackDialog');
  $('feedbackBtn').addEventListener('click', () => {
    $('feedbackError').textContent = $('feedbackOk').textContent = '';
    $('feedbackSend').disabled = false;
    feedbackDialog.showModal();
    $('feedbackText').focus();
  });
  $('feedbackClose').addEventListener('click', () => feedbackDialog.close());
  $('feedbackForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('feedbackError').textContent = $('feedbackOk').textContent = '';
    const message = $('feedbackText').value.trim();
    if (!message) { $('feedbackError').textContent = 'Write a message first.'; return; }
    $('feedbackSend').disabled = true;
    try {
      await api('/api/feedback', { message });
      $('feedbackText').value = '';
      $('feedbackOk').textContent = 'Thanks! Your feedback was sent.';
    } catch (ex) {
      $('feedbackError').textContent = ex.message;
    } finally {
      $('feedbackSend').disabled = false;
    }
  });

  // ---------- Account settings ----------
  const settingsDialog = $('settingsDialog');
  $('settingsBtn').addEventListener('click', () => {
    $('settingsEmail').textContent = me ? me.email : '';
    for (const id of ['passwordError', 'passwordOk', 'deleteError']) $(id).textContent = '';
    $('passwordForm').reset();
    $('deleteForm').reset();
    settingsDialog.showModal();
  });
  $('settingsClose').addEventListener('click', () => settingsDialog.close());

  $('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('passwordError').textContent = $('passwordOk').textContent = '';
    if ($('newPassword').value.length < 8) { $('passwordError').textContent = 'Use a new password of at least 8 characters.'; return; }
    try {
      await api('/api/account/password', { password: $('curPassword').value, newPassword: $('newPassword').value });
      $('passwordForm').reset();
      $('passwordOk').textContent = 'Password updated. Other devices were logged out.';
    } catch (ex) {
      $('passwordError').textContent = ex.message;
    }
  });

  $('logoutAllBtn').addEventListener('click', async () => {
    stopMedia();
    await api('/api/account/logout-all', {}).catch(() => {});
    settingsDialog.close();
    me = null;
    setMode('login');
    showGate('authView');
  });

  $('deleteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('deleteError').textContent = '';
    if (!confirm('Delete your Openline account permanently?')) return;
    try {
      stopMedia();
      await api('/api/account/delete', { password: $('deletePassword').value });
      settingsDialog.close();
      me = null;
      setMode('signup');
      showGate('authView');
      $('authError').textContent = 'Your account was deleted.';
    } catch (ex) {
      $('deleteError').textContent = ex.message;
      if (me) route();
    }
  });

  fetch('/api/config').then(r => r.json()).then(c => {
    // Only shown to you when running on your own machine, not to visitors.
    $('devNote').hidden = !(c.dev && ['localhost', '127.0.0.1'].includes(location.hostname));
    $('verifyForm').hidden = !c.selfDeclaredAge;
    $('verifyUnavailable').hidden = c.selfDeclaredAge;
  }).catch(() => {});
  api('/api/me').then((d) => { me = d.user; }).catch(() => {}).finally(route);

  function stopMedia() {
    if (ws) { ws.onclose = null; ws.close(1000); ws = null; }
    closePeer();
    searching = false;
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  function resetMediaButtons() {
    for (const [btn, on, off] of [[micBtn, 'Mute microphone', 'Unmute microphone'], [camBtn, 'Turn camera off', 'Turn camera on']]) {
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', on);
      btn.title = on;
      btn.dataset.off = off;
      btn.dataset.on = on;
    }
    $('pip').classList.remove('cam-off');
  }

  async function enterCall() {
    gate.hidden = true;
    call.hidden = false;
    nextBtn.disabled = false;
    reconnectTries = 0;
    resetMediaButtons();
    setStatus('Starting camera');
    showPlaceholder('Press Start to meet someone.');
    updateButtons();
    api('/api/ice').then((c) => { rtcConfig = { iceServers: c.iceServers }; }).catch(() => {});
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      setStatus('Ready');
    } catch {
      setStatus('Camera blocked');
      showPlaceholder('Openline needs your camera and microphone. Allow access in your browser settings, then reload the page.', 'error');
      nextBtn.disabled = true;
    }
  }

  // ---------- Signaling ----------
  // The socket is authenticated by the session cookie, so nothing is sent here.
  function connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      let ready = false;
      const sock = new WebSocket(proto + location.host);
      ws = sock;
      sock.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'ready') { ready = true; reconnectTries = 0; resolve(); }
        onServerMessage(msg);
      };
      sock.onclose = (e) => {
        if (ws !== sock) return;
        const wasSearching = searching;
        closePeer();
        searching = false;
        updateButtons();
        ws = null;
        if (!ready) reject(new Error('not connected'));
        if (e.code === 4001) {
          me = null;
          showGate('authView');
          $('authError').textContent = 'You were logged out. Log in to continue.';
        } else if (e.code === 4003) {
          me = { ...me, verified: false };
          route();
        } else if (e.code === 4004) {
          me = { ...me, suspended: true };
          route();
        } else if (wasSearching && reconnectTries < 3) {
          // Brief network drop or server restart: try to pick up where we left off.
          reconnectTries++;
          setStatus('Reconnecting', 'searching');
          showPlaceholder('Connection dropped. Reconnecting…', 'searching');
          setTimeout(() => {
            if (ws || call.hidden) return;
            searching = true; // so a failed attempt retries again
            findNext();
          }, 1000 * reconnectTries);
        } else {
          setStatus('Disconnected');
          showPlaceholder('Connection to Openline lost. Press Start to reconnect.', 'error');
        }
      };
    });
  }

  const sendWS = (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const sendSignal = (data) => sendWS({ type: 'signal', data });

  async function onServerMessage(msg) {
    switch (msg.type) {
      case 'waiting':
        setStatus('Looking for someone', 'searching');
        showPlaceholder(msg.interests && msg.interests.length
          ? `Looking for someone into ${msg.interests.join(', ')}. If nobody turns up in a few seconds, we'll match you with anyone.`
          : 'Looking for someone to talk to…', 'searching');
        break;
      case 'matched': {
        setStatus('Connecting', 'searching');
        showPlaceholder('Found someone. Connecting…', 'searching');
        clearChat();
        addLine('sys', msg.common && msg.common.length
          ? `You're talking to someone. You both like ${msg.common.join(', ')}.`
          : "You're talking to someone. Say hi!");
        const conn = createPeer();
        updateButtons();
        if (msg.role === 'caller') {
          setupChannel(conn.createDataChannel('chat', { ordered: true }));
          try {
            await conn.setLocalDescription(await conn.createOffer());
            // Skip if the user pressed Next while the offer was being made.
            if (conn === pc) sendSignal({ sdp: conn.localDescription });
          } catch (err) {
            console.warn('Offer failed', err);
          }
        }
        break;
      }
      case 'signal':
        await handleSignal(msg.data);
        break;
      case 'peer-left':
        addLine('sys', 'They left.');
        closePeer();
        setStatus('They left', 'searching');
        findNext();
        break;
      case 'reported':
        setStatus('Report sent. Finding someone new', 'searching');
        break;
      case 'error':
        setStatus(msg.message);
        break;
      case 'online':
        $('online').hidden = false;
        $('online').textContent = `${msg.count} online`;
        break;
    }
  }

  // ---------- WebRTC ----------
  function createPeer() {
    closePeer();
    const conn = new RTCPeerConnection(rtcConfig);
    pc = conn;
    if (localStream) localStream.getTracks().forEach((t) => conn.addTrack(t, localStream));
    conn.ontrack = (e) => {
      if (conn !== pc) return;
      remoteVideo.srcObject = e.streams[0];
      // Mobile browsers sometimes need an explicit play() for audio.
      remoteVideo.play().catch(() => {});
    };
    conn.ondatachannel = (e) => setupChannel(e.channel);
    conn.onicecandidate = (e) => { if (e.candidate && conn === pc) sendSignal({ candidate: e.candidate }); };
    conn.onconnectionstatechange = () => {
      if (conn !== pc) return;
      const state = conn.connectionState;
      if (state === 'connected') {
        setStatus('Connected · encrypted', 'live');
        placeholder.hidden = true;
        stage.classList.add('has-remote');
        showSafetyCode(conn);
      } else if (state === 'disconnected') {
        setStatus('Connection unstable', 'searching');
      } else if (state === 'failed') {
        setStatus('Couldn\'t connect. Trying someone else', 'searching');
        findNext();
      }
    };
    return conn;
  }

  async function handleSignal(data) {
    const conn = pc;
    if (!conn || !data) return;
    try {
      if (data.sdp) {
        await conn.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await conn.setLocalDescription(await conn.createAnswer());
          if (conn === pc) sendSignal({ sdp: conn.localDescription });
        }
        const queued = pendingCandidates;
        pendingCandidates = [];
        for (const c of queued) await conn.addIceCandidate(c);
      } else if (data.candidate) {
        if (conn.remoteDescription) await conn.addIceCandidate(data.candidate);
        else pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      if (conn === pc) console.warn('Signaling error', err);
    }
  }

  // Both browsers derive the same code from the two encryption key
  // fingerprints. If the server swapped in its own keys, the codes would differ.
  async function showSafetyCode(conn) {
    const fp = (sdp) => (/a=fingerprint:\S+ ([0-9A-F:]+)/i.exec(sdp || '') || [])[1];
    const a = fp(conn.localDescription && conn.localDescription.sdp);
    const b = fp(conn.remoteDescription && conn.remoteDescription.sdp);
    if (!a || !b || !crypto.subtle) return;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|')));
    if (conn !== pc) return;
    const n = new DataView(digest).getUint32(0) % 1_000_000;
    const code = String(n).padStart(6, '0');
    $('safetyCode').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
    $('safety').hidden = false;
  }

  // ---------- Text chat (peer to peer over the encrypted connection) ----------
  const chatLog = $('chatLog'), chatInput = $('chatInput'), sendBtn = $('sendBtn');

  function addLine(kind, text) {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = text;
    chatLog.append(li);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function clearChat() {
    chatLog.replaceChildren();
    $('typing').textContent = '';
  }

  function setChatEnabled(on) {
    chatInput.disabled = sendBtn.disabled = !on;
    chatInput.placeholder = on ? 'Say hi' : 'Chat opens when you are connected';
  }

  function setupChannel(c) {
    chan = c;
    c.onopen = () => { if (chan === c) setChatEnabled(true); };
    c.onclose = () => { if (chan === c) setChatEnabled(false); };
    c.onmessage = (e) => {
      if (chan !== c) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'msg' && typeof m.text === 'string') {
        $('typing').textContent = '';
        addLine('them', m.text.slice(0, 1000));
      } else if (m.t === 'typing') {
        $('typing').textContent = 'Typing…';
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => { $('typing').textContent = ''; }, 3000);
      }
    };
  }

  // Returns whether the message went out (send() itself returns nothing).
  function sendChan(m) {
    if (!chan || chan.readyState !== 'open') return false;
    chan.send(JSON.stringify(m));
    return true;
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !sendChan({ t: 'msg', text })) return;
    addLine('me', text);
    chatInput.value = '';
  });

  chatInput.addEventListener('input', () => {
    if (Date.now() - lastTypingSent > 2000) {
      lastTypingSent = Date.now();
      sendChan({ t: 'typing' });
    }
  });

  // ---------- Interests (remembered in this browser) ----------
  const interestsInput = $('interests');
  try { interestsInput.value = localStorage.getItem('ol_interests') || ''; } catch {}
  interestsInput.addEventListener('change', () => {
    try { localStorage.setItem('ol_interests', interestsInput.value); } catch {}
  });
  const readInterests = () => interestsInput.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5);

  function closePeer() {
    if (pc) { pc.ontrack = pc.ondatachannel = pc.onicecandidate = pc.onconnectionstatechange = null; pc.close(); }
    pc = null;
    if (chan) { chan.onopen = chan.onclose = chan.onmessage = null; chan = null; }
    setChatEnabled(false);
    $('typing').textContent = '';
    $('safety').hidden = true;
    pendingCandidates = [];
    stage.classList.remove('has-remote');
    remoteVideo.srcObject = null;
    updateButtons();
  }

  // ---------- Controls ----------
  async function findNext() {
    if (!ws) {
      setStatus('Connecting to Openline', 'searching');
      try { await connect(); } catch { return; }
    }
    closePeer();
    searching = true;
    updateButtons();
    showPlaceholder('Looking for someone to talk to…', 'searching');
    sendWS({ type: 'find', interests: readInterests() });
  }

  function stop() {
    sendWS({ type: 'leave' });
    closePeer();
    searching = false;
    updateButtons();
    setStatus('Stopped');
    showPlaceholder('Press Start to meet someone.');
  }

  function updateButtons() {
    $('nextLabel').textContent = searching ? 'Next' : 'Start';
    stopBtn.disabled = !searching;
    reportBtn.disabled = !pc;
  }

  nextBtn.addEventListener('click', findNext);
  stopBtn.addEventListener('click', stop);

  reportBtn.addEventListener('click', () => { $('reportForm').reset(); $('reportDialog').showModal(); });
  $('reportDialog').addEventListener('close', () => {
    if ($('reportDialog').returnValue !== 'submit') return;
    const reason = new FormData($('reportForm')).get('reason') || 'other';
    sendWS({ type: 'report', reason });
    closePeer();
    findNext();
  });

  // ---------- Keyboard shortcuts ----------
  document.addEventListener('keydown', (e) => {
    if (call.hidden || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && !nextBtn.disabled) {
      e.preventDefault();
      findNext();
    } else if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && !chatInput.disabled) {
      e.preventDefault();
      chatInput.focus();
    }
  });

  // ---------- Mic and camera ----------
  function toggleTrack(btn, track) {
    if (!track) return;
    track.enabled = !track.enabled;
    const label = track.enabled ? btn.dataset.on : btn.dataset.off;
    btn.setAttribute('aria-pressed', String(!track.enabled));
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  micBtn.addEventListener('click', () => toggleTrack(micBtn, localStream && localStream.getAudioTracks()[0]));
  camBtn.addEventListener('click', () => {
    const track = localStream && localStream.getVideoTracks()[0];
    toggleTrack(camBtn, track);
    if (track) $('pip').classList.toggle('cam-off', !track.enabled);
  });
})();
