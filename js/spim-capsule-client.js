/*
 * SPIM shared capsule client (C3 extraction).
 *
 * Single implementation of the capsule-client primitives shared by the studio
 * page (index.html) and the receiver page (receive.html):
 *   - base64 encode/decode: bytes, UTF-8 text, URL-safe (private keys)
 *   - BLAKE3 hashing through the WASM engine
 *   - CAP1 envelope construction (text / image, legacy integrity only)
 *   - CAP2 sealing: ECDSA P-256 signature + content-address id (authenticity)
 *   - AES-GCM envelope encrypt/decrypt (private capsules; CAP2 binds AAD to id)
 *   - capsule delivery (POST /capsules)
 *   - envelope note resolution + verification (receiver side)
 *
 * Loaded as a classic script. Depends on the page-level WASM globals
 * (window.WasmSpim, window.blake3_hex_static, window.format_delta_encode,
 * window.format_delta_apply) and the readiness state (window.wasmReady /
 * window.wasmInitPromise) installed by each page's /pkg/spim_wasm.js module.
 * Top-level function declarations here become window globals, so inline
 * handlers and cross-script calls keep working.
 *
 * Page-specific orchestration (UI state, rendering, flows) stays in the pages.
 */

function spimB64EncodeBytes(b){ let s=''; b.forEach(v=>s+=String.fromCharCode(v)); return btoa(s); }
function spimB64DecodeBytes(b){ const s=atob(b); const o=new Uint8Array(s.length); for(let i=0;i<s.length;i++) o[i]=s.charCodeAt(i); return o; }
function spimB64EncodeStr(s){ return btoa(unescape(encodeURIComponent(s))); }
function spimB64DecodeStr(s){ return decodeURIComponent(escape(atob(s))); }
function spimB64UrlEncode(b){ let s=spimB64EncodeBytes(b); return s.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function spimB64UrlDecode(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='='; return spimB64DecodeBytes(s); }
function spimRandomHex(bytes){
  const b=new Uint8Array(bytes); crypto.getRandomValues(b);
  return Array.from(b).map(function(x){ return x.toString(16).padStart(2,'0'); }).join('');
}

/* ---- CAP2 authenticity primitives ----------------------------------------
 * CAP1's BLAKE3 fields are unkeyed: anyone can edit content and recompute them.
 * CAP2 adds a real signature (WebCrypto ECDSA P-256 / SHA-256) plus a SHA-256
 * content address that is delivered out-of-band in the link. The id commits to
 * the signed envelope, and the signature commits to the content, so a blob
 * cannot be swapped or edited without breaking the link's id. The key pair is
 * ephemeral and per capsule; only its public half travels inside the envelope.
 */
const SPIM_CAP2_ALG = 'ECDSA-P256-SHA256';

/* Deterministic serialization for signing and content addressing. Object keys
 * are sorted at every level; array order is preserved. CAP1 hashes keep the
 * original insertion-order JSON.stringify so legacy envelopes stay verifiable. */
function spimCanonicalJson(value){
  function norm(v){
    if(Array.isArray(v)) return v.map(norm);
    if(v && typeof v==='object'){
      const out={};
      Object.keys(v).sort().forEach(function(k){ out[k]=norm(v[k]); });
      return out;
    }
    return v;
  }
  return JSON.stringify(norm(value));
}

/* Everything except the signature bytes is signed, including the public key. */
function spimCap2SigningJson(env){
  const auth=Object.assign({}, env.auth||{}, {signature_b64:''});
  return spimCanonicalJson(Object.assign({}, env, {auth:auth}));
}
/* The legacy-looking blake3 field is retained for tooling, but in CAP2 it is
 * also covered by the signature. Signature bytes are blanked while hashing. */
function spimCap2HashJson(env){
  const auth=Object.assign({}, env.auth||{}, {signature_b64:''});
  return spimCanonicalJson(Object.assign({}, env, {blake3:'', auth:auth}));
}
async function spimCapsuleId(jsonStr){
  const d=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jsonStr));
  return Array.from(new Uint8Array(d)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('').slice(0,16);
}
async function spimSealCap2(env){
  if(!env || env.magic!=='CAP2') throw new Error('bad magic');
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const spki=new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  env.auth={alg:SPIM_CAP2_ALG, public_key_spki_b64:spimB64EncodeBytes(spki), signature_b64:''};
  env.blake3=spimBlake3Hex(spimCap2HashJson(env));
  const sig=new Uint8Array(await crypto.subtle.sign(
    {name:'ECDSA',hash:'SHA-256'}, keys.privateKey,
    new TextEncoder().encode(spimCap2SigningJson(env))
  ));
  env.auth.signature_b64=spimB64EncodeBytes(sig);
  return env;
}

