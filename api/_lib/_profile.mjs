import crypto from "node:crypto";

export const PROFILE_MAX_BYTES = 900_000;
export const PROFILE_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;
export const PAIR_TTL_SECONDS = 10 * 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Cache-Control": "no-store",
  Vary: "Authorization",
};

export class ProfileError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code) => { throw new ProfileError(status, code); };
const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const boundedString = (v, max, field, { optional = false } = {}) => {
  if (optional && v == null) return undefined;
  if (typeof v !== "string" || v.length > max || !v.trim()) fail(400, `invalid_${field}`);
  return v.trim();
};
const finite = (v, field, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `invalid_${field}`);
  return n;
};
const id = (v, field) => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9:_-]{1,120}$/.test(v)) fail(400, `invalid_${field}`);
  return v;
};
const uuid = (v, field) => {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) fail(400, `invalid_${field}`);
  return v.toLowerCase();
};
const safeItem = (value, { requireEpisode = false } = {}) => {
  if (!isRecord(value) || !["movie", "tv"].includes(value.type)) fail(400, "invalid_item");
  const item = { type: value.type, id: id(String(value.id ?? ""), "item_id") };
  if (value.title != null) item.title = boundedString(value.title, 240, "title");
  if (value.year != null) item.year = finite(value.year, "year", 1870, 2200);
  if (value.poster_path != null) {
    if (typeof value.poster_path !== "string" || value.poster_path.length > 240 || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value.poster_path)) fail(400, "invalid_poster_path");
    item.poster_path = value.poster_path;
  }
  for (const key of ["imdb_id", "kinopoisk_id"]) {
    if (value[key] == null) continue;
    const externalId = boundedString(String(value[key]), 120, key);
    if (!/^[A-Za-z0-9_-]+$/.test(externalId)) fail(400, `invalid_${key}`);
    item[key] = externalId;
  }
  if (value.catalogSource != null) {
    const catalogSource = boundedString(String(value.catalogSource), 60, "catalog_source");
    if (!/^[A-Za-z0-9_-]+$/.test(catalogSource)) fail(400, "invalid_catalog_source");
    item.catalogSource = catalogSource;
  }
  if (value.vote_average != null) item.vote_average = finite(value.vote_average, "vote_average", 0, 10);
  if (value.type === "tv" && (requireEpisode || value.season != null || value.episode != null)) {
    if (value.season == null || value.episode == null) fail(400, "tv_episode_required");
    item.season = finite(value.season, "season", 0, 1000);
    item.episode = finite(value.episode, "episode", 0, 10000);
  }
  if (Array.isArray(value.genres)) {
    if (value.genres.length > 16) fail(400, "too_many_genres");
    item.genres = value.genres.map((genre) => {
      if (!isRecord(genre)) fail(400, "invalid_genre");
      return { id: finite(genre.id, "genre_id", 1, 100_000), name: boundedString(genre.name, 60, "genre_name") };
    });
  }
  return item;
};
const safePreference = (v) => {
  if (v == null) return undefined;
  if (!isRecord(v)) fail(400, "invalid_preference");
  return {
    ...(typeof v.name === "string" ? { name: v.name.slice(0, 120) } : {}),
    ...(typeof v.lang === "string" ? { lang: v.lang.slice(0, 32) } : {}),
  };
};
const safePreferences = (v) => {
  if (v == null) return {};
  if (!isRecord(v)) fail(400, "invalid_preferences");
  const out = {};
  for (const key of ["providerId", "providerName", "voiceId", "voiceName"]) if (v[key] != null) out[key] = boundedString(String(v[key]), 120, key);
  if (v.audio != null) out.audio = safePreference(v.audio);
  if (v.subtitle != null) {
    if (!isRecord(v.subtitle) || typeof v.subtitle.enabled !== "boolean") fail(400, "invalid_subtitle");
    out.subtitle = { enabled: v.subtitle.enabled, ...(v.subtitle.kind != null ? { kind: boundedString(v.subtitle.kind, 40, "subtitle_kind") } : {}), ...safePreference({ name: v.subtitle.name, lang: v.subtitle.lang }) };
  }
  if (v.quality != null) out.quality = boundedString(String(v.quality), 40, "quality");
  return out;
};

export function validateCheckpoint(value) {
  if (!isRecord(value)) fail(400, "invalid_checkpoint");
  const progressKey = id(value.progressKey, "progress_key");
  const item = safeItem(value.item, { requireEpisode: true });
  const expected = item.type === "movie" ? `movie_${item.id}` : `tv_${item.id}_s${item.season ?? 0}e${item.episode ?? 0}`;
  if (progressKey !== expected) fail(400, "progress_key_mismatch");
  return {
    progressKey,
    item,
    position: finite(value.position, "position", 0, 7 * 24 * 3600),
    duration: finite(value.duration, "duration", 0, 7 * 24 * 3600),
    preferences: safePreferences(value.preferences),
    baseRevision: finite(value.baseRevision, "base_revision", 0, Number.MAX_SAFE_INTEGER),
  };
}

