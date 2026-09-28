const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';
const stravaActivityUrl = id => `https://www.strava.com/api/v3/activities/${id}`;
const stravaStreamsUrl = id => `https://www.strava.com/api/v3/activities/${id}/streams?keys=time,distance,moving,watts,cadence,heartrate,altitude,velocity_smooth&key_by_type=true`;

const json = (value, status = 200, origin = '') => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) },
});

const cors = origin => ({
  'access-control-allow-origin': origin,
  'access-control-allow-headers': 'content-type, x-ride-week-key',
  'access-control-allow-methods': 'GET, OPTIONS',
  vary: 'Origin',
});

const configuredOrigin = env => new URL(env.FRONTEND_URL).origin;
const allowedOrigin = (request, env) => request.headers.get('Origin') === configuredOrigin(env) ? configuredOrigin(env) : configuredOrigin(env);

const isAuthorized = (request, env) => request.headers.get('x-ride-week-key') === env.RIDE_WEEK_SYNC_KEY;

async function refreshTokenIfNeeded(env) {
  const saved = await env.TOKENS.get('strava-tokens', 'json');
  if (!saved) return null;
  if (saved.expires_at > Math.floor(Date.now() / 1000) + 300) return saved;

  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: saved.refresh_token,
    }),
  });
  if (!response.ok) throw new Error('Strava 토큰을 갱신하지 못했습니다.');
  const refreshed = await response.json();
  await env.TOKENS.put('strava-tokens', JSON.stringify(refreshed));
  return refreshed;
}

// Ride Week tracks both bike rides and runs. Keep the original Strava type on
// every record so the web app can route a record to the right analysis screen.
const supportedActivity = activity => [
  'Ride', 'VirtualRide', 'EBikeRide',
  'Run', 'VirtualRun', 'TrailRun',
].includes(activity.type);

function toRide(activity) {
  return {
    id: `strava-${activity.id}`,
    stravaId: activity.id,
    title: activity.name,
    date: activity.start_date_local.slice(0, 10),
    distance: Math.round((activity.distance / 1000) * 10) / 10,
    distanceMeters: Number(activity.distance) || 0,
    duration: Math.round(activity.moving_time / 60),
    elevation: Math.round(activity.total_elevation_gain || 0),
    load: Math.round(activity.suffer_score || 0),
    averageSpeed: activity.average_speed ? Math.round(activity.average_speed * 36) / 10 : null,
    averageSpeedMetersPerSecond: Number(activity.average_speed) || null,
    averageWatts: Math.round(activity.weighted_average_watts || activity.average_watts || 0) || null,
    averageCadence: Math.round(activity.average_cadence || 0) || null,
    averageHeartRate: Math.round(activity.average_heartrate || 0) || null,
    maxHeartRate: Math.round(activity.max_heartrate || 0) || null,
    type: activity.type,
    sportType: activity.sport_type || activity.type,
    trainer: Boolean(activity.trainer),
    commute: Boolean(activity.commute),
    movingTimeSeconds: Number(activity.moving_time) || 0,
    durationSeconds: Number(activity.elapsed_time || activity.moving_time) || 0,
    note: 'Strava에서 동기화됨',
    icon: 'sun',
  };
}

const compact = values => {
  if (!Array.isArray(values)) return [];
  const step = Math.max(1, Math.ceil(values.length / 56));
  return values.filter((_, index) => index % step === 0).map(value => Number(value) || 0);
};

