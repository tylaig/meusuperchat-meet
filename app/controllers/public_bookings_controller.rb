# frozen_string_literal: true

require 'jwt'
require 'securerandom'
require 'openssl'

class PublicBookingsController < ActionController::Base
  skip_before_action :verify_authenticity_token, raise: false

  LIVEKIT_WS_URL_DEFAULT = 'wss://livekit.62.171.166.157.sslip.io'
  LIVEKIT_API_KEY_DEFAULT = 'APIPiGFpvpQVvFg'
  LIVEKIT_API_SECRET_DEFAULT = 'oosMCJfnEfi8ecLxiih5xzatxgcyaWRcfgr1bubsrfVB'
  MEETING_STATE_TTL_SECONDS = 14 * 24 * 3600

  # GET /agendar/:slug
  def show
    @slug = params[:slug].to_s.parameterize
    @global_config = GlobalConfig.get('BRAND_NAME', 'INSTALLATION_NAME', 'LOGO_THUMBNAIL', 'BRAND_COLOR')
    render template: 'public_bookings/show', layout: false
  end

  # GET /agendar/sala/:uid or /reuniao/:uid
  def show_meeting
    @raw_uid = params[:uid].to_s.strip
    @appointment = find_meeting_appointment(@raw_uid)
    @room_uid = canonical_room_uid(@raw_uid, @appointment)
    @livekit_ws_url = livekit_ws_url
    @meeting_state = load_meeting_state(@room_uid, @appointment)
    @global_config = GlobalConfig.get('BRAND_NAME', 'INSTALLATION_NAME', 'LOGO_THUMBNAIL', 'LOGO_DARK', 'LOGO', 'BRAND_COLOR')
    render template: 'public_bookings/show_meeting', layout: false
  end

  # POST /public/api/v1/meetings/:uid/token
  def meeting_token
    raw_uid = params[:uid].to_s.strip
    raise ArgumentError, 'Identificador da sala inválido.' if raw_uid.blank?

    appointment = find_meeting_appointment(raw_uid)
    room_uid = canonical_room_uid(raw_uid, appointment)

    requested_role = params[:role].to_s.strip.downcase == 'host' ? 'host' : 'guest'
    role = requested_role == 'host' && meeting_host_authorized?(room_uid, appointment) ? 'host' : 'guest'
    default_name = if role == 'host'
                     appointment&.calendar_schedule&.name.presence || 'Especialista Meu Super Chat'
                   else
                     appointment&.customer_name.presence || 'Participante Executivo'
                   end

    participant_name = params[:participant_name].to_s.strip.presence ||
                       params[:name].to_s.strip.presence ||
                       default_name
    participant_name = participant_name[0, 80]

    provided_identity = params[:identity].to_s.strip.gsub(/[^a-zA-Z0-9_-]/, '')[0, 64]
    name_slug = participant_name.parameterize.presence || 'participante'
    identity = provided_identity.presence || "#{role}-#{name_slug[0, 24]}-#{SecureRandom.alphanumeric(6).downcase}"

    role_label = role == 'host' ? 'Especialista / Anfitrião' : 'Participante'
    now = Time.now.to_i
    exp = now + (6 * 3600)

    participant_metadata = {
      role: role,
      role_label: role_label,
      room: room_uid,
      joined_at: Time.current.iso8601
    }.to_json

    payload = {
      iss: livekit_api_key,
      sub: identity,
      nbf: now - 10,
      iat: now,
      exp: exp,
      jti: SecureRandom.uuid,
      name: participant_name,
      metadata: participant_metadata,
      video: {
        roomJoin: true,
        room: room_uid,
        roomCreate: true,
        roomAdmin: (role == 'host'),
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canUpdateOwnMetadata: true
      }
    }

    jwt_token = JWT.encode(payload, livekit_api_secret, 'HS256')

    render json: {
      token: jwt_token,
      ws_url: livekit_ws_url,
      url: livekit_ws_url,
      room: room_uid,
      uid: room_uid,
      identity: identity,
      participant_name: participant_name,
      role: role,
      requested_role: requested_role,
      host_authorized: role == 'host',
      role_label: role_label,
      encryption: 'TLS1.3-SRTP-E2EE',
      expires_at: Time.at(exp).utc.iso8601
    }, status: :ok
  rescue ArgumentError => e
    render json: { error: e.message }, status: :unprocessable_entity
  rescue StandardError => e
    render json: { error: "Falha ao emitir credencial da sala: #{e.message}" }, status: :internal_server_error
  end

  # GET /public/api/v1/meetings/:uid/state
  def meeting_state
    raw_uid = params[:uid].to_s.strip
    appointment = find_meeting_appointment(raw_uid)
    room_uid = canonical_room_uid(raw_uid, appointment)
    state = load_meeting_state(room_uid, appointment)

    render json: {
      room: room_uid,
      uid: room_uid,
      ws_url: livekit_ws_url,
      appointment: appointment ? meeting_appointment_summary(appointment) : default_meeting_summary(room_uid),
      shared_notes: state['shared_notes'],
      agenda_items: state['agenda_items'],
      chat_messages: state['chat_messages'],
      updated_at: state['updated_at']
    }, status: :ok
  end

  # POST /public/api/v1/meetings/:uid/notes
  def meeting_notes
    raw_uid = params[:uid].to_s.strip
    appointment = find_meeting_appointment(raw_uid)
    room_uid = canonical_room_uid(raw_uid, appointment)
    state = load_meeting_state(room_uid, appointment)

    if params.key?(:shared_notes) || params.key?(:notes)
      raw_notes = params.key?(:shared_notes) ? params[:shared_notes] : params[:notes]
      state['shared_notes'] = raw_notes.to_s[0, 20_000]
    end

    if params[:agenda_items].is_a?(Array)
      state['agenda_items'] = params[:agenda_items].first(40).map.with_index do |item, idx|
        h = item.respond_to?(:to_unsafe_h) ? item.to_unsafe_h : item.to_h
        {
          'id' => (h['id'] || h[:id] || "ag-#{idx + 1}").to_s[0, 40],
          'text' => (h['text'] || h[:text]).to_s.strip[0, 300],
          'done' => ActiveModel::Type::Boolean.new.cast(h.key?('done') ? h['done'] : h[:done])
        }
      end.reject { |i| i['text'].blank? }
    end

    if params[:chat_message].present?
      append_chat_message!(state, params[:chat_message])
    end

    state['updated_at'] = Time.current.iso8601
    state['updated_by'] = params[:updated_by].to_s.strip[0, 80] if params[:updated_by].present?

    persist_meeting_state!(room_uid, appointment, state)

    render json: {
      ok: true,
      room: room_uid,
      shared_notes: state['shared_notes'],
      agenda_items: state['agenda_items'],
      chat_messages: state['chat_messages'],
      updated_at: state['updated_at']
    }, status: :ok
  rescue StandardError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # POST /public/api/v1/meetings/:uid/chat
  def meeting_chat
    raw_uid = params[:uid].to_s.strip
    appointment = find_meeting_appointment(raw_uid)
    room_uid = canonical_room_uid(raw_uid, appointment)
    state = load_meeting_state(room_uid, appointment)

    msg_payload = params[:chat_message].presence || {
      sender_name: params[:sender_name],
      sender_role: params[:sender_role],
      sender_identity: params[:sender_identity],
      text: params[:text]
    }
    append_chat_message!(state, msg_payload)
    state['updated_at'] = Time.current.iso8601

    persist_meeting_state!(room_uid, appointment, state)

    render json: {
      ok: true,
      room: room_uid,
      chat_messages: state['chat_messages'],
      updated_at: state['updated_at']
    }, status: :ok
  rescue StandardError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  # GET /public/api/v1/bookings/:slug
  def profile
    target = resolve_booking_target!(params[:slug])

    if target[:mode] == :professional
      schedule = target[:schedule]
      account = schedule.account
      types = schedule.appointment_types.active.order(:id)
      types = account.appointment_types.active.where(calendar_schedule_id: nil).order(:id) if types.empty?

      render json: {
        mode: 'professional',
        account_name: account.name,
        team_slug: schedule.team_booking_slug,
        schedule: public_schedule_json(schedule),
        schedules: [public_schedule_json(schedule)],
        appointment_types: types.map(&:as_api_json)
      }
    else
      account = target[:account]
      schedules = target[:schedules]
      types = account.appointment_types.active.order(:id)

      render json: {
        mode: 'team',
        account_name: account.name,
        team_slug: params[:slug],
        schedule: nil,
        schedules: schedules.map { |s| public_schedule_json(s) },
        appointment_types: types.map(&:as_api_json)
      }
    end
  rescue ActiveRecord::RecordNotFound => e
    render json: { error: e.message }, status: :not_found
  end

  # GET /public/api/v1/bookings/:slug/slots?date=YYYY-MM-DD&days=7&schedule_id=...&appointment_type_id=...
  def slots
    target = resolve_booking_target!(params[:slug])
    account = target[:account]
    schedules = if params[:schedule_id].present?
                  account.calendar_schedules.active.where(id: params[:schedule_id])
                elsif target[:mode] == :professional
                  [target[:schedule]]
                else
                  target[:schedules]
                end

    appointment_type = params[:appointment_type_id].present? ? account.appointment_types.active.find_by(id: params[:appointment_type_id]) : nil

    availability = Calendar::AvailabilityService.new(
      account: account,
      schedules: schedules,
      appointment_type: appointment_type
    ).available_slots(
      date_str: params[:date],
      days: (params[:days] || 7).to_i
    )

    render json: { availability: availability }
  rescue ActiveRecord::RecordNotFound => e
    render json: { error: e.message }, status: :not_found
  end

  # POST /public/api/v1/bookings/:slug/book
  def book
    target = resolve_booking_target!(params[:slug])
    account = target[:account]
    schedule_id = params[:calendar_schedule_id].presence || target[:schedule]&.id

    guest_emails = Array(params[:guest_emails]).map { |e| e.to_s.strip }.reject(&:blank?)

    appointment = Calendar::BookingService.new(account: account).create!(
      calendar_schedule_id: schedule_id,
      appointment_type_id: params[:appointment_type_id],
      starts_at: params[:starts_at],
      customer_name: params[:customer_name],
      customer_email: params[:customer_email],
      customer_phone: params[:customer_phone],
      notes: params[:notes],
      source: 'public_link',
      metadata: {
        booked_via_slug: params[:slug],
        guest_emails: guest_emails.presence
      }.compact
    )

    render json: {
      message: 'Agendamento confirmado com sucesso!',
      appointment: appointment.as_api_json
    }, status: :created
  rescue Calendar::BookingService::SlotUnavailableError => e
    render json: { error: e.message }, status: :conflict
  rescue StandardError => e
    render json: { error: e.message }, status: :unprocessable_entity
  end

  private

  def livekit_ws_url
    ENV.fetch('LIVEKIT_WS_URL', LIVEKIT_WS_URL_DEFAULT)
  end

  def livekit_api_key
    ENV.fetch('LIVEKIT_API_KEY', LIVEKIT_API_KEY_DEFAULT)
  end

  def livekit_api_secret
    ENV.fetch('LIVEKIT_API_SECRET', LIVEKIT_API_SECRET_DEFAULT)
  end

  def meeting_host_authorized?(room_uid, appointment)
    return true if authenticated_meeting_host?

    provided_key = params[:host_key].to_s.strip
    return false if provided_key.blank?

    expected_keys = []
    metadata = appointment&.metadata.is_a?(Hash) ? appointment.metadata : {}
    expected_keys << metadata['meet_host_key'].to_s if metadata['meet_host_key'].present?

    signing_secret = ENV['MEET_HOST_AUTH_SECRET'].to_s
    expected_keys << OpenSSL::HMAC.hexdigest('SHA256', signing_secret, room_uid) if signing_secret.present?

    expected_keys.any? { |expected| secure_key_match?(provided_key, expected) }
  end

  def authenticated_meeting_host?
    respond_to?(:current_user, true) && current_user.present?
  rescue StandardError
    false
  end

  def secure_key_match?(provided, expected)
    return false if provided.blank? || expected.blank? || provided.bytesize != expected.bytesize

    ActiveSupport::SecurityUtils.secure_compare(provided, expected)
  end

  def find_meeting_appointment(raw_uid)
    clean = raw_uid.to_s.strip
    return nil if clean.blank?

    appt = CalendarAppointment.includes(:calendar_schedule, :appointment_type, :account).find_by(uid: clean)
    return appt if appt

    sanitized = ActiveRecord::Base.sanitize_sql_like(clean)
    CalendarAppointment
      .includes(:calendar_schedule, :appointment_type, :account)
      .where('meeting_url LIKE ? OR meeting_url LIKE ? OR meeting_url LIKE ?', "%/#{sanitized}", "%/reuniao/#{sanitized}", "%/agendar/sala/#{sanitized}")
      .order(id: :desc)
      .first
  end

  def canonical_room_uid(raw_uid, appointment)
    candidate = appointment&.uid.presence || raw_uid.to_s.strip.presence || 'msc-sala-executiva'
    candidate.gsub(/[^a-zA-Z0-9_-]/, '-')[0, 64]
  end

  def meeting_redis
    @meeting_redis ||= Redis.new(url: ENV.fetch('REDIS_URL', 'redis://meusuperchat_redis:6379'))
  end

  def redis_state_key(room_uid)
    "msc:meet:state:#{room_uid}"
  end

  def default_agenda_for(appointment)
    [
      { 'id' => 'ag-1', 'text' => 'Boas-vindas e alinhamento de contexto executivo', 'done' => false },
      { 'id' => 'ag-2', 'text' => (appointment&.title.presence || 'Apresentação estratégica e diagnóstico'), 'done' => false },
      { 'id' => 'ag-3', 'text' => 'Definição de plano de ação e próximos passos', 'done' => false }
    ]
  end

  def load_meeting_state(room_uid, appointment)
    cached = begin
      raw = meeting_redis.get(redis_state_key(room_uid))
      raw.present? ? JSON.parse(raw) : nil
    rescue StandardError
      nil
    end

    meta = appointment&.metadata.is_a?(Hash) ? appointment.metadata : {}
    default_notes = meta['shared_notes'].presence ||
                    appointment&.notes.presence ||
                    "Pauta Executiva — Meu Super Chat\n• Objetivos da reunião\n• Pontos-chave discutidos\n• Decisões e próximos passos"

    default_agenda = meta['agenda_items'].is_a?(Array) && meta['agenda_items'].any? ? meta['agenda_items'] : default_agenda_for(appointment)
    default_chat = meta['chat_messages'].is_a?(Array) ? meta['chat_messages'] : []

    {
      'shared_notes' => (cached && cached.key?('shared_notes')) ? cached['shared_notes'].to_s : default_notes.to_s,
      'agenda_items' => (cached && cached['agenda_items'].is_a?(Array)) ? cached['agenda_items'] : default_agenda,
      'chat_messages' => (cached && cached['chat_messages'].is_a?(Array)) ? cached['chat_messages'] : default_chat,
      'updated_at' => (cached && cached['updated_at']) || appointment&.updated_at&.iso8601 || Time.current.iso8601
    }
  end

  def persist_meeting_state!(room_uid, appointment, state)
    begin
      meeting_redis.set(redis_state_key(room_uid), state.to_json, ex: MEETING_STATE_TTL_SECONDS)
    rescue StandardError => e
      Rails.logger.warn("[MeuSuperChat Meet] Redis state write warning: #{e.message}")
    end

    return unless appointment

    meta = (appointment.metadata.is_a?(Hash) ? appointment.metadata.deep_dup : {})
    meta['shared_notes'] = state['shared_notes']
    meta['agenda_items'] = state['agenda_items']
    meta['chat_messages'] = Array(state['chat_messages']).last(100)
    meta['notes_updated_at'] = state['updated_at']
    appointment.update_columns(metadata: meta, updated_at: Time.current)
  end

  def append_chat_message!(state, raw_msg)
    h = raw_msg.respond_to?(:to_unsafe_h) ? raw_msg.to_unsafe_h : raw_msg.to_h
    text = (h['text'] || h[:text]).to_s.strip[0, 2000]
    return if text.blank?

    msg = {
      'id' => (h['id'] || h[:id] || "msg-#{SecureRandom.alphanumeric(8).downcase}").to_s[0, 48],
      'sender_name' => ((h['sender_name'] || h[:sender_name]).to_s.strip.presence || 'Participante')[0, 80],
      'sender_role' => ((h['sender_role'] || h[:sender_role]).to_s == 'host' ? 'host' : 'guest'),
      'sender_identity' => (h['sender_identity'] || h[:sender_identity]).to_s[0, 64],
      'text' => text,
      'timestamp' => ((h['timestamp'] || h[:timestamp]).to_s.presence || Time.current.iso8601)
    }

    list = Array(state['chat_messages'])
    unless list.any? { |m| m['id'] == msg['id'] }
      list << msg
    end
    state['chat_messages'] = list.last(200)
  end

  def meeting_appointment_summary(appointment)
    tz = ActiveSupport::TimeZone[appointment.timezone.presence || appointment.calendar_schedule&.timezone || 'America/Sao_Paulo'] || Time.zone
    local_start = appointment.starts_at.in_time_zone(tz)
    local_end = appointment.ends_at.in_time_zone(tz)

    {
      uid: appointment.uid,
      title: appointment.title,
      host_name: appointment.calendar_schedule&.name || 'Especialista Meu Super Chat',
      host_role: appointment.calendar_schedule&.role_title.presence || 'Anfitrião Executivo',
      customer_name: appointment.customer_name,
      date_formatted: local_start.strftime('%d/%m/%Y'),
      time_range: "#{local_start.strftime('%H:%M')} — #{local_end.strftime('%H:%M')}",
      duration_minutes: appointment.duration_minutes,
      timezone: tz.tzinfo.name,
      status: appointment.status,
      notes: appointment.notes
    }
  end

  def default_meeting_summary(room_uid)
    now_sp = Time.current.in_time_zone('America/Sao_Paulo')
    {
      uid: room_uid,
      title: 'Sala Executiva Meu Super Chat',
      host_name: 'Equipe Meu Super Chat',
      host_role: 'Especialista / Anfitrião',
      customer_name: 'Participante Convidado',
      date_formatted: now_sp.strftime('%d/%m/%Y'),
      time_range: "#{now_sp.strftime('%H:%M')} — #{(now_sp + 45.minutes).strftime('%H:%M')}",
      duration_minutes: 45,
      timezone: 'America/Sao_Paulo',
      status: 'confirmed',
      notes: 'Sessão executiva dedicada de áudio, vídeo HD e colaboração em tempo real.'
    }
  end

  def resolve_booking_target!(raw_slug)
    slug = raw_slug.to_s.parameterize
    schedule = CalendarSchedule.active.includes(:account, :appointment_types).find_by(slug: slug)
    return { mode: :professional, schedule: schedule, account: schedule.account } if schedule.present?

    by_team_setting = CalendarSchedule.active.includes(:account).where("settings ->> 'team_slug' = ?", slug)
    if by_team_setting.exists?
      acc = by_team_setting.first.account
      return { mode: :team, account: acc, schedules: acc.calendar_schedules.active.order(:id) }
    end

    matched_account = Account.all.find { |a| a.name.to_s.parameterize == slug || "conta-#{a.id}" == slug }
    if matched_account && matched_account.calendar_schedules.active.exists?
      return { mode: :team, account: matched_account, schedules: matched_account.calendar_schedules.active.order(:id) }
    end

    raise ActiveRecord::RecordNotFound, 'Página de agendamento não encontrada.'
  end

  def public_schedule_json(schedule)
    {
      id: schedule.id,
      name: schedule.name,
      slug: schedule.slug,
      role_title: schedule.role_title,
      bio: schedule.bio,
      avatar_url: schedule.avatar_url.presence || schedule.user&.avatar_url,
      color: schedule.color,
      timezone: schedule.timezone,
      slot_duration_minutes: schedule.slot_duration_minutes,
      google_connected: schedule.google_connected,
      public_booking_url: schedule.public_booking_url,
      appointment_types: schedule.appointment_types.active.order(:id).map(&:as_api_json)
    }
  end
end