export function validateSession(value) {
  if (!isRecord(value)) fail(400, "invalid_session");
  const sessionId = uuid(value.sessionId, "session_id");
  const progressKey = id(value.progressKey, "progress_key");
  const item = safeItem(value.item, { requireEpisode: true });
  const expected = item.type === "movie" ? `movie_${item.id}` : `tv_${item.id}_s${item.season ?? 0}e${item.episode ?? 0}`;
  if (progressKey !== expected) fail(400, "progress_key_mismatch");
  if (!Array.isArray(value.segments) || value.segments.length > 200) fail(400, "invalid_segments");
  const segments = value.segments.map((segment) => {
    if (!isRecord(segment)) fail(400, "invalid_segment");
    const start = finite(segment.start, "segment_start", 0, 8.64e15);
    const end = finite(segment.end, "segment_end", start, 8.64e15);
    if (end - start > 24 * 60 * 60 * 1000) fail(400, "segment_too_long");
    return { start, end };
  });
  return { sessionId, progressKey, item, segments, ...(value.completedAt ? { completedAt: finite(value.completedAt, "completed_at", 0, 8.64e15) } : {}) };
}

const LIBRARY_BUCKETS = ["saved", "watched", "history", "ratings"];
export function validateLibrary(value) {
  if (value == null) return undefined;
  if (!isRecord(value)) fail(400, "invalid_library");
  if (Object.keys(value).some((bucket) => !LIBRARY_BUCKETS.includes(bucket))) fail(400, "invalid_library_bucket");
  const out = {};
  for (const bucket of LIBRARY_BUCKETS) {
    if (value[bucket] == null) continue;
    if (!isRecord(value[bucket]) || Object.keys(value[bucket]).length > 500) fail(400, "invalid_library_records");
    out[bucket] = {};
    for (const [key, record] of Object.entries(value[bucket])) {
      id(key, "library_key");
      if (!isRecord(record)) fail(400, "invalid_library_record");
      const clean = { baseRevision: finite(record.baseRevision ?? 0, "base_revision", 0, Number.MAX_SAFE_INTEGER) };
      if (record.deleted !== undefined) {
        if (typeof record.deleted !== "boolean") fail(400, "invalid_tombstone");
        clean.deleted = record.deleted;
      }
      if (record.value !== undefined) {
        if (bucket === "ratings") {
          if (!isRecord(record.value)) fail(400, "invalid_rating");
          clean.value = {
            score: finite(record.value.score, "rating", 1, 10),
            ratedAt: finite(record.value.ratedAt, "rated_at", 0, 8.64e15),
            item: safeItem(record.value.item),
          };
        } else if (bucket === "saved") clean.value = safeItem(record.value);
        else if (bucket === "watched") {
          if (typeof record.value !== "boolean") fail(400, "invalid_library_value");
          clean.value = record.value;
        } else if (bucket === "history") {
          if (!isRecord(record.value)) fail(400, "invalid_history_entry");
          clean.value = {
            ...safeItem(record.value),
            watchedAt: finite(record.value.watchedAt, "watched_at", 0, 8.64e15),
            ...(record.value.season != null ? { season: finite(record.value.season, "season", 0, 1000) } : {}),
            ...(record.value.episode != null ? { episode: finite(record.value.episode, "episode", 0, 10000) } : {}),
            ...(record.value.episodeName != null ? { episodeName: boundedString(record.value.episodeName, 240, "episode_name") } : {}),
          };
        }
      } else if (record.deleted !== true) {
        fail(400, "library_value_required");
      }
      out[bucket][key] = clean;
    }
  }
  return out;
}

function mergeIntervals(a = [], b = []) {
  const sorted = [...a, ...b].sort((x, y) => x.start - y.start || x.end - y.end);
  const out = [];
  for (const segment of sorted) {
    const last = out.at(-1);
    if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end);
    else out.push({ ...segment });
  }
  return out;
}

// Pure reference implementation shared by unit tests and the Redis Lua merge.
export function mergeProfileSnapshot(current, patch, { deviceId, now }) {
  const next = structuredClone(current);
  const mutationId = patch.mutationId;
  if (mutationId && next.mutationReceipts?.[mutationId]) return next;
  const revision = current.revision + 1;
  const resetRevision = Number(next.watchResetRevision) || 0;
  const clearedAt = Number(next.watchClearedAt) || 0;
  if (patch.displayName !== undefined) next.displayName = patch.displayName;
  for (const incoming of patch.checkpoints || []) {
    const old = next.checkpoints[incoming.progressKey];
    if (incoming.baseRevision >= resetRevision && (!old || incoming.baseRevision >= old.revision)) {
      next.checkpoints[incoming.progressKey] = { ...incoming, updatedAt: now, deviceId, revision };
    }
  }
  for (const incoming of patch.sessions || []) {
    const old = next.sessions[incoming.sessionId];
    const kept = [...(old?.segments || []), ...(incoming.segments || [])]
      .filter((segment) => segment.end > clearedAt)
      .map((segment) => ({ start: Math.max(segment.start, clearedAt), end: segment.end }));
    const completedAt = [incoming.completedAt, old?.completedAt].find((value) => value != null && value >= clearedAt);
    if (kept.length || completedAt != null || clearedAt === 0) {
      next.sessions[incoming.sessionId] = {
        ...(old || {}), ...incoming, deviceId,
        segments: mergeIntervals([], kept),
        ...(completedAt != null ? { completedAt } : {}),
        updatedAt: now,
      };
      if (completedAt == null) delete next.sessions[incoming.sessionId].completedAt;
    } else delete next.sessions[incoming.sessionId];
  }
  for (const bucket of LIBRARY_BUCKETS) {
    for (const [key, incoming] of Object.entries(patch.library?.[bucket] || {})) {
      const old = next.library[bucket][key];
      if ((bucket === "saved" || bucket === "ratings" || incoming.baseRevision >= resetRevision) && (!old || incoming.baseRevision >= old.revision)) next.library[bucket][key] = { ...incoming, updatedAt: now, deviceId, revision };
    }
  }
  next.revision = revision;
  next.updatedAt = now;
  next.mutationReceipts ||= {};
  next.mutationOrder ||= [];
  if (mutationId) {
    next.mutationReceipts[mutationId] = revision;
    next.mutationOrder.push(mutationId);
    while (next.mutationOrder.length > 128) delete next.mutationReceipts[next.mutationOrder.shift()];
  }
  return next;
}

