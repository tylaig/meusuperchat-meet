(function () {
  'use strict';

  var CFG = window.MSC_MEET_CONFIG || {};
  var LK = window.LivekitClient;

  var state = {
    role: CFG.initialRole === 'host' ? 'host' : 'guest',
    name: CFG.initialName || 'Participante Executivo',
    identity: '',
    lobbyMicOn: true,
    lobbyCamOn: true,
    lobbyStream: null,
    audioCtx: null,
    analyser: null,
    meterFrame: null,
    room: null,
    roomMicOn: true,
    roomCamOn: false,
    screenShareOn: false,
    handRaised: false,
    layout: 'grid',
    activeTab: 'chat',
    drawerOpen: window.innerWidth > 1024,
    timerInterval: null,
    startedAt: null,
    agendaItems: Array.isArray(CFG.initialState && CFG.initialState.agenda_items)
      ? CFG.initialState.agenda_items
      : [
          { id: 'ag-1', text: 'Alinhamento de escopo e objetivos da sessão', done: false },
          { id: 'ag-2', text: 'Demonstração ao vivo / Diagnóstico de fluxos', done: false },
          { id: 'ag-3', text: 'Definição de cronograma e próximos passos', done: false }
        ],
    chatMessages: Array.isArray(CFG.initialState && CFG.initialState.chat_messages)
      ? CFG.initialState.chat_messages
      : [],
    sharedNotes: (CFG.initialState && CFG.initialState.shared_notes) || '',
    raisedHands: {},
    notesDebounce: null,
    theme: 'dark',
    reconnecting: false
  };

  function $(id) {
    return document.getElementById(id);
  }

  function showToast(msg) {
    var el = $('msc-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      el.classList.remove('is-visible');
    }, 3200);
  }

  function preferredTheme() {
    var saved = null;
    try { saved = window.localStorage.getItem('msc-meet-theme'); } catch (e) {}
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
    var btn = $('btn-theme-toggle');
    var icon = $('theme-toggle-icon');
    var label = $('theme-toggle-label');
    var lightActive = state.theme === 'light';
    if (btn) {
      btn.setAttribute('aria-pressed', lightActive ? 'true' : 'false');
      btn.setAttribute('aria-label', lightActive ? 'Alternar para tema escuro' : 'Alternar para tema claro');
    }
    if (icon) icon.textContent = lightActive ? '🌙' : '☀️';
    if (label) label.textContent = lightActive ? 'Tema Escuro' : 'Tema Claro';
  }

  function toggleTheme() {
    var next = state.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { window.localStorage.setItem('msc-meet-theme', next); } catch (e) {}
  }

  function computeInitials(name) {
    var clean = String(name || '').trim();
    if (!clean) return 'MS';
    var parts = clean.split(/\s+/).slice(0, 2);
    return parts
      .map(function (w) { return w.charAt(0).toUpperCase(); })
      .join('') || 'MS';
  }

  function updateAvatarInitials(name) {
    state.name = name;
    var ring = $('lobby-avatar-initials');
    if (ring) ring.textContent = computeInitials(name);
  }

  function selectRole(role) {
    state.role = role === 'host' ? 'host' : 'guest';
    var g = $('role-btn-guest');
    var h = $('role-btn-host');
    if (g) g.classList.toggle('is-active', state.role === 'guest');
    if (h) h.classList.toggle('is-active', state.role === 'host');
  }

  function copyInviteLink() {
    var baseMeet = (window.location.hostname.indexOf('meet.') === 0) ? window.location.origin : 'https://meet.meusuper.app';
    var url = baseMeet + '/' + encodeURIComponent(CFG.roomUid || 'sala-executiva');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        showToast('Link da sala copiado para a área de transferência!');
      }).catch(function () {
        fallbackCopy(url);
      });
    } else {
      fallbackCopy(url);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    showToast('Link da sala copiado!');
  }

  /* ==================== LOBBY HARDWARE PREVIEW ==================== */
  async function initLobbyMedia() {
    var statusText = $('preview-status-text');
    var videoEl = $('lobby-video-preview');
    var fallbackEl = $('lobby-preview-fallback');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state.lobbyCamOn = false;
      state.lobbyMicOn = false;
      updateLobbyButtonsUI();
      if (statusText) statusText.textContent = 'Pronto para entrar (modo navegador sem câmera local)';
      return;
    }

    try {
      var constraints = {
        audio: getSelectedDeviceConstraint('select-audio-input'),
        video: state.lobbyCamOn ? getSelectedDeviceConstraint('select-video-input', { width: { ideal: 1280 }, height: { ideal: 720 } }) : false
      };
      var stream = await navigator.mediaDevices.getUserMedia(constraints);
      stopLobbyStream();
      state.lobbyStream = stream;

      var hasVideo = stream.getVideoTracks().length > 0 && state.lobbyCamOn;
      if (hasVideo && videoEl) {
        videoEl.srcObject = stream;
        videoEl.style.display = 'block';
        if (fallbackEl) fallbackEl.style.display = 'none';
      } else {
        if (videoEl) videoEl.style.display = 'none';
        if (fallbackEl) fallbackEl.style.display = 'flex';
      }

      if (statusText) {
        statusText.textContent = hasVideo ? 'Câmera HD e Áudio prontos' : 'Áudio pronto (Câmera desligada)';
      }

      setupAudioMeter(stream);
      await populateDeviceSelectors();
    } catch (err) {
      // Fallback to audio-only if camera fails or is absent
      try {
        var audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stopLobbyStream();
        state.lobbyStream = audioStream;
        state.lobbyCamOn = false;
        if (videoEl) videoEl.style.display = 'none';
        if (fallbackEl) fallbackEl.style.display = 'flex';
        if (statusText) statusText.textContent = 'Microfone pronto • Entrada sem câmera';
        setupAudioMeter(audioStream);
        await populateDeviceSelectors();
      } catch (err2) {
        state.lobbyCamOn = false;
        state.lobbyMicOn = false;
        if (videoEl) videoEl.style.display = 'none';
        if (fallbackEl) fallbackEl.style.display = 'flex';
        if (statusText) statusText.textContent = 'Pronto para conectar em modo ouvinte / avatar';
      }
    }
    updateLobbyButtonsUI();
  }

  function getSelectedDeviceConstraint(selectId, extra) {
    var sel = $(selectId);
    var base = extra ? Object.assign({}, extra) : {};
    if (sel && sel.value) {
      base.deviceId = { exact: sel.value };
      return base;
    }
    return Object.keys(base).length ? base : true;
  }

  async function populateDeviceSelectors() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      var audioSel = $('select-audio-input');
      var videoSel = $('select-video-input');
      if (audioSel) {
        var curA = audioSel.value;
        var mics = devices.filter(function (d) { return d.kind === 'audioinput'; });
        if (mics.length) {
          audioSel.innerHTML = '';
          mics.forEach(function (d, idx) {
            var opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || ('Microfone ' + (idx + 1));
            audioSel.appendChild(opt);
          });
          if (curA) audioSel.value = curA;
        }
      }
      if (videoSel) {
        var curV = videoSel.value;
        var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
        if (cams.length) {
          videoSel.innerHTML = '';
          cams.forEach(function (d, idx) {
            var opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || ('Câmera ' + (idx + 1));
            videoSel.appendChild(opt);
          });
          if (curV) videoSel.value = curV;
        }
      }
    } catch (e) {}
  }

  function setupAudioMeter(stream) {
    if (!stream || !stream.getAudioTracks().length) return;
    try {
      var AudioContextCls = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCls) return;
      if (state.audioCtx) {
        try { state.audioCtx.close(); } catch (e) {}
      }
      var ctx = new AudioContextCls();
      var src = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      state.audioCtx = ctx;
      state.analyser = analyser;

      var data = new Uint8Array(analyser.frequencyBinCount);
      var meterEl = $('lobby-mic-meter');
      var dbEl = $('lobby-mic-db');
      var waveSpans = document.querySelectorAll('#lobby-wave-bars span');

      cancelAnimationFrame(state.meterFrame);
      function tick() {
        if (!state.analyser) return;
        state.analyser.getByteFrequencyData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        var avg = state.lobbyMicOn ? sum / data.length : 0;
        var pct = Math.min(100, Math.max(4, Math.round((avg / 95) * 100)));
        if (meterEl) meterEl.style.width = pct + '%';
        if (dbEl) dbEl.textContent = state.lobbyMicOn ? (pct > 14 ? 'Captando voz' : 'Ativo') : 'Mutado';
        if (waveSpans && waveSpans.length) {
          for (var j = 0; j < waveSpans.length; j++) {
            var h = state.lobbyMicOn ? Math.max(6, Math.min(22, Math.round((data[j * 4] || 0) / 10))) : 5;
            waveSpans[j].style.height = h + 'px';
          }
        }
        state.meterFrame = requestAnimationFrame(tick);
      }
      tick();
    } catch (e) {}
  }

  function stopLobbyStream() {
    cancelAnimationFrame(state.meterFrame);
    if (state.lobbyStream) {
      state.lobbyStream.getTracks().forEach(function (t) { t.stop(); });
      state.lobbyStream = null;
    }
    if (state.audioCtx) {
      try { state.audioCtx.close(); } catch (e) {}
      state.audioCtx = null;
      state.analyser = null;
    }
  }

  function updateLobbyButtonsUI() {
    var micBtn = $('btn-lobby-mic');
    var camBtn = $('btn-lobby-cam');
    var micLbl = $('label-lobby-mic');
    var camLbl = $('label-lobby-cam');

    if (micBtn) micBtn.classList.toggle('is-off', !state.lobbyMicOn);
    if (camBtn) camBtn.classList.toggle('is-off', !state.lobbyCamOn);
    if (micLbl) micLbl.textContent = state.lobbyMicOn ? 'Microfone Ativo' : 'Microfone Mutado';
    if (camLbl) camLbl.textContent = state.lobbyCamOn ? 'Câmera Ativa' : 'Câmera Desligada';
  }

  function toggleLobbyMic() {
    state.lobbyMicOn = !state.lobbyMicOn;
    if (state.lobbyStream) {
      state.lobbyStream.getAudioTracks().forEach(function (t) {
        t.enabled = state.lobbyMicOn;
      });
    }
    updateLobbyButtonsUI();
  }

  async function toggleLobbyCam() {
    state.lobbyCamOn = !state.lobbyCamOn;
    var videoEl = $('lobby-video-preview');
    var fallbackEl = $('lobby-preview-fallback');

    if (!state.lobbyCamOn) {
      if (state.lobbyStream) {
        state.lobbyStream.getVideoTracks().forEach(function (t) {
          t.stop();
          state.lobbyStream.removeTrack(t);
        });
      }
      if (videoEl) videoEl.style.display = 'none';
      if (fallbackEl) fallbackEl.style.display = 'flex';
      updateLobbyButtonsUI();
    } else {
      await initLobbyMedia();
    }
  }

  async function switchLobbyDevice() {
    await initLobbyMedia();
  }

  /* ==================== JOIN LIVEKIT WEBRTC ROOM ==================== */
  async function joinRoom() {
    var joinBtn = $('btn-join-room');
    var joinLbl = $('btn-join-label');
    var nameInput = $('input-participant-name');
    if (nameInput && nameInput.value.trim()) {
      state.name = nameInput.value.trim();
    }

    if (joinBtn) joinBtn.disabled = true;
    if (joinLbl) joinLbl.textContent = 'Emitindo credencial criptografada e conectando...';

    var wantMic = state.lobbyMicOn;
    var wantCam = state.lobbyCamOn;
    stopLobbyStream();

    try {
      var res = await fetch(CFG.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participant_name: state.name,
          role: state.role,
          host_key: CFG.hostKey || ''
        })
      });
      var data = await res.json();
      if (!res.ok || !data.token) {
        throw new Error((data && data.error) || 'Não foi possível gerar o token de acesso.');
      }

      state.identity = data.identity;
      state.role = data.role === 'host' ? 'host' : 'guest';
      selectRole(state.role);
      if (data.requested_role === 'host' && !data.host_authorized) {
        showToast('Acesso de anfitrião não autorizado. Entrada protegida como participante.');
      }

      if (!LK || !LK.Room) {
        throw new Error('SDK WebRTC LiveKit não carregado.');
      }

      var room = new LK.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: LK.VideoPresets ? LK.VideoPresets.h720.resolution : undefined
        }
      });
      state.room = room;

      bindRoomEvents(room);

      await room.connect(data.ws_url || CFG.wsUrl, data.token, {
        autoSubscribe: true
      });

      // Switch UI to Stage 2 (Active Conference)
      $('stage-lobby').style.display = 'none';
      $('stage-ended').classList.remove('is-active');
      $('stage-conference').classList.add('is-active');
      if (window.innerWidth <= 1024) {
        closeDrawer();
      } else {
        openDrawer(state.activeTab);
      }

      var tel = $('telemetry-status');
      if (tel) tel.textContent = 'SFU Conectado';

      startMeetingTimer();

      // Enable microphone / camera gracefully if available
      state.roomMicOn = false;
      state.roomCamOn = false;
      if (wantMic) {
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          state.roomMicOn = true;
        } catch (micErr) {
          state.roomMicOn = false;
        }
      }
      if (wantCam) {
        try {
          await room.localParticipant.setCameraEnabled(true);
          state.roomCamOn = true;
        } catch (camErr) {
          state.roomCamOn = false;
        }
      }

      updateDockUI();
      renderStage();
      renderParticipantsList();
      showToast('Conectado à Sala Executiva Meu Super Chat!');
    } catch (err) {
      if (joinBtn) joinBtn.disabled = false;
      if (joinLbl) joinLbl.textContent = 'Entrar na Sala Executiva Agora';
      showToast('Aviso: ' + (err && err.message ? err.message : 'Falha na conexão WebRTC'));
      await initLobbyMedia();
    }
  }

  function bindRoomEvents(room) {
    var E = LK.RoomEvent;
    room
      .on(E.ParticipantConnected, function (p) {
        showToast((p.name || p.identity) + ' entrou na sala');
        renderStage();
        renderParticipantsList();
      })
      .on(E.ParticipantDisconnected, function (p) {
        delete state.raisedHands[p.identity];
        renderStage();
        renderParticipantsList();
      })
      .on(E.TrackSubscribed, function (track) {
        if (track.kind === LK.Track.Kind.Audio) {
          var audioEl = track.attach();
          audioEl.style.display = 'none';
          document.body.appendChild(audioEl);
        }
        renderStage();
        renderParticipantsList();
      })
      .on(E.TrackUnsubscribed, function (track) {
        track.detach().forEach(function (el) { el.remove(); });
        renderStage();
        renderParticipantsList();
      })
      .on(E.LocalTrackPublished, function () {
        renderStage();
        renderParticipantsList();
      })
      .on(E.LocalTrackUnpublished, function () {
        renderStage();
        renderParticipantsList();
      })
      .on(E.TrackMuted, function () {
        renderStage();
        renderParticipantsList();
      })
      .on(E.TrackUnmuted, function () {
        renderStage();
        renderParticipantsList();
      })
      .on(E.ActiveSpeakersChanged, function (speakers) {
        var activeIds = {};
        (speakers || []).forEach(function (s) { activeIds[s.identity] = true; });
        document.querySelectorAll('.msc-tile').forEach(function (tile) {
          var id = tile.getAttribute('data-identity');
          tile.classList.toggle('is-speaking', !!activeIds[id]);
        });
      })
      .on(E.ConnectionQualityChanged, function (quality, participant) {
        if (state.room && participant.identity === state.room.localParticipant.identity) {
          var tel = $('telemetry-status');
          if (tel) {
            tel.textContent = quality === 'poor' ? 'Sinal Oscilando' : 'SFU Estável HD';
          }
        }
      })
      .on(E.Reconnecting, function () {
        state.reconnecting = true;
        setConnectionStatus('reconnecting', 'Reconectando à sala…');
        var tel = $('telemetry-status');
        if (tel) tel.textContent = 'Reconectando';
      })
      .on(E.Reconnected, function () {
        state.reconnecting = false;
        setConnectionStatus('reconnected', 'Conexão restabelecida');
        var tel = $('telemetry-status');
        if (tel) tel.textContent = 'SFU Reconectado';
        resyncPersistedState();
        setTimeout(function () { setConnectionStatus('hidden'); }, 2600);
      })
      .on(E.DataReceived, function (payload, participant) {
        try {
          var text = new TextDecoder().decode(payload);
          var pkt = JSON.parse(text);
          handleDataPacket(pkt, participant);
        } catch (e) {}
      })
      .on(E.Disconnected, function () {
        handleRoomDisconnected();
      });
  }

  function setConnectionStatus(mode, message) {
    var banner = $('connection-status');
    var text = $('connection-status-text');
    if (!banner) return;
    if (mode === 'hidden') {
      banner.hidden = true;
      banner.classList.remove('is-reconnected');
      return;
    }
    banner.hidden = false;
    banner.classList.toggle('is-reconnected', mode === 'reconnected');
    if (text) text.textContent = message;
  }

  async function resyncPersistedState() {
    if (!CFG.stateEndpoint) return;
    try {
      var res = await fetch(CFG.stateEndpoint, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('state sync failed');
      var persisted = await res.json();
      if (typeof persisted.shared_notes === 'string') {
        state.sharedNotes = persisted.shared_notes;
        var ta = $('shared-notes-textarea');
        if (ta && document.activeElement !== ta) ta.value = state.sharedNotes;
      }
      if (Array.isArray(persisted.agenda_items)) {
        state.agendaItems = persisted.agenda_items;
        renderAgendaChecklist();
      }
      if (Array.isArray(persisted.chat_messages)) {
        state.chatMessages = persisted.chat_messages;
        renderChatMessages();
      }
      var st = $('notes-save-status');
      if (st) st.textContent = 'Ressincronizado após reconexão';
      showToast('Conexão restabelecida e estado da sala sincronizado.');
    } catch (e) {
      showToast('Conexão restabelecida; o estado local foi preservado.');
    }
  }

  function handleDataPacket(pkt, participant) {
    if (!pkt || !pkt.type) return;
    if (pkt.type === 'chat' && pkt.message) {
      appendChatMessageLocal(pkt.message, false);
    } else if (pkt.type === 'reaction' && pkt.emoji) {
      spawnFloatingReaction(pkt.emoji, pkt.sender_name || (participant && participant.name) || 'Participante');
    } else if (pkt.type === 'hand') {
      var id = pkt.identity || (participant && participant.identity);
      if (id) {
        state.raisedHands[id] = !!pkt.raised;
        renderStage();
        renderParticipantsList();
        if (pkt.raised) {
          showToast('✋ ' + (pkt.sender_name || 'Participante') + ' levantou a mão');
        }
      }
    } else if (pkt.type === 'notes_sync') {
      if (typeof pkt.shared_notes === 'string') {
        state.sharedNotes = pkt.shared_notes;
        var ta = $('shared-notes-textarea');
        if (ta && document.activeElement !== ta) ta.value = pkt.shared_notes;
      }
      if (Array.isArray(pkt.agenda_items)) {
        state.agendaItems = pkt.agenda_items;
        renderAgendaChecklist();
      }
      var st = $('notes-save-status');
      if (st) st.textContent = 'Atualizado em tempo real por ' + (pkt.updated_by || 'participante');
    }
  }

  function publishDataPacket(obj) {
    if (!state.room || !state.room.localParticipant) return;
    try {
      var bytes = new TextEncoder().encode(JSON.stringify(obj));
      state.room.localParticipant.publishData(bytes, { reliable: true });
    } catch (e) {}
  }

  /* ==================== RENDER STAGE TILES ==================== */
  function getAllParticipants() {
    if (!state.room) return [];
    var list = [state.room.localParticipant];
    state.room.remoteParticipants.forEach(function (p) {
      list.push(p);
    });
    return list;
  }

  function parseParticipantRole(p) {
    try {
      var meta = JSON.parse(p.metadata || '{}');
      return meta.role === 'host' ? 'host' : 'guest';
    } catch (e) {
      return 'guest';
    }
  }

  function renderStage() {
    var grid = $('video-grid');
    if (!grid || !state.room) return;

    var participants = getAllParticipants();
    grid.innerHTML = '';

    var tilesCount = 0;

    // 1) Screen Share Tiles First (Spotlight Priority)
    participants.forEach(function (p) {
      var screenPub = p.getTrackPublication(LK.Track.Source.ScreenShare);
      if (screenPub && screenPub.track && !screenPub.isMuted) {
        tilesCount++;
        var screenTile = document.createElement('div');
        screenTile.className = 'msc-tile';
        screenTile.setAttribute('data-identity', p.identity + '-screen');
        var v = screenPub.track.attach();
        v.style.objectFit = 'contain';
        screenTile.appendChild(v);

        var overlay = document.createElement('div');
        overlay.className = 'msc-tile-overlay-bottom';
        overlay.innerHTML =
          '<div class="msc-tile-name-badge">' +
          '<span class="msc-role-tag is-host">TELA</span>' +
          '<span>Apresentação de ' + escapeHtml(p.name || p.identity) + '</span>' +
          '</div>';
        screenTile.appendChild(overlay);
        grid.appendChild(screenTile);
      }
    });

    // 2) Participant Camera / Avatar Tiles
    participants.forEach(function (p) {
      tilesCount++;
      var isLocal = p.identity === state.room.localParticipant.identity;
      var role = parseParticipantRole(p);
      var camPub = p.getTrackPublication(LK.Track.Source.Camera);
      var micPub = p.getTrackPublication(LK.Track.Source.Microphone);
      var hasCam = !!(camPub && camPub.track && !camPub.isMuted);
      var hasMic = !!(micPub && micPub.track && !micPub.isMuted);
      var handUp = isLocal ? state.handRaised : !!state.raisedHands[p.identity];

      var tile = document.createElement('div');
      tile.className = 'msc-tile' + (handUp ? ' hand-raised' : '');
      tile.setAttribute('data-identity', p.identity);

      if (hasCam) {
        var videoEl = camPub.track.attach();
        if (isLocal) {
          videoEl.muted = true;
          videoEl.classList.add('is-mirrored');
        }
        tile.appendChild(videoEl);
      } else {
        var wrap = document.createElement('div');
        wrap.className = 'msc-tile-avatar-wrap';
        wrap.innerHTML =
          '<div class="msc-tile-avatar">' + escapeHtml(computeInitials(p.name || p.identity)) + '</div>' +
          '<div style="font-size: 13px; color: var(--text-muted); font-weight: 500;">' +
          (hasMic ? 'Áudio Conectado' : 'Microfone Mutado') +
          '</div>';
        tile.appendChild(wrap);
      }

      var handBadge = document.createElement('div');
      handBadge.className = 'msc-tile-hand-badge';
      handBadge.innerHTML = '✋ Mão levantada';
      tile.appendChild(handBadge);

      var bottom = document.createElement('div');
      bottom.className = 'msc-tile-overlay-bottom';
      bottom.innerHTML =
        '<div class="msc-tile-name-badge">' +
        '<span class="msc-role-tag ' + (role === 'host' ? 'is-host' : '') + '">' + (role === 'host' ? 'Host' : 'Convidado') + '</span>' +
        '<span>' + escapeHtml((p.name || p.identity) + (isLocal ? ' (Você)' : '')) + '</span>' +
        '</div>' +
        '<div class="msc-tile-name-badge" style="padding: 5px 9px;">' +
        (hasMic ? '🎙️' : '🔇') +
        '</div>';
      tile.appendChild(bottom);

      grid.appendChild(tile);
    });

    grid.setAttribute('data-count', String(tilesCount));
    grid.classList.toggle('layout-spotlight', state.layout === 'spotlight' || tilesCount > 1 && state.screenShareOn);

    var count = participants.length;
    var counterEl = $('live-participants-counter');
    if (counterEl) {
      counterEl.textContent = count === 1 ? '1 participante online (aguardando convidados)' : count + ' participantes online';
    }
    var dockP = $('dock-label-participants');
    if (dockP) dockP.textContent = String(count);
    var tabP = $('tab-participants-count');
    if (tabP) tabP.textContent = String(count);
  }

  function renderParticipantsList() {
    var container = $('participants-list');
    if (!container || !state.room) return;
    var participants = getAllParticipants();
    container.innerHTML = '';

    participants.forEach(function (p) {
      var isLocal = p.identity === state.room.localParticipant.identity;
      var role = parseParticipantRole(p);
      var camPub = p.getTrackPublication(LK.Track.Source.Camera);
      var micPub = p.getTrackPublication(LK.Track.Source.Microphone);
      var hasCam = !!(camPub && camPub.track && !camPub.isMuted);
      var hasMic = !!(micPub && micPub.track && !micPub.isMuted);
      var handUp = isLocal ? state.handRaised : !!state.raisedHands[p.identity];

      var row = document.createElement('div');
      row.className = 'msc-participant-row';
      row.innerHTML =
        '<div class="msc-participant-info">' +
        '<span class="msc-participant-name">' + escapeHtml((p.name || p.identity) + (isLocal ? ' (Você)' : '')) + '</span>' +
        '<span class="msc-participant-sub">' + (role === 'host' ? '⚡ Especialista / Anfitrião' : '👤 Participante') + '</span>' +
        '</div>' +
        '<div class="msc-participant-icons">' +
        (handUp ? '<span>✋</span>' : '') +
        '<span>' + (hasMic ? '🎙️' : '🔇') + '</span>' +
        '<span>' + (hasCam ? '📹' : '📷') + '</span>' +
        '</div>';
      container.appendChild(row);
    });
  }

  /* ==================== ROOM CONTROLS ==================== */
  async function toggleRoomMic() {
    if (!state.room) return;
    try {
      var next = !state.roomMicOn;
      await state.room.localParticipant.setMicrophoneEnabled(next);
      state.roomMicOn = next;
      updateDockUI();
      renderStage();
      renderParticipantsList();
    } catch (e) {
      showToast('Não foi possível acessar o microfone neste dispositivo.');
    }
  }

  async function toggleRoomCam() {
    if (!state.room) return;
    try {
      var next = !state.roomCamOn;
      await state.room.localParticipant.setCameraEnabled(next);
      state.roomCamOn = next;
      updateDockUI();
      renderStage();
      renderParticipantsList();
    } catch (e) {
      showToast('Câmera não encontrada ou permissão negada neste navegador.');
    }
  }

  async function toggleScreenShare() {
    if (!state.room) return;
    try {
      var next = !state.screenShareOn;
      await state.room.localParticipant.setScreenShareEnabled(next);
      state.screenShareOn = next;
      if (next) setLayout('spotlight');
      updateDockUI();
      renderStage();
    } catch (e) {
      state.screenShareOn = false;
      updateDockUI();
    }
  }

  function toggleRaiseHand() {
    state.handRaised = !state.handRaised;
    publishDataPacket({
      type: 'hand',
      raised: state.handRaised,
      identity: state.identity,
      sender_name: state.name
    });
    updateDockUI();
    renderStage();
    renderParticipantsList();
  }

  function toggleReactionsMenu() {
    var pop = $('reactions-popover');
    if (pop) pop.classList.toggle('is-open');
  }

  function sendReaction(emoji) {
    var pop = $('reactions-popover');
    if (pop) pop.classList.remove('is-open');
    spawnFloatingReaction(emoji, state.name + ' (Você)');
    publishDataPacket({
      type: 'reaction',
      emoji: emoji,
      sender_name: state.name
    });
  }

  function spawnFloatingReaction(emoji, who) {
    var layer = $('reactions-layer');
    if (!layer) return;
    var el = document.createElement('div');
    el.className = 'msc-floating-reaction';
    el.style.left = Math.round(18 + Math.random() * 64) + '%';
    el.innerHTML =
      '<span class="emoji">' + escapeHtml(emoji) + '</span>' +
      '<span class="who">' + escapeHtml(who) + '</span>';
    layer.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3200);
  }

  function setLayout(mode) {
    state.layout = mode === 'spotlight' ? 'spotlight' : 'grid';
    var g = $('btn-layout-grid');
    var s = $('btn-layout-spotlight');
    if (g) g.classList.toggle('is-active', state.layout === 'grid');
    if (s) s.classList.toggle('is-active', state.layout === 'spotlight');
    renderStage();
  }

  function updateDockUI() {
    var micBtn = $('dock-btn-mic');
    var camBtn = $('dock-btn-cam');
    var scrBtn = $('dock-btn-screen');
    var hndBtn = $('dock-btn-hand');
    var micLbl = $('dock-label-mic');
    var camLbl = $('dock-label-cam');

    if (micBtn) micBtn.classList.toggle('is-muted', !state.roomMicOn);
    if (camBtn) camBtn.classList.toggle('is-muted', !state.roomCamOn);
    if (scrBtn) scrBtn.classList.toggle('is-active', state.screenShareOn);
    if (hndBtn) hndBtn.classList.toggle('is-active', state.handRaised);
    if (micLbl) micLbl.textContent = state.roomMicOn ? 'Áudio' : 'Mutado';
    if (camLbl) camLbl.textContent = state.roomCamOn ? 'Vídeo' : 'Sem Vídeo';
  }

  /* ==================== DRAWER: CHAT, NOTES & PARTICIPANTS ==================== */
  function openDrawer(tab) {
    state.drawerOpen = true;
    var dr = $('room-drawer');
    if (dr) dr.classList.add('is-open');
    if (tab) switchTab(tab);
  }

  function closeDrawer() {
    state.drawerOpen = false;
    var dr = $('room-drawer');
    if (dr) dr.classList.remove('is-open');
  }

  function switchTab(tab) {
    state.activeTab = tab;
    ['chat', 'notes', 'participants'].forEach(function (t) {
      var btn = $('tab-btn-' + t);
      var pnl = $('tab-panel-' + t);
      if (btn) btn.classList.toggle('is-active', t === tab);
      if (pnl) pnl.classList.toggle('is-active', t === tab);
    });
    if (tab === 'chat') {
      var dot = $('chat-unread-dot');
      if (dot) dot.classList.remove('is-visible');
    }
  }

  function renderChatMessages() {
    var list = $('chat-messages-list');
    if (!list) return;
    if (!state.chatMessages.length) {
      list.innerHTML =
        '<div class="msc-chat-empty">Nenhuma mensagem ainda.<br/>Use o chat para enviar links, códigos e observações durante a chamada.</div>';
      return;
    }
    list.innerHTML = '';
    state.chatMessages.forEach(function (m) {
      var isSelf = m.sender_identity && state.identity && m.sender_identity === state.identity;
      var timeStr = '';
      try {
        var d = new Date(m.timestamp);
        timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      } catch (e) {}
      var b = document.createElement('div');
      b.className = 'msc-chat-bubble' + (isSelf ? ' is-self' : '');
      b.innerHTML =
        '<div class="msc-chat-meta">' +
        '<span class="msc-chat-sender">' + escapeHtml(m.sender_name || 'Participante') + '</span>' +
        '<span>' + escapeHtml(timeStr) + '</span>' +
        '</div>' +
        '<div>' + escapeHtml(m.text || '') + '</div>';
      list.appendChild(b);
    });
    list.scrollTop = list.scrollHeight;
  }

  function appendChatMessageLocal(msg, isSelf) {
    var exists = state.chatMessages.some(function (m) { return m.id === msg.id; });
    if (!exists) {
      state.chatMessages.push(msg);
      renderChatMessages();
      if (!isSelf && (!state.drawerOpen || state.activeTab !== 'chat')) {
        var dot = $('chat-unread-dot');
        if (dot) dot.classList.add('is-visible');
      }
    }
  }

  async function submitChatMessage(ev) {
    if (ev) ev.preventDefault();
    var input = $('chat-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';

    var msg = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      sender_name: state.name,
      sender_role: state.role,
      sender_identity: state.identity || 'local',
      text: text,
      timestamp: new Date().toISOString()
    };

    appendChatMessageLocal(msg, true);
    publishDataPacket({ type: 'chat', message: msg });

    try {
      await fetch(CFG.chatEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_message: msg })
      });
    } catch (e) {}
  }

  function renderAgendaChecklist() {
    var wrap = $('agenda-checklist');
    if (!wrap) return;
    wrap.innerHTML = '';
    state.agendaItems.forEach(function (item, idx) {
      var lbl = document.createElement('label');
      lbl.className = 'msc-agenda-item' + (item.done ? ' is-done' : '');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!item.done;
      cb.addEventListener('change', function () {
        state.agendaItems[idx].done = cb.checked;
        renderAgendaChecklist();
        saveNotesAndAgenda(false);
      });
      var sp = document.createElement('span');
      sp.textContent = item.text;
      lbl.appendChild(cb);
      lbl.appendChild(sp);
      wrap.appendChild(lbl);
    });
  }

  async function saveNotesAndAgenda(manual) {
    var ta = $('shared-notes-textarea');
    if (ta) state.sharedNotes = ta.value;
    var st = $('notes-save-status');
    if (st) st.textContent = 'Salvando...';

    publishDataPacket({
      type: 'notes_sync',
      shared_notes: state.sharedNotes,
      agenda_items: state.agendaItems,
      updated_by: state.name
    });

    try {
      var res = await fetch(CFG.notesEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shared_notes: state.sharedNotes,
          agenda_items: state.agendaItems,
          updated_by: state.name
        })
      });
      if (res.ok) {
        if (st) st.textContent = 'Salvo às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        if (manual) showToast('Ata e checklist salvos na sala!');
      }
    } catch (e) {
      if (st) st.textContent = 'Sincronizado localmente';
    }
  }

  /* ==================== TIMER & LEAVE ==================== */
  function startMeetingTimer() {
    state.startedAt = Date.now();
    clearInterval(state.timerInterval);
    var el = $('meeting-timer');
    state.timerInterval = setInterval(function () {
      var sec = Math.floor((Date.now() - state.startedAt) / 1000);
      var m = String(Math.floor(sec / 60)).padStart(2, '0');
      var s = String(sec % 60).padStart(2, '0');
      if (el) el.textContent = m + ':' + s;
    }, 1000);
  }

  async function leaveRoom() {
    if (state.room) {
      try {
        await state.room.disconnect();
      } catch (e) {}
      state.room = null;
    }
    handleRoomDisconnected();
  }

  function handleRoomDisconnected() {
    clearInterval(state.timerInterval);
    $('stage-conference').classList.remove('is-active');
    $('stage-lobby').style.display = 'none';
    $('stage-ended').classList.add('is-active');
    var tel = $('telemetry-status');
    if (tel) tel.textContent = 'Sessão Finalizada';
  }

  async function rejoinFromEnded() {
    $('stage-ended').classList.remove('is-active');
    $('stage-lobby').style.display = 'grid';
    var joinBtn = $('btn-join-room');
    var joinLbl = $('btn-join-label');
    if (joinBtn) joinBtn.disabled = false;
    if (joinLbl) joinLbl.textContent = 'Entrar na Sala Executiva Agora';
    await initLobbyMedia();
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ==================== BOOTSTRAP ==================== */
  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(preferredTheme());
    renderChatMessages();
    renderAgendaChecklist();

    var ta = $('shared-notes-textarea');
    if (ta) {
      ta.addEventListener('input', function () {
        clearTimeout(state.notesDebounce);
        state.notesDebounce = setTimeout(function () {
          saveNotesAndAgenda(false);
        }, 900);
      });
    }

    initLobbyMedia();
  });

  window.MSCMeet = {
    copyInviteLink: copyInviteLink,
    updateAvatarInitials: updateAvatarInitials,
    selectRole: selectRole,
    toggleLobbyMic: toggleLobbyMic,
    toggleLobbyCam: toggleLobbyCam,
    switchLobbyDevice: switchLobbyDevice,
    joinRoom: joinRoom,
    toggleRoomMic: toggleRoomMic,
    toggleRoomCam: toggleRoomCam,
    toggleScreenShare: toggleScreenShare,
    toggleRaiseHand: toggleRaiseHand,
    toggleReactionsMenu: toggleReactionsMenu,
    sendReaction: sendReaction,
    setLayout: setLayout,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    switchTab: switchTab,
    submitChatMessage: submitChatMessage,
    saveNotesAndAgenda: saveNotesAndAgenda,
    leaveRoom: leaveRoom,
    rejoinFromEnded: rejoinFromEnded,
    toggleTheme: toggleTheme
  };
})();
