# Meu Super Chat — Meet Engine (LiveKit WebRTC SFU)

Módulo oficial de videoconferência executiva WebRTC em tempo real para o ecossistema **Meu Super Chat**, operando sobre **LiveKit SFU Server v1.13.10** com sinalização criptografada (`TLS 1.3 + SRTP`), Green Room (pré-lobby com teste de câmera, microfone e medidor de áudio em tempo real), compartilhamento de tela HD, reações flutuantes, lista de participantes e central de colaboração persistente (Chat ao vivo + Pauta/Checklist + Ata compartilhada sincronizada via Redis e PostgreSQL).

## Arquitetura

- **Servidor WebRTC SFU:** Container Docker Swarm `livekit/livekit-server` (`v1.13.10`), integrado ao `meusuperchat_redis:6379` e roteado via Traefik (`wss://livekit.62.171.166.157.sslip.io`) com portas de mídia de baixa latência (`7881/tcp` e `50000-50060/udp`).
- **Backend Rails (`PublicBookingsController`):**
  - `GET /reuniao/:uid` e `GET /agendar/sala/:uid` — Renderiza a Sala Executiva Dark Obsidian + Esmeralda (`show_meeting.html.erb`).
  - `POST /public/api/v1/meetings/:uid/token` — Emite credencial JWT (`HS256`) nativa para conexão WebRTC SFU com permissões granulares por perfil (`host` / `guest`).
  - `GET /public/api/v1/meetings/:uid/state` — Recupera estado da sala, metadados do agendamento, checklist de pauta, ata compartilhada e histórico de chat.
  - `POST /public/api/v1/meetings/:uid/notes` — Persiste ata colaborativa e checklist em Redis + `CalendarAppointment#metadata`.
  - `POST /public/api/v1/meetings/:uid/chat` — Persiste mensagens do chat da sala em tempo real.
- **Frontend (`public/meet/`):**
  - `msc-meet-room.css` — Design System Dark Obsidian (`#04090D`, `#081218`, `#0A151D`) + Esmeralda (`#10B981`) + Kinetic Volt (`#C6FF00`), 100% responsivo em Desktop (`1440x900`), Tablet (`768x1024`) e Mobile (`375x812`).
  - `msc-meet-room.js` — Cliente WebRTC SFU com reconexão automática, controle de mídia, compartilhamento de tela, DataChannels para reações/mão levantada/sincronização de ata e chat em tempo real.