const MERGE_LUA = `-- profile:merge:v1
local raw = redis.call('GET', KEYS[1]); if not raw then return {err='PROFILE_MISSING'} end
local p = cjson.decode(raw); local patch = cjson.decode(ARGV[1]); local deviceId = ARGV[2]; local now = tonumber(ARGV[3]); local mutationId=ARGV[7]
local device=p.devices[deviceId]; if not device or not device.active or device.credentialHash~=ARGV[6] then return {err='CREDENTIAL_REVOKED'} end
if p.mutationReceipts and p.mutationReceipts[mutationId] then return {cjson.encode(p),tostring(p.revision)} end
if not p.mutationReceipts then p.mutationReceipts={} end; if not p.mutationOrder then p.mutationOrder={} end
local revision = (tonumber(p.revision) or 0) + 1
local resetRevision=tonumber(p.watchResetRevision) or 0; local clearedAt=tonumber(p.watchClearedAt) or 0
if patch.displayName~=nil then p.displayName=patch.displayName end
for _, c in ipairs(patch.checkpoints or {}) do
  local old = p.checkpoints[c.progressKey]
  if (tonumber(c.baseRevision) or 0)>=resetRevision and ((not old) or (tonumber(c.baseRevision) or 0) >= (tonumber(old.revision) or 0)) then
    c.revision=revision; c.updatedAt=now; c.deviceId=deviceId; p.checkpoints[c.progressKey]=c
  end
end
for _, s in ipairs(patch.sessions or {}) do
  local old=p.sessions[s.sessionId]; local merged={}
  if old and old.segments then for _,v in ipairs(old.segments) do if tonumber(v['end'])>clearedAt then table.insert(merged,{start=math.max(tonumber(v.start),clearedAt),['end']=tonumber(v['end'])}) end end end
  for _,v in ipairs(s.segments or {}) do if tonumber(v['end'])>clearedAt then table.insert(merged,{start=math.max(tonumber(v.start),clearedAt),['end']=tonumber(v['end'])}) end end
  table.sort(merged,function(a,b) return tonumber(a.start)<tonumber(b.start) end)
  local union={}; for _,v in ipairs(merged) do local last=union[#union]; if last and tonumber(v.start)<=tonumber(last[2]) then if tonumber(v['end'])>tonumber(last[2]) then last[2]=tonumber(v['end']) end else table.insert(union,{tonumber(v.start),tonumber(v['end'])}) end end
  local segs={}; for _,v in ipairs(union) do table.insert(segs,{start=v[1],['end']=v[2]}) end
  s.segments=segs; s.updatedAt=now; s.deviceId=deviceId
  if not s.completedAt and old and tonumber(old.completedAt or 0)>=clearedAt then s.completedAt=old.completedAt end
  if tonumber(s.completedAt or 0)<clearedAt then s.completedAt=nil end
  if #segs>0 or s.completedAt or clearedAt==0 then p.sessions[s.sessionId]=s else p.sessions[s.sessionId]=nil end
end
for _, bucket in ipairs({'saved','watched','history','ratings'}) do
  for key, record in pairs((patch.library or {})[bucket] or {}) do
    local old=p.library[bucket][key]
    local survivesReset=bucket=='saved' or bucket=='ratings' or (tonumber(record.baseRevision) or 0)>=resetRevision
    if survivesReset and ((not old) or (tonumber(record.baseRevision) or 0)>=(tonumber(old.revision) or 0)) then record.revision=revision; record.updatedAt=now; record.deviceId=deviceId; p.library[bucket][key]=record end
  end
end
p.revision=revision; p.updatedAt=now
table.insert(p.mutationOrder,mutationId); p.mutationReceipts[mutationId]=revision
if #p.mutationOrder>128 then local expired=table.remove(p.mutationOrder,1); p.mutationReceipts[expired]=nil end
local encoded=cjson.encode(p); if string.len(encoded)>tonumber(ARGV[4]) then return {err='PROFILE_TOO_LARGE'} end
redis.call('SET',KEYS[1],encoded,'EX',ARGV[5]); return {encoded,tostring(revision)}`;

