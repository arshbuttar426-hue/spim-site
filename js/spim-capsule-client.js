/*
 * SPIM shared capsule client (C3 extraction).
 *
 * Single implementation of the capsule-client primitives shared by the studio
 * page (index.html) and the receiver page (receive.html):
 *   - base64 encode/decode: bytes, UTF-8 text, URL-safe (private keys)
 *   - BLAKE3 hashing through the WASM engine
 *   - CAP1 envelope construction (text / image)
 *   - AES-GCM envelope encrypt/decrypt (private capsules)
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
async function spimEncryptEnvelope(j,k){
  const iv = new Uint8Array(12); crypto.getRandomValues(iv);
  const key = await crypto.subtle.importKey('raw', k, {name:'AES-GCM'}, false, ['encrypt']);
  const enc = await crypto.subtle.encrypt({name:'AES-GCM',iv:iv}, key, new TextEncoder().encode(j));
  const c = new Uint8Array(iv.length + enc.byteLength);
  c.set(iv,0); c.set(new Uint8Array(enc), iv.length);
  return spimB64EncodeBytes(c);
}
async function spimDecryptEnvelope(b64, keyBytes){
  const combined=spimB64DecodeBytes(b64);
  const iv=combined.slice(0,12);
  const ct=combined.slice(12);
  const key=await crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM'},false,['decrypt']);
  const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,ct);
  return new TextDecoder().decode(dec);
}
async function spimPostCapsule(blob, destroyable){
  const r = await fetch('/capsules', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({blob:blob, destroyable:!!destroyable})});
  if(!r.ok) throw new Error('POST ' + r.status);
  return (await r.json()).id;
}

/* Resolve the note list from an envelope. Legacy capsules carry raw notes[];
 * zero-redundancy capsules store only spim_b64 (+ optional fmt_b64 delta) and
 * reconstruct the notes. When a fmt delta is present, apply it to recover the
 * sender's exact bytes (case, newlines, indentation, multiple spaces).
 * strict=true (receiver): throw on reconstruction failure; strict=false
 * (catch/display): skip unresolvable notes instead of failing the open. */
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
    if(n.blake3 && window.blake3_hex_static(n.source)!==n.blake3) ok=false;
    const id=w.remember(n.source);
    if(!w.verify_reconstruct(id, n.source)) ok=false;
  });
  return ok;
}

function spimVerifyImage(img){
  if(!img.source_bytes_b64 || !img.source_blake3) throw new Error('blake3 mismatch');
  // blake3_bytes_hex expects base64 of bytes
  let calc;
  try {
    const tmp=new window.WasmSpim();
    calc=tmp.blake3_bytes_hex(img.source_bytes_b64);
    tmp.free();
  }catch(e){ calc=''; }
  if(calc && calc!==img.source_blake3) throw new Error('blake3 mismatch');
}