function toActivityDetail(activity, streams) {
  return {
    activity: {
      ...toRide(activity),
      splitsMetric: activity.splits_metric || [],
    },
    streams: {
      watts: compact(streams.watts?.data),
      time: compact(streams.time?.data),
      moving: compact(streams.moving?.data),
      distance: compact(streams.distance?.data),
      cadence: compact(streams.cadence?.data),
      heartrate: compact(streams.heartrate?.data),
      altitude: compact(streams.altitude?.data),
      velocity_smooth: compact(streams.velocity_smooth?.data),
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (url.pathname === '/health') return json({ ok: true }, 200, origin);

    if (url.pathname === '/auth/strava') {
      if (url.searchParams.get('key') !== env.RIDE_WEEK_SYNC_KEY) return json({ error: '권한이 없습니다.' }, 401, origin);
      const state = crypto.randomUUID();
      await env.TOKENS.put(`oauth-state:${state}`, '1', { expirationTtl: 600 });
      const authorize = new URL(STRAVA_AUTHORIZE_URL);
      authorize.search = new URLSearchParams({
        client_id: env.STRAVA_CLIENT_ID,
        redirect_uri: `${url.origin}/auth/strava/callback`,
        response_type: 'code',
        approval_prompt: 'auto',
        scope: 'read,activity:read_all',
        state,
      }).toString();
      return Response.redirect(authorize, 302);
    }

    if (url.pathname === '/auth/strava/callback') {
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!state || !code || !await env.TOKENS.get(`oauth-state:${state}`)) return new Response('유효하지 않은 Strava 연결 요청입니다.', { status: 400 });
      await env.TOKENS.delete(`oauth-state:${state}`);
      const response = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.STRAVA_CLIENT_ID,
          client_secret: env.STRAVA_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
        }),
      });
      if (!response.ok) return new Response('Strava 연결에 실패했습니다.', { status: 502 });
      await env.TOKENS.put('strava-tokens', JSON.stringify(await response.json()));
      return Response.redirect(`${env.FRONTEND_URL}?strava=connected`, 302);
    }

    if (url.pathname === '/api/status') {
      if (!isAuthorized(request, env)) return json({ error: '권한이 없습니다.' }, 401, origin);
      return json({ connected: Boolean(await env.TOKENS.get('strava-tokens')) }, 200, origin);
    }

    if (url.pathname.startsWith('/api/activities/')) {
      if (!isAuthorized(request, env)) return json({ error: '권한이 없습니다.' }, 401, origin);
      const id = url.pathname.split('/').pop();
      if (!/^\d+$/.test(id)) return json({ error: '올바르지 않은 활동입니다.' }, 400, origin);
      try {
        const token = await refreshTokenIfNeeded(env);
        if (!token) return json({ error: 'Strava 계정을 먼저 연결해 주세요.' }, 409, origin);
        const headers = { authorization: `Bearer ${token.access_token}` };
        const [activityResponse, streamsResponse] = await Promise.all([
          fetch(stravaActivityUrl(id), { headers }),
          fetch(stravaStreamsUrl(id), { headers }),
        ]);
        if (!activityResponse.ok) throw new Error('라이딩 상세 정보를 가져오지 못했습니다.');
        const activity = await activityResponse.json();
        const streams = streamsResponse.ok ? await streamsResponse.json() : {};
        return json(toActivityDetail(activity, streams), 200, origin);
      } catch (error) {
        return json({ error: error.message }, 502, origin);
      }
    }

    if (url.pathname === '/api/activities') {
      if (!isAuthorized(request, env)) return json({ error: '권한이 없습니다.' }, 401, origin);
      try {
        const token = await refreshTokenIfNeeded(env);
        if (!token) return json({ error: 'Strava 계정을 먼저 연결해 주세요.' }, 409, origin);
        // Strava returns at most 200 activities per request. The client asks
        // for pages until this endpoint says there is no following page.
        const requestedPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
        const requestedPerPage = Number.parseInt(url.searchParams.get('per_page') || '200', 10);
        const page = Number.isFinite(requestedPage) ? Math.min(Math.max(requestedPage, 1), 2000) : 1;
        const perPage = Number.isFinite(requestedPerPage) ? Math.min(Math.max(requestedPerPage, 1), 200) : 200;
        const activitiesUrl = new URL(STRAVA_ACTIVITIES_URL);
        activitiesUrl.searchParams.set('page', String(page));
        activitiesUrl.searchParams.set('per_page', String(perPage));
        const response = await fetch(activitiesUrl, { headers: { authorization: `Bearer ${token.access_token}` } });
        if (!response.ok) throw new Error('Strava 활동을 가져오지 못했습니다.');
        const activities = await response.json();
        const trackedActivities = activities.filter(supportedActivity).map(toRide);
        return json({
          // `rides` remains for backwards compatibility with the existing app.
          rides: trackedActivities,
          hasMore: activities.length === perPage,
          page,
        }, 200, origin);
      } catch (error) {
        return json({ error: error.message }, 502, origin);
      }
    }

    return json({ error: '찾을 수 없는 경로입니다.' }, 404, origin);
  },
};