const CLEAR_WATCH_LUA = `-- profile:watch-clear:v1
local raw=redis.call('GET',KEYS[1]); if not raw then return {err='PROFILE_MISSING'} end
local p=cjson.decode(raw); local device=p.devices[ARGV[2]]
if not device or not device.active or device.credentialHash~=ARGV[6] then return {err='CREDENTIAL_REVOKED'} end
if p.mutationReceipts and p.mutationReceipts[ARGV[1]] then return {cjson.encode(p),tostring(p.revision)} end
local requested=tonumber(ARGV[3]); local now=tonumber(ARGV[4]); local currentCutoff=tonumber(p.watchClearedAt) or 0
if p.watchClearMutationId==ARGV[1] or requested<=currentCutoff then return {cjson.encode(p),tostring(p.revision)} end
local revision=(tonumber(p.revision) or 0)+1; local clearedAt=math.min(requested,now)
p.checkpoints={}; p.sessions={}; p.library=p.library or {}; p.library.history={}; p.library.watched={}
p.revision=revision; p.watchResetRevision=revision; p.watchClearedAt=clearedAt; p.watchClearMutationId=ARGV[1]; p.updatedAt=now
p.mutationReceipts=p.mutationReceipts or {}; p.mutationOrder=p.mutationOrder or {}; table.insert(p.mutationOrder,ARGV[1]); p.mutationReceipts[ARGV[1]]=revision
if #p.mutationOrder>128 then local expired=table.remove(p.mutationOrder,1); p.mutationReceipts[expired]=nil end
local encoded=cjson.encode(p); if string.len(encoded)>tonumber(ARGV[5]) then return {err='PROFILE_TOO_LARGE'} end
redis.call('SET',KEYS[1],encoded,'EX',ARGV[7]); return {encoded,tostring(revision)}`;

const CREATE_LUA = `-- profile:create:v1
if redis.call('EXISTS', KEYS[1]) == 1 then return {err='PROFILE_EXISTS'} end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]); redis.call('SET',KEYS[2],ARGV[3],'EX',ARGV[2]); return 'OK'`;

const REVOKE_LUA = `-- profile:revoke:v1
local raw=redis.call('GET',KEYS[1]); if not raw then return {err='PROFILE_MISSING'} end
local p=cjson.decode(raw); local caller=p.devices[ARGV[2]]; if not caller or not caller.active or caller.credentialHash~=ARGV[6] then return {err='CREDENTIAL_REVOKED'} end
local deviceId=ARGV[1]; if deviceId==ARGV[2] then return {err='CANNOT_REVOKE_SELF'} end
local d=p.devices[deviceId]; if not d or not d.active then return {err='DEVICE_MISSING'} end
local cred=ARGV[3]; redis.call('DEL',cred); d.active=false; d.revokedAt=tonumber(ARGV[4]); p.revision=(tonumber(p.revision) or 0)+1; p.updatedAt=tonumber(ARGV[4]);
local enc=cjson.encode(p); redis.call('SET',KEYS[1],enc,'EX',ARGV[5]); return enc`;

const PAIR_CREATE_LUA = `-- profile:pair-create:v1
local raw=redis.call('GET',KEYS[1]); if not raw then return {err='PROFILE_MISSING'} end
local p=cjson.decode(raw); local caller=p.devices[ARGV[4]]; if not caller or not caller.active or caller.credentialHash~=ARGV[5] then return {err='CREDENTIAL_REVOKED'} end
local codeKey=KEYS[2]; if redis.call('EXISTS',codeKey)==1 then return {err='PAIR_COLLISION'} end
redis.call('SET',KEYS[3],ARGV[1],'EX',ARGV[2]); redis.call('SET',codeKey,ARGV[3],'EX',ARGV[2]); return 'OK'`;

const PAIR_CLAIM_LUA = `-- profile:pair-claim:v1
local t=redis.call('GET',KEYS[1]); if not t then return {err='PAIR_EXPIRED'} end
local pair=cjson.decode(t); if pair.claimed then return {err='PAIR_ALREADY_CLAIMED'} end
local raw=redis.call('GET',KEYS[2]); if not raw then return {err='PROFILE_MISSING'} end
local p=cjson.decode(raw); p.pendingPairings=p.pendingPairings or {}; local now=tonumber(ARGV[5]); local count=0
for id,request in pairs(p.pendingPairings) do
  if (tonumber(request.expiresAt) or 0)<=now then p.pendingPairings[id]=nil
  elseif request.status=='pending' then count=count+1
  elseif request.status~='approved' then p.pendingPairings[id]=nil end
end
if count>=tonumber(ARGV[8]) then return {err='PAIRING_LIMIT'} end
local req={requestId=ARGV[1],profileId=p.profileId,deviceName=ARGV[2],status='pending',tokenHash=ARGV[3],pollTokenHash=ARGV[4],createdAt=now,expiresAt=now+tonumber(ARGV[6])*1000}
pair.claimed=true; pair.requestId=ARGV[1]; pair.deviceName=ARGV[2]
p.pendingPairings[ARGV[1]]=req; p.updatedAt=now;
redis.call('SET',KEYS[1],cjson.encode(pair),'EX',ARGV[6]); redis.call('SET',KEYS[3],cjson.encode(req),'EX',ARGV[6]); redis.call('SET',KEYS[2],cjson.encode(p),'EX',ARGV[7]); return 'OK'`;

const PAIR_APPROVE_LUA = `-- profile:pair-approve:v1
local raw=redis.call('GET',KEYS[1]); if not raw then return {err='PROFILE_MISSING'} end
local p=cjson.decode(raw); local caller=p.devices[ARGV[5]]; if not caller or not caller.active or caller.credentialHash~=ARGV[6] then return {err='CREDENTIAL_REVOKED'} end
local req=p.pendingPairings[ARGV[1]]; if not req then return {err='PAIR_REQUEST_MISSING'} end
if (tonumber(req.expiresAt) or 0)<=tonumber(ARGV[2]) then p.pendingPairings[ARGV[1]]=nil; redis.call('SET',KEYS[1],cjson.encode(p),'EX',ARGV[4]); return {err='PAIR_EXPIRED'} end
if req.status~='pending' then return {err='PAIR_NOT_PENDING'} end
req.status='approved'; req.approvedAt=tonumber(ARGV[2]); p.pendingPairings[ARGV[1]]=req; p.updatedAt=tonumber(ARGV[2]);
local rr=redis.call('GET',KEYS[2]); if not rr then return {err='PAIR_EXPIRED'} end
local request=cjson.decode(rr); request.status='approved'; request.approvedAt=tonumber(ARGV[2]);
redis.call('SET',KEYS[2],cjson.encode(request),'EX',ARGV[3]); redis.call('SET',KEYS[1],cjson.encode(p),'EX',ARGV[4]); return 'OK'`;