function spimBlake3Hex(s){ if(window.wasmReady && window.blake3_hex_static) try { return window.blake3_hex_static(s); } catch(e){} return 'pending'; }
function spimBlake3BytesHex(b64){
  try {
    if(window.wasmReady && window.WasmSpim){
      const w = new window.WasmSpim();
      const h = w.blake3_bytes_hex(b64);
      w.free();
      return h;
    }
  } catch(e){}
  return spimBlake3Hex(b64);
}

function spimMakeTextEnvelope(notes){
  const w = new window.WasmSpim(), notes_blake3 = [], fmt_b64 = [];
  notes.forEach(function(s){
    w.remember(s);
    notes_blake3.push(spimBlake3Hex(s));
    fmt_b64.push(window.format_delta_encode(s));
  });
  const b = w.encoded_bytes_b64();
  w.free();
  const wc = notes.reduce(function(a,s){ return a + s.split(/\s+/).filter(Boolean).length; }, 0);
  const env = {magic:"CAP1",product_version:1,spim_version:1,tokenization_version:1,flags:0,created_at:new Date().toISOString(),spim_b64:b,notes_blake3:notes_blake3,fmt_b64:fmt_b64,word_count:wc,blake3:""};
  env.blake3 = spimBlake3Hex(JSON.stringify(Object.assign({}, env, {blake3:""})));
  return env;
}

function spimMakeImageEnvelope(bytes, mime, name){
  if(!bytes) throw new Error('Choose an image first.');
  if(!window.wasmReady) throw new Error('Engine is still loading.');
  const b64 = spimB64EncodeBytes(bytes);
  const blake = spimBlake3BytesHex(b64);
  const imageEntry = {kind:"image", source_bytes_b64:b64, mime:mime, filename:name, source_blake3:blake};
  const w = new window.WasmSpim();
  const spim_b64 = w.encoded_bytes_b64();
  w.free();
  const env = {magic:"CAP1",product_version:1,spim_version:1,tokenization_version:1,flags:0,created_at:new Date().toISOString(),notes:[],images:[imageEntry],spim_b64:spim_b64,word_count:0,blake3:""};
  env.blake3 = spimBlake3Hex(JSON.stringify(Object.assign({}, env, {blake3:""})));
  return env;
}

