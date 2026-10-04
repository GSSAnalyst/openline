(() => {
  // Replaced by the server's list (STUN + TURN) once the user can call.
  let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  const $ = (id) => document.getElementById(id);
  const gate = $('gate'), call = $('call');
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

  function setStatus(text, live = false) {
    statusText.textContent = text;
    lamp.classList.toggle('live', live);
  }

  function showPlaceholder(text) {
    placeholder.textContent = text;
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
    $('loginTab').setAttribute('aria-selected', String(mode === 'login'));
    $('signupTab').setAttribute('aria-selected', String(mode === 'signup'));
    $('authBtn').textContent = mode === 'login' ? 'Log in' : 'Create account';
    $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('agreeRow').hidden = mode === 'login';
    $('authError').textContent = '';
  }
  $('loginTab').addEventListener('click', () => setMode('login'));
  $('signupTab').addEventListener('click', () => setMode('signup'));

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
      await route();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      $('authBtn').disabled = false;
    }
  });

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

  // ---------- Account settings ----------
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

  async function enterCall() {
    gate.hidden = true;
    call.hidden = false;
    nextBtn.disabled = false;
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
      showPlaceholder('Openline needs your camera and microphone. Allow access in your browser settings, then reload the page.');
      nextBtn.disabled = true;
    }
  }

  // ---------- Signaling ----------
  // The socket is authenticated by the session cookie, so nothing is sent here.
  function connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      let ready = false;
      ws = new WebSocket(proto + location.host);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ready') { ready = true; resolve(); }
        onServerMessage(msg);
      };
      ws.onclose = (e) => {
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
        } else {
          setStatus('Disconnected');
          showPlaceholder('Connection to Openline lost. Press Start to reconnect.');
        }
      };
    });
  }

  const sendWS = (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const sendSignal = (data) => sendWS({ type: 'signal', data });

  async function onServerMessage(msg) {
    switch (msg.type) {
      case 'waiting':
        setStatus('Looking for someone');
        showPlaceholder(msg.interests && msg.interests.length
          ? `Looking for someone into ${msg.interests.join(', ')}. If nobody turns up in a few seconds, we'll match you with anyone.`
          : 'Looking for someone to talk to.');
        break;
      case 'matched':
        setStatus('Connecting');
        clearChat();
        addLine('sys', msg.common && msg.common.length
          ? `You're talking to someone. You both like ${msg.common.join(', ')}.`
          : "You're talking to someone. Say hi!");
        createPeer();
        if (msg.role === 'caller') {
          setupChannel(pc.createDataChannel('chat', { ordered: true }));
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignal({ sdp: pc.localDescription });
        }
        updateButtons();
        break;
      case 'signal':
        await handleSignal(msg.data);
        break;
      case 'peer-left':
        addLine('sys', 'They left.');
        closePeer();
        setStatus('They left');
        findNext();
        break;
      case 'reported':
        setStatus('Report sent');
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
    pc = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    pc.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
      placeholder.hidden = true;
    };
    pc.ondatachannel = (e) => setupChannel(e.channel);
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        setStatus('Connected, encrypted peer to peer', true);
        showSafetyCode(pc);
      }
      if (pc.connectionState === 'failed') { setStatus('Call failed to connect'); findNext(); }
    };
  }

  async function handleSignal(data) {
    if (!pc || !data) return;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          sendSignal({ sdp: pc.localDescription });
        }
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        pendingCandidates = [];
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      console.warn('Signaling error', err);
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

  const sendChan = (m) => chan && chan.readyState === 'open' && chan.send(JSON.stringify(m));

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
    remoteVideo.srcObject = null;
    updateButtons();
  }

  // ---------- Controls ----------
  async function findNext() {
    if (!ws) {
      try { await connect(); } catch { return; }
    }
    closePeer();
    searching = true;
    updateButtons();
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
    nextBtn.textContent = searching ? 'Next' : 'Start';
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

  micBtn.addEventListener('click', () => {
    const track = localStream && localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    micBtn.textContent = track.enabled ? 'Mute' : 'Unmute';
    micBtn.setAttribute('aria-pressed', String(!track.enabled));
  });

  camBtn.addEventListener('click', () => {
    const track = localStream && localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    camBtn.textContent = track.enabled ? 'Camera off' : 'Camera on';
    camBtn.setAttribute('aria-pressed', String(!track.enabled));
  });
})();