const PAIR_POLL_LUA = `-- profile:pair-poll:v1
local raw=redis.call('GET',KEYS[1]); if not raw then return {err='PROFILE_MISSING'} end
local p=cjson.decode(raw); local req=p.pendingPairings[ARGV[1]]; if not req then return {err='PAIR_REQUEST_MISSING'} end
if req.pollTokenHash~=ARGV[2] then return {err='PAIR_TOKEN_INVALID'} end
if (tonumber(req.expiresAt) or 0)<=tonumber(ARGV[5]) then p.pendingPairings[ARGV[1]]=nil; redis.call('SET',KEYS[1],cjson.encode(p),'EX',ARGV[8]); return {err='PAIR_EXPIRED'} end
if req.status~='approved' then return {'pending'} end
if req.credentialIssued then return {'used'} end
local deviceId=ARGV[3]; local credentialHash=ARGV[4]; local credentialKey=KEYS[2]..credentialHash
local d={deviceId=deviceId,name=req.deviceName,active=true,createdAt=tonumber(ARGV[5]),credentialHash=credentialHash}
p.devices[deviceId]=d; p.pendingPairings[ARGV[1]]=nil
p.revision=(tonumber(p.revision) or 0)+1; p.updatedAt=tonumber(ARGV[5]); local enc=cjson.encode(p)
if string.len(enc)>tonumber(ARGV[7]) then return {err='PROFILE_TOO_LARGE'} end
local requestRaw=redis.call('GET',KEYS[3]); if requestRaw then local request=cjson.decode(requestRaw); request.status='used'; request.credentialIssued=true; redis.call('SET',KEYS[3],cjson.encode(request),'EX',ARGV[9]) end
redis.call('SET',KEYS[1],enc,'EX',ARGV[8]); redis.call('SET',credentialKey,cjson.encode({profileId=p.profileId,deviceId=deviceId}),'EX',ARGV[8]); return {'issued',enc,tostring(p.revision)}`;

function getMasterKey(env = process.env) {
  const value = env.PROFILE_DATA_SECRET || "";
  if (!/^[0-9a-f]{64}$/i.test(value)) fail(503, "profile_encryption_unavailable");
  return Buffer.from(value, "hex");
}

function encryptToken(token, env) {
  if (!token) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getMasterKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64url"), data: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}
function decryptToken(record, env) {
  if (!record) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", getMasterKey(env), Buffer.from(record.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(record.data, "base64url")), decipher.final()]).toString("utf8");
}

const REDIS_COMMAND_NAMES = new Set(["GET", "SET", "DEL", "INCR", "EXPIRE", "EXISTS", "EVAL", "EVALSHA"]);
const SAFE_NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT"]);

function redisDiagnostic({ reason, command, env, status, causeCode, redisError }) {
  const rawName = typeof command?.[0] === "string" ? command[0].toUpperCase() : "UNKNOWN";
  const commandName = REDIS_COMMAND_NAMES.has(rawName) ? rawName : "UNKNOWN";
  let redisErrorClass;
  if (redisError) {
    const value = String(redisError).toUpperCase();
    if (value.includes("WRONGTYPE")) redisErrorClass = "WRONGTYPE";
    else if (value.includes("NOAUTH") || value.includes("NOPERM")) redisErrorClass = "AUTH";
    else if (value.includes("OOM") || value.includes("BUSY") || value.includes("LOADING")) redisErrorClass = "CAPACITY";
    else if (value.includes("ERR")) redisErrorClass = "REDIS_ERR";
    else redisErrorClass = "OTHER";
  }
  const safeCauseCode = typeof causeCode === "string" && (
    SAFE_NETWORK_CODES.has(causeCode) || /^CERT_[A-Z0-9_]{1,32}$/.test(causeCode) || /^UND_ERR_[A-Z0-9_]{1,40}$/.test(causeCode)
  ) ? causeCode : "UNKNOWN";
  console.error("profile_storage_diagnostic", JSON.stringify({
    reason,
    commandName,
    urlConfigured: Boolean(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL),
    tokenConfigured: Boolean(env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN),
    ...(Number.isInteger(status) ? { upstreamStatus: status } : {}),
    ...(reason === "network" ? { causeCode: safeCauseCode } : {}),
    ...(redisErrorClass ? { redisErrorClass } : {}),
  }));
}

function networkCauseCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    if (typeof current.code === "string") return current.code;
  }
  return undefined;
}

