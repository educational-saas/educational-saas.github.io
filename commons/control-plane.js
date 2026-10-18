/**
 * control-plane.js
 * ----------------------------------------------------------------------------
 * Drop this one file into ANY data-plane HTML page (an individual
 * institution's own frontend) to fetch that institution's public registry
 * info — its own Supabase URL/anon key, display name, logos — from the
 * CENTRAL control-plane project, via the `get_institution_public_info` RPC.
 *
 * Design goals this file is built around:
 *   - FULLY INDEPENDENT: creates and owns its own Supabase client, scoped
 *     only to this module. It never touches, reads, or shares anything with
 *     whatever Supabase client the page itself creates for the institution's
 *     own project. No globals are leaked — everything is an ES module export.
 *   - FAST: every successful lookup is cached in localStorage, so repeat
 *     page loads (and repeat calls within the same session) resolve
 *     instantly without a network round trip. Concurrent calls for the same
 *     institution id are de-duplicated into a single in-flight request.
 *   - RELIABLE: read-only, anonymous (no auth/session state is created or
 *     persisted by this module's client), so there's nothing to expire or
 *     log out of. Cache reads/writes are wrapped in try/catch so a full or
 *     disabled localStorage degrades to "just fetch every time" instead of
 *     throwing.
 *
 * USAGE — this is an ES module, so it must be imported (a bare
 * <script type="module" src="control-plane.js"> on its own does not expose
 * globals; that isolation is intentional):
 *
 *   <script type="module">
 *     import {
 *       getInstitutionInfo, getInstitutionUrl, getInstitutionAnonKey,
 *       clearInstitutionCache
 *     } from './control-plane.js';
 *
 *     const institutionId = 45;
 *     const SUPABASE_URL = await getInstitutionUrl(institutionId);
 *     const SUPABASE_KEY = await getInstitutionAnonKey(institutionId);
 *     const info = await getInstitutionInfo(institutionId);
 *     const logo = info.logo_transparent_url || info.logo_url;
 *
 *     // ... now create THIS institution's own Supabase client with
 *     // SUPABASE_URL / SUPABASE_KEY, completely separately from this module.
 *
 *     // on logout:
 *     // clearInstitutionCache(institutionId);
 *   </script>
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

/* ============================================================================
   CONFIG — the control-plane ("Institution Registry") project's own public
   URL + anon key. These are safe to embed (same way any Supabase frontend
   embeds its anon key) because the only thing reachable with them from here
   is the narrow, whitelisted get_institution_public_info() RPC — real
   protection comes from that function's column allow-list and RLS on the
   control-plane side, not from hiding this key.
============================================================================ */
const CONTROL_PLANE_URL = 'https://xwagmgbucvsporjkpoqr.supabase.co';
const CONTROL_PLANE_ANON_KEY = 'sb_publishable_LHUDkZmuh53STL3HvbEanw_ebweG-FS';

/* Cache tuning ---------------------------------------------------------- */
const CACHE_PREFIX = 'cp_institution_';     // localStorage key prefix — namespaced so it can never collide with the data-plane page's own keys
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24h soft expiry; set to 0 to cache forever until explicitly cleared

/* ----------------------------------------------------------------------- */
/* Internal: this module's own, isolated Supabase client.                  */
/* ----------------------------------------------------------------------- */
let _client = null;
function client(){
  if (!_client){
    _client = createClient(CONTROL_PLANE_URL, CONTROL_PLANE_ANON_KEY, {
      auth: {
        persistSession: false,      // anonymous RPC calls only — no session to persist
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return _client;
}

const _pending = new Map(); // institution_id -> in-flight Promise, to de-dupe concurrent callers

function cacheKey(id){ return CACHE_PREFIX + String(id); }

function readCache(id){
  try {
    const raw = localStorage.getItem(cacheKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.data) return null;
    if (CACHE_TTL_MS && (Date.now() - parsed.cachedAt) > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null; // corrupt entry or storage unavailable — fetch fresh instead
  }
}

function writeCache(id, data){
  try {
    localStorage.setItem(cacheKey(id), JSON.stringify({ cachedAt: Date.now(), data }));
  } catch {
    // Storage full, disabled, or in a context (e.g. private mode) that
    // refuses writes — fail silently. The module still works, it just
    // re-fetches on the next call instead of reading from cache.
  }
}

async function fetchFromRegistry(id){
  const { data, error } = await client().rpc('get_institution_public_info', { p_institution_id: id });
  if (error) throw new Error('Could not reach the institution registry: ' + error.message);
  if (!data) throw new Error(`No active institution found for id ${id}.`);
  return data;
}

/* ============================================================================
   PUBLIC API
============================================================================ */

/**
 * Returns the public registry record for one institution:
 * { id, full_name, short_name, supabase_url, supabase_anon_key, logo_url, logo_transparent_url }
 * Served from localStorage when available and fresh; otherwise fetched once
 * (concurrent calls for the same id share a single network request) and cached.
 *
 * @param {number|string} institutionId
 * @param {{force?: boolean}} [opts] - pass { force: true } to bypass the cache and re-fetch.
 */
export async function getInstitutionInfo(institutionId, opts = {}){
  if (institutionId == null) throw new Error('getInstitutionInfo: institutionId is required.');
  const { force = false } = opts;

  if (!force){
    const cached = readCache(institutionId);
    if (cached) return cached;
  }

  if (_pending.has(institutionId)) return _pending.get(institutionId);

  const promise = (async () => {
    try {
      const data = await fetchFromRegistry(institutionId);
      writeCache(institutionId, data);
      return data;
    } finally {
      _pending.delete(institutionId);
    }
  })();

  _pending.set(institutionId, promise);
  return promise;
}

/** Convenience: just this institution's own Supabase project URL. */
export async function getInstitutionUrl(institutionId){
  return (await getInstitutionInfo(institutionId)).supabase_url;
}

/** Convenience: just this institution's own Supabase anon key. */
export async function getInstitutionAnonKey(institutionId){
  return (await getInstitutionInfo(institutionId)).supabase_anon_key;
}

/** Convenience: display name (full_name), falling back to short_name. */
export async function getInstitutionName(institutionId){
  const info = await getInstitutionInfo(institutionId);
  return info.full_name || info.short_name || '';
}

/** Convenience: best available logo (prefers the transparent variant). */
export async function getInstitutionLogo(institutionId){
  const info = await getInstitutionInfo(institutionId);
  return info.logo_transparent_url || info.logo_url || null;
}

/** Generic single-field accessor, e.g. getInstitutionField(45, 'short_name'). */
export async function getInstitutionField(institutionId, field){
  const info = await getInstitutionInfo(institutionId);
  return info[field];
}

/**
 * Forces a fresh fetch and refreshes the cache (shorthand for
 * getInstitutionInfo(id, { force: true })). Useful if you know the registry
 * record just changed (e.g. the admin updated the logo moments ago).
 */
export async function refreshInstitutionInfo(institutionId){
  return getInstitutionInfo(institutionId, { force: true });
}

/**
 * Wipes cached registry data from localStorage.
 * - clearInstitutionCache(45)  -> removes just institution 45's cached record.
 * - clearInstitutionCache()    -> removes every institution this module has
 *                                  ever cached on this device (handy to call
 *                                  on logout alongside clearing the data-plane
 *                                  page's own session/local state).
 */
export function clearInstitutionCache(institutionId){
  if (institutionId == null){
    for (let i = localStorage.length - 1; i >= 0; i--){
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
    }
    return;
  }
  localStorage.removeItem(cacheKey(institutionId));
}