async function spimGenerateKey(){ const b = new Uint8Array(32); crypto.getRandomValues(b); return b; }
async function spimEncryptEnvelope(j,k,aad){
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);
  const key = await crypto.subtle.importKey('raw', k, {name:'AES-GCM'}, false, ['encrypt']);
  const params={name:'AES-GCM',iv:iv};
  // CAP2 binds the ciphertext to its content address. Without AAD a stored
  // blob could be swapped between capsules that share the same client key.
  if(aad) params.additionalData=new TextEncoder().encode(aad);
  const enc = await crypto.subtle.encrypt(params, key, new TextEncoder().encode(j));
  const c = new Uint8Array(iv.length + enc.byteLength);
  c.set(iv,0); c.set(new Uint8Array(enc), iv.length);
  return spimB64EncodeBytes(c);
}
async function spimDecryptEnvelope(b64, keyBytes, aad){
  const combined=spimB64DecodeBytes(b64);
  const iv=combined.slice(0,12);
  const ct=combined.slice(12);
  const key=await crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM'},false,['decrypt']);
  const params={name:'AES-GCM',iv:iv};
  if(aad) params.additionalData=new TextEncoder().encode(aad);
  const dec=await crypto.subtle.decrypt(params,key,ct);
  return new TextDecoder().decode(dec);
}
async function spimPostCapsule(blob, destroyable, id, version){
  const body={blob:blob, destroyable:!!destroyable};
  if(id) body.id=id;
  if(version) body.version=version;
  const r = await fetch('/capsules', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  if(!r.ok) throw new Error('POST ' + r.status);
  return (await r.json()).id;
}

/* Resolve the note list from an envelope. Legacy capsules carry raw notes[];
 * zero-redundancy capsules store only spim_b64 (+ optional fmt_b64 delta) and
 * reconstruct the notes. When a fmt delta is present, apply it to recover the
 * sender's exact bytes (case, newlines, indentation, multiple spaces).
 * strict=true (receiver and verified Catch): throw on reconstruction failure;
 * strict=false is retained for non-trusted callers but is never used to
 * produce a verified display. */
function spimReconstructNotes(env, strict){
  if(env.notes && env.notes.length) return env.notes.map(function(n){ return {source:spimB64DecodeStr(n.source_b64), blake3:n.source_blake3||null}; });
  if(env.spim_b64){
    const w = window.WasmSpim.from_encoded_bytes_b64(env.spim_b64);
    if(strict && !w) throw new Error('bad spim');
    const out=[]; const n=w.num_memories();
    for(let i=0;i<n;i++){
      const norm=w.reconstruct(i);
      if(norm==null){ if(strict){ w.free(); throw new Error('reconstruct failed'); } continue; }
      const fmt=(env.fmt_b64 && env.fmt_b64[i])||null;
      const source=fmt?(window.format_delta_apply(norm,fmt)??norm):norm;
      out.push({source: source, blake3:(env.notes_blake3&&env.notes_blake3[i])||null});
    }
    w.free();
    return out;
  }
  return [];
}
function spimResolveNotes(env){ return spimReconstructNotes(env, true); }
function spimResolveCatchNotes(env){ return spimReconstructNotes(env, false); }

function spimVerifyNotes(notes){
  const w=new window.WasmSpim(); let ok=true;
  notes.forEach(n=>{
    /* Missing per-note integrity metadata is a failure, not a skip. The
     * envelope hash is unkeyed, so an attacker can recompute it after
     * stripping hashes; only per-note/per-image hashes carry trust. */
    if(!n.blake3 || window.blake3_hex_static(n.source)!==n.blake3) ok=false;
    const id=w.remember(n.source);
    if(!w.verify_reconstruct(id, n.source)) ok=false;
  });
  return ok;
}

function spimVerifyImage(img){
  if(!img.source_bytes_b64 || !img.source_blake3) throw new Error('blake3 mismatch');
  // blake3_bytes_hex expects base64 of bytes. A hashing failure is a
  // verification failure, never a silent skip.
  let calc;
  try {
    const tmp=new window.WasmSpim();
    calc=tmp.blake3_bytes_hex(img.source_bytes_b64);
    tmp.free();
  }catch(e){ throw new Error('blake3 mismatch'); }
  if(calc!==img.source_blake3) throw new Error('blake3 mismatch');
}

/* Canonical envelope verification (synchronous structure + integrity).
 *
 * Steps common to both versions: envelope hash, strict note reconstruction,
 * per-note BLAKE3 + SPIM reconstruction, and per-image BLAKE3. CAP1 stops here
 * and is reported as integrity-only: its hashes are unkeyed and MUST NOT be
 * described as cryptographic authenticity. CAP2 additionally requires well-
 * formed authenticity metadata here; the signature itself is checked by the
 * async spimAuthenticateEnvelope() below, using WebCrypto.
 *
 * Throws on any failure. Missing hashes/metadata are failures, not skips.
 */
function spimVerifyEnvelope(jsonStr){
  const env = JSON.parse(jsonStr);
  if(!env || typeof env!=='object') throw new Error('bad magic');
  const cap2 = env.magic === 'CAP2';
  if(env.magic !== 'CAP1' && !cap2) throw new Error('bad magic');
  const stored = env.blake3;
  if(typeof stored !== 'string' || !/^[0-9a-f]{64}$/i.test(stored)) throw new Error('blake3 mismatch');
  const comp = cap2
    ? spimBlake3Hex(spimCap2HashJson(env))
    : spimBlake3Hex(JSON.stringify(Object.assign({}, env, {blake3:''})));
  if(!comp || comp === 'pending' || comp !== stored) throw new Error('blake3 mismatch');
  if(cap2){
    const auth=env.auth;
    if(!auth || typeof auth!=='object') throw new Error('auth missing');
    if(auth.alg!==SPIM_CAP2_ALG) throw new Error('auth algorithm unsupported');
    if(typeof auth.public_key_spki_b64!=='string' || !/^[A-Za-z0-9+/=]+$/.test(auth.public_key_spki_b64)) throw new Error('bad key');
    if(typeof auth.signature_b64!=='string' || !/^[A-Za-z0-9+/=]+$/.test(auth.signature_b64)) throw new Error('bad signature');
    let sigBytes;
    try{ sigBytes=spimB64DecodeBytes(auth.signature_b64); }catch(e){ throw new Error('bad signature'); }
    if(sigBytes.length!==64) throw new Error('bad signature');
  }
  const notes = spimResolveNotes(env);
  if(notes.length && !spimVerifyNotes(notes)) throw new Error('blake3 mismatch');
  if(env.images && env.images.length){
    for(const img of env.images) spimVerifyImage(img);
  }
  return {
    env: Object.assign({}, env, {notes: notes}),
    notes: notes,
    blake3: comp,
    version: cap2 ? 2 : 1,
    trust: cap2 ? 'auth-pending' : 'integrity'
  };
}

/* Full authenticity check. Must be awaited by every trusted-display path.
 *
 * CAP2: verifies the embedded ECDSA signature over the canonical envelope and
 * binds the result to the id carried by the link/.spim file. Without expectedId
 * a CAP2 envelope cannot be authenticated and is rejected (fail closed).
 * CAP1: remains usable as integrity-only; no authenticity is claimed.
 */
async function spimAuthenticateEnvelope(jsonStr, expectedId, aadState){
  const verified = spimVerifyEnvelope(jsonStr);
  if(verified.version===1){
    // A 16-hex id is a CAP2 content address, and true AAD means the bytes came
    // from a CAP2 private capsule. Neither may be satisfied by a CAP1 body;
    // accepting either would let a CAP2 link be downgraded to unkeyed hashes.
    const cap2Address = typeof expectedId==='string' && /^[0-9a-f]{16}$/i.test(expectedId);
    if(cap2Address) throw new Error('CAP1 cannot use a CAP2 content address');
    if(aadState===true) throw new Error('CAP1 cannot use CAP2 binding');
    return Object.assign({}, verified, {trust:'integrity'});
  }
  // Reparse so signature verification uses the envelope exactly as serialized;
  // spimVerifyEnvelope returns a copy with resolved notes attached.
  const original = JSON.parse(jsonStr);
  const auth = original.auth;
  let key, sig, ok;
  try{
    key = await crypto.subtle.importKey('spki', spimB64DecodeBytes(auth.public_key_spki_b64),
      {name:'ECDSA',namedCurve:'P-256'}, false, ['verify']);
    sig = spimB64DecodeBytes(auth.signature_b64);
    ok = await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'}, key, sig,
      new TextEncoder().encode(spimCap2SigningJson(original)));
  }catch(e){ throw new Error('signature mismatch'); }
  if(!ok) throw new Error('signature mismatch');
  const id = await spimCapsuleId(spimCanonicalJson(original));
  if(typeof expectedId!=='string' || !/^[0-9a-f]{16}$/i.test(expectedId)) throw new Error('bad capsule id');
  if(id.toLowerCase()!==expectedId.toLowerCase()) throw new Error('capsule id mismatch');
  // A CAP2 private capsule must have been decrypted with AAD bound to its id.
  if(aadState===false) throw new Error('verification failed: CAP2 binding missing');
  return Object.assign({}, verified, {trust:'authentic', id:id});
}