async function redisCommand(command, env, fetchImpl = fetch) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) {
    redisDiagnostic({ reason: "missing_config", command, env });
    fail(503, "profile_storage_unavailable");
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    redisDiagnostic({ reason: "network", command, env, causeCode: networkCauseCode(error) });
    fail(503, "profile_storage_unavailable");
  }
  if (!response.ok) {
    redisDiagnostic({ reason: "http", command, env, status: response.status });
    fail(503, "profile_storage_unavailable");
  }
  let json;
  try { json = await response.json(); } catch {
    redisDiagnostic({ reason: "json", command, env, status: response.status });
    fail(503, "profile_storage_unavailable");
  }
  if (!json || typeof json !== "object") {
    redisDiagnostic({ reason: "json", command, env, status: response.status });
    fail(503, "profile_storage_unavailable");
  }
  if (json.error) {
    const error = String(json.error);
    if (error.includes("PROFILE_MISSING")) fail(404, "profile_not_found");
    if (error.includes("CREDENTIAL_REVOKED")) fail(401, "unauthorized");
    if (error.includes("PAIR_EXPIRED")) fail(410, "pairing_expired");
    if (error.includes("PAIR_ALREADY_CLAIMED")) fail(409, "pairing_already_claimed");
    if (error.includes("PAIRING_LIMIT")) fail(429, "too_many_pending_pairings");
    if (error.includes("PAIR_REQUEST_MISSING")) fail(404, "pairing_request_not_found");
    if (error.includes("PAIR_NOT_PENDING")) fail(409, "pairing_not_pending");
    if (error.includes("PAIR_TOKEN_INVALID")) fail(401, "invalid_pairing_token");
    if (error.includes("CANNOT_REVOKE_SELF")) fail(400, "cannot_revoke_current_device");
    if (error.includes("DEVICE_MISSING")) fail(404, "device_not_found");
    if (error.includes("PROFILE_TOO_LARGE")) fail(413, "profile_too_large");
    if (error.includes("PAIR_COLLISION")) fail(409, "pairing_code_collision");
    if (error.includes("PROFILE_EXISTS")) fail(409, "profile_exists");
    redisDiagnostic({ reason: "redis", command, env, status: response.status, redisError: error });
    fail(503, "profile_storage_unavailable");
  }
  return json.result;
}

const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString("hex");
const randomCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
};
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const profileKey = (profileId) => `profile:v1:${profileId}`;
const credentialKey = (hash) => `profile:credential:v1:${hash}`;
const pairTokenKey = (hash) => `profile:pair-token:v1:${hash}`;
const pairCodeKey = (code) => `profile:pair-code:v1:${code}`;
const pairRequestKey = (requestId) => `profile:pair-request:v1:${requestId}`;

function publicSnapshot(profile, timestamp = Date.now()) {
  const { tmdbTokenCiphertext: _secret, mutationReceipts: _receipts, mutationOrder: _mutationOrder, ...snapshot } = profile;
  // Redis Lua cjson decodes JSON [] and {} into the same empty Lua table, then
  // encodes both as {}. Restore the two public schema fields that are arrays.
  const restoreArrays = (value) => {
    if (Array.isArray(value)) { value.forEach(restoreArrays); return; }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "genres" || key === "segments") && isRecord(child) && Object.keys(child).length === 0) value[key] = [];
      else restoreArrays(child);
    }
  };
  restoreArrays(snapshot);
  snapshot.devices = Object.fromEntries(Object.entries(profile.devices || {}).map(([key, device]) => {
    const { credentialHash: _credentialHash, ...safeDevice } = device;
    return [key, safeDevice];
  }));
  snapshot.pendingPairings = Object.fromEntries(Object.entries(profile.pendingPairings || {}).filter(([, request]) =>
    request.status === "pending" && Number(request.expiresAt) > timestamp).map(([key, request]) => {
    const { tokenHash: _tokenHash, pollTokenHash: _pollTokenHash, ...safeRequest } = request;
    return [key, safeRequest];
  }));
  return snapshot;
}

function parseProfile(raw) {
  if (!raw) fail(404, "profile_not_found");
  let profile;
  try { profile = JSON.parse(raw); } catch { fail(503, "profile_storage_unavailable"); }
  return profile;
}

function query(req) {
  const u = new URL(req.url || "/api/profile", "https://local.invalid");
  return { op: u.searchParams.get("op") || "", include: u.searchParams.get("include") || "" };
}

function send(res, status, body) {
  return res.status(status).json(body);
}

export function createProfileHandler({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const redis = (command) => redisCommand(command, env, fetchImpl);
  const evalScript = (script, keys, args) => redis(["EVAL", script, String(keys.length), ...keys, ...args.map(String)]);

  async function authenticated(req) {
    const authorization = req.headers?.authorization || "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(bearer)) fail(401, "unauthorized");
    const mapping = await redis(["GET", credentialKey(sha(bearer))]);
    if (!mapping) fail(401, "unauthorized");
    let record;
    try { record = JSON.parse(mapping); } catch { fail(401, "unauthorized"); }
    const profile = parseProfile(await redis(["GET", profileKey(record.profileId)]));
    const device = profile.devices?.[record.deviceId];
    if (!device?.active || device.credentialHash !== sha(bearer)) fail(401, "unauthorized");
    return { profile, profileId: record.profileId, deviceId: record.deviceId, bearerHash: sha(bearer) };
  }

  async function rateLimit(req, bucket, limit, windowSeconds) {
    const forwarded = req.headers?.["x-forwarded-for"] || "";
    const ip = String(req.headers?.["x-real-ip"] || forwarded.split(",").at(-1) || req.ip || "unknown").trim().slice(0, 80);
    const key = `profile:rate:v1:${bucket}:${sha(ip)}`;
    const script = `-- profile:rate-limit:v1\nlocal count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return count`;
    const result = await redis(["EVAL", script, "1", key, String(windowSeconds)]);
    if (Number(result) > limit) fail(429, "too_many_attempts");
  }

  return async function profileHandler(req, res) {
    for (const [key, value] of Object.entries(CORS)) res.setHeader(key, value);
    if (req.method === "OPTIONS") return res.status(204).end();
    try {
      const { op, include } = query(req);
      const body = isRecord(req.body) ? req.body : {};
      if (req.method === "POST" && !op) {
        await rateLimit(req, "create", 8, 60 * 60);
        const displayName = body.displayName == null ? "" : boundedString(body.displayName, 60, "display_name");
        const deviceName = body.deviceName == null ? "This device" : boundedString(body.deviceName, 60, "device_name");
        const tmdbToken = body.tmdbToken == null ? "" : boundedString(body.tmdbToken, 512, "tmdb_token");
        if (!tmdbToken) fail(400, "tmdb_token_required");
        const masterKey = getMasterKey(env); // Fail closed before persisting any profile.
        void masterKey;
        const profileId = randomId(16);
        const deviceId = randomId(12);
        const credential = crypto.randomBytes(32).toString("base64url");
        const hash = sha(credential);
        const timestamp = now();
        const profile = {
          schema: 1, profileId, revision: 0, watchResetRevision: 0, watchClearedAt: 0, displayName,
          createdAt: timestamp, updatedAt: timestamp,
          devices: { [deviceId]: { deviceId, name: deviceName, active: true, createdAt: timestamp, credentialHash: hash } },
          pendingPairings: {}, checkpoints: {}, sessions: {},
          mutationReceipts: {}, mutationOrder: [],
          library: { saved: {}, watched: {}, history: {}, ratings: {} },
          tmdbTokenCiphertext: encryptToken(tmdbToken, env),
        };
        const encoded = JSON.stringify(profile);
        if (Buffer.byteLength(encoded) > PROFILE_MAX_BYTES) fail(413, "profile_too_large");
        await evalScript(CREATE_LUA, [profileKey(profileId), credentialKey(hash)], [encoded, PROFILE_TTL_SECONDS, JSON.stringify({ profileId, deviceId })]);
        return send(res, 201, { credential, profileId, deviceId, revision: 0, snapshot: publicSnapshot(profile, now()) });
      }

      if (req.method === "POST" && op === "pair/claim") {
        await rateLimit(req, "claim", 12, 60);
        const deviceName = body.deviceName == null ? "Device" : boundedString(body.deviceName, 60, "device_name");
        let tokenHash = "";
        if (typeof body.requestToken === "string" && /^[A-Za-z0-9_-]{40,80}$/.test(body.requestToken)) tokenHash = sha(body.requestToken);
        else if (typeof body.shortCode === "string" && /^[A-HJ-NP-Z2-9]{8}$/.test(body.shortCode.toUpperCase())) {
          const record = await redis(["GET", pairCodeKey(body.shortCode.toUpperCase())]);
          if (record) { try { tokenHash = JSON.parse(record).tokenHash; } catch {} }
          else fail(410, "pairing_expired");
        }
        if (!tokenHash) fail(404, "pairing_not_found");
        const pairRaw = await redis(["GET", pairTokenKey(tokenHash)]);
        if (!pairRaw) fail(410, "pairing_expired");
        let pair;
        try { pair = JSON.parse(pairRaw); } catch { fail(410, "pairing_expired"); }
        const requestId = randomId(12);
        const pollToken = crypto.randomBytes(32).toString("base64url");
        const timestamp = now();
        await evalScript(PAIR_CLAIM_LUA, [pairTokenKey(tokenHash), profileKey(pair.profileId), pairRequestKey(requestId)], [requestId, deviceName, tokenHash, sha(pollToken), timestamp, PAIR_TTL_SECONDS, PROFILE_TTL_SECONDS, 16]);
        return send(res, 202, { requestId, pollToken, status: "pending", expiresAt: timestamp + PAIR_TTL_SECONDS * 1000 });
      }

      if (req.method === "POST" && op === "pair/poll") {
        await rateLimit(req, "poll", 60, 60);
        const requestId = id(body.requestId, "request_id");
        const pairToken = boundedString(body.pollToken || body.requestToken, 80, "poll_token");
        const mapping = await redis(["GET", pairRequestKey(requestId)]);
        if (!mapping) fail(410, "pairing_expired");
        let pairRequest;
        try { pairRequest = JSON.parse(mapping); } catch { fail(410, "pairing_expired"); }
        if (pairRequest.status === "used" || pairRequest.credentialIssued) fail(410, "pairing_already_used");
        const credential = crypto.randomBytes(32).toString("base64url");
        const deviceId = randomId(12);
        const issued = await evalScript(PAIR_POLL_LUA, [profileKey(pairRequest.profileId), "profile:credential:v1:", pairRequestKey(requestId)], [requestId, sha(pairToken), deviceId, sha(credential), now(), "", PROFILE_MAX_BYTES, PROFILE_TTL_SECONDS, PAIR_TTL_SECONDS]);
        if (Array.isArray(issued) && issued[0] === "pending") return send(res, 202, { status: "pending" });
        if (!Array.isArray(issued) || issued[0] !== "issued") fail(410, "pairing_already_used");
        const profile = parseProfile(issued[1]);
        return send(res, 200, { status: "approved", credential, profileId: profile.profileId, deviceId, revision: profile.revision, snapshot: publicSnapshot(profile, now()) });
      }

      const auth = await authenticated(req);
      if (req.method === "GET") {
        const snapshot = publicSnapshot(auth.profile, now());
        if (include === "bootstrapToken") {
          let tmdbToken;
          try { tmdbToken = decryptToken(auth.profile.tmdbTokenCiphertext, env); } catch { fail(503, "profile_encryption_unavailable"); }
          return send(res, 200, { ...snapshot, bootstrapToken: tmdbToken });
        }
        return send(res, 200, snapshot);
      }
      if (req.method === "PATCH" && !op) {
        const mutationId = uuid(body.mutationId, "mutation_id");
        void mutationId; // The atomic mutation key below makes retries idempotent.
        const deviceId = boundedString(body.deviceId, 64, "device_id");
        if (deviceId !== auth.deviceId) fail(403, "device_mismatch");
        const checkpoints = body.checkpoints == null ? [] : body.checkpoints;
        const sessions = body.sessions == null ? [] : body.sessions;
        if (!Array.isArray(checkpoints) || checkpoints.length > 80) fail(400, "invalid_checkpoints");
        if (!Array.isArray(sessions) || sessions.length > 80) fail(400, "invalid_sessions");
        const patch = {
          mutationId,
          ...(body.displayName !== undefined ? { displayName: boundedString(body.displayName, 60, "display_name") } : {}),
          checkpoints: checkpoints.map(validateCheckpoint),
          sessions: sessions.map(validateSession),
          library: validateLibrary(body.library) || {},
        };
        const encodedPatch = JSON.stringify(patch);
        if (Buffer.byteLength(encodedPatch) > 200_000) fail(413, "patch_too_large");
        const result = await evalScript(MERGE_LUA, [profileKey(auth.profileId)], [encodedPatch, auth.deviceId, now(), PROFILE_MAX_BYTES, PROFILE_TTL_SECONDS, auth.bearerHash, mutationId]);
        const merged = parseProfile(result[0]);
        return send(res, 200, { revision: merged.revision, snapshot: publicSnapshot(merged, now()) });
      }
      if (req.method === "POST" && op === "watch/clear") {
        const mutationId = uuid(body.mutationId, "mutation_id");
        const deviceId = boundedString(body.deviceId, 64, "device_id");
        if (deviceId !== auth.deviceId) fail(403, "device_mismatch");
        const timestamp = now();
        const clearedAt = body.clearedAt == null ? timestamp : finite(body.clearedAt, "cleared_at", 0, timestamp + 5 * 60 * 1000);
        const result = await evalScript(CLEAR_WATCH_LUA, [profileKey(auth.profileId)], [mutationId, auth.deviceId, clearedAt, timestamp, PROFILE_MAX_BYTES, auth.bearerHash, PROFILE_TTL_SECONDS]);
        const cleared = parseProfile(result[0]);
        return send(res, 200, { ok: true, revision: cleared.revision, snapshot: publicSnapshot(cleared, now()) });
      }
      if (req.method === "POST" && op === "pair/create") {
        const deviceName = body.deviceName == null ? "Device" : boundedString(body.deviceName, 60, "device_name");
        const requestToken = crypto.randomBytes(32).toString("base64url");
        const tokenHash = sha(requestToken);
        const shortCode = randomCode();
        const expiresAt = now() + PAIR_TTL_SECONDS * 1000;
        const pair = { profileId: auth.profileId, tokenHash, deviceName, createdAt: now(), expiresAt };
        await evalScript(PAIR_CREATE_LUA, [profileKey(auth.profileId), pairCodeKey(shortCode), pairTokenKey(tokenHash)], [JSON.stringify(pair), PAIR_TTL_SECONDS, JSON.stringify({ profileId: auth.profileId, tokenHash }), auth.deviceId, auth.bearerHash]);
        return send(res, 201, { requestToken, shortCode, expiresAt });
      }
      if (req.method === "POST" && op === "pair/approve") {
        const requestId = id(body.requestId, "request_id");
        const requestRaw = await redis(["GET", pairRequestKey(requestId)]);
        if (!requestRaw) fail(410, "pairing_expired");
        let request;
        try { request = JSON.parse(requestRaw); } catch { fail(410, "pairing_expired"); }
        if (request.profileId !== auth.profileId) fail(404, "pairing_request_not_found");
        await evalScript(PAIR_APPROVE_LUA, [profileKey(auth.profileId), pairRequestKey(requestId)], [requestId, now(), PAIR_TTL_SECONDS, PROFILE_TTL_SECONDS, auth.deviceId, auth.bearerHash]);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && op === "revoke") {
        const deviceId = boundedString(body.deviceId, 64, "device_id");
        const target = auth.profile.devices?.[deviceId];
        if (!target || !target.active) fail(404, "device_not_found");
        const raw = await evalScript(REVOKE_LUA, [profileKey(auth.profileId)], [deviceId, auth.deviceId, credentialKey(target.credentialHash), now(), PROFILE_TTL_SECONDS, auth.bearerHash]);
        return send(res, 200, { ok: true, snapshot: publicSnapshot(parseProfile(raw), now()) });
      }
      fail(405, "method_not_allowed");
    } catch (error) {
      const status = error instanceof ProfileError ? error.status : 500;
      const code = error instanceof ProfileError ? error.code : "profile_request_failed";
      return send(res, status, { error: code });
    }
  };
}

export default createProfileHandler();
