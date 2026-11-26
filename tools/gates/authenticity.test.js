'use strict';
/*
 * F2: CAP1's BLAKE3 fields are unkeyed, so a forger can edit content and
 * recompute every hash. These tests execute the shipped client primitives with
 * real WebCrypto to prove that CAP2 rejects such forgeries, while CAP1 remains
 * honestly labelled integrity-only.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..', '..');
const clientSrc = fs.readFileSync(path.join(root, 'js', 'spim-capsule-client.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const receiveHtml = fs.readFileSync(path.join(root, 'receive.html'), 'utf8');
const capsulesSrc = fs.readFileSync(path.join(root, 'functions', 'capsules.js'), 'utf8');
const hash = (s) => nodeCrypto.createHash('sha256').update(String(s)).digest('hex');

function loadClient(){
  class FakeWasmSpim {
    constructor(){ this.mem=[]; }
    remember(s){ this.mem.push(s); return this.mem.length-1; }
    verify_reconstruct(id,s){ return this.mem[id]===s; }
    blake3_bytes_hex(b64){ return hash(b64); }
    free(){}
  }
  const ctx={
    window:{ wasmReady:true, blake3_hex_static:hash, WasmSpim:FakeWasmSpim, format_delta_apply:(n)=>n },
    btoa:(s)=>Buffer.from(s,'binary').toString('base64'),
    atob:(s)=>Buffer.from(s,'base64').toString('binary'),
    escape, unescape, TextEncoder, TextDecoder, Uint8Array,
    crypto:nodeCrypto.webcrypto, console
  };
  vm.createContext(ctx);
  vm.runInContext(clientSrc, ctx);
  return ctx;
}
const b64u8 = (s) => Buffer.from(s,'utf8').toString('base64');
const note = (ctx,text) => ({source_b64:b64u8(text), source_blake3:hash(text)});
function rehash(ctx,env){ env.blake3=ctx.window.blake3_hex_static(ctx.spimCap2HashJson(env)); return env; }

async function makeCap2(ctx, text='authentic payload alpha'){
  const env={
    magic:'CAP2', product_version:1, spim_version:1, tokenization_version:1,
    flags:0, created_at:'2026-11-25T00:00:00.000Z',
    notes:[note(ctx,text)], images:[], spim_b64:'', word_count:3, blake3:''
  };
  await ctx.spimSealCap2(env);
  const json=ctx.spimCanonicalJson(env);
  return {env, json, id:await ctx.spimCapsuleId(json)};
}
function makeCap1(ctx, text='legacy integrity payload'){
  const env={
    magic:'CAP1', product_version:1, spim_version:1, tokenization_version:1,
    flags:0, created_at:'2026-11-25T00:00:00.000Z',
    notes:[note(ctx,text)], images:[], spim_b64:'', word_count:3, blake3:''
  };
  env.blake3=hash(JSON.stringify(Object.assign({},env,{blake3:''})));
  return env;
}
async function rejects(fn, pattern){
  await assert.rejects(fn, pattern);
}
async function withSite(fn){
  const mod = await import(pathToFileURL(path.join(root, 'tools', 'lib', 'local-site.mjs')).href);
  const site = await mod.startLocalSite({ host:'127.0.0.1', port:0 });
  try { return await fn(site, mod.assertLocal(site.base)); }
  finally { await site.close(); }
}
const postCapsule = (base, body) => fetch(base + '/capsules', {
  method:'POST', headers:{ origin:base, 'content-type':'application/json' },
  body:JSON.stringify(body)
});

test('valid CAP2 verifies as authentic and binds its id', async () => {
  const ctx=loadClient();
  const {json,id,env}=await makeCap2(ctx);
  assert.match(env.auth.public_key_spki_b64,/^[A-Za-z0-9+/=]+$/);
  const out=await ctx.spimAuthenticateEnvelope(json,id,null);
  assert.strictEqual(out.trust,'authentic');
  assert.strictEqual(out.version,2);
  assert.strictEqual(out.id,id);
  assert.strictEqual(out.notes[0].source,'authentic payload alpha');
});

test('canonical serialization is independent of key order', () => {
  const ctx=loadClient();
  assert.strictEqual(ctx.spimCanonicalJson({b:1,a:{d:2,c:3}}), ctx.spimCanonicalJson({a:{c:3,d:2},b:1}));
});

test('CAP2 id derivation is deterministic and canonicalization-stable', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  const reordered=Object.fromEntries(Object.entries(JSON.parse(json)).reverse());
  assert.strictEqual(ctx.spimCanonicalJson(reordered),json);
  assert.strictEqual(await ctx.spimCapsuleId(ctx.spimCanonicalJson(reordered)),id);
  assert.strictEqual(await ctx.spimCapsuleId(json),hash(json).slice(0,16));
});

test('CAP2 structural verification never returns authentic before signature verification', async () => {
  const ctx=loadClient();
  const {json}=await makeCap2(ctx);
  assert.strictEqual(ctx.spimVerifyEnvelope(json).trust,'auth-pending');
  const tampered=JSON.parse(json); tampered.word_count=999; rehash(ctx,tampered);
  const tamperedJson=ctx.spimCanonicalJson(tampered);
  // Recomputed hashes pass the structural stage but only earn auth-pending.
  assert.strictEqual(ctx.spimVerifyEnvelope(tamperedJson).trust,'auth-pending');
  const tamperedId=await ctx.spimCapsuleId(tamperedJson);
  await rejects(()=>ctx.spimAuthenticateEnvelope(tamperedJson,tamperedId,null),/signature mismatch/);
});

test('modified text with recomputed unkeyed hashes is rejected (signature fails)', async () => {
  const ctx=loadClient();
  const {env,id}=await makeCap2(ctx);
  env.notes[0].source_b64=b64u8('FORGED: transfer 1000 USD to Mallory');
  env.notes[0].source_blake3=hash('FORGED: transfer 1000 USD to Mallory');
  rehash(ctx,env);
  await rejects(()=>ctx.spimAuthenticateEnvelope(ctx.spimCanonicalJson(env),id,null), /signature mismatch/);
});

test('re-signed forgery is rejected because the link id changes', async () => {
  const ctx=loadClient();
  const {env,id}=await makeCap2(ctx);
  const forgedNote='FORGED: transfer 1000 USD to Mallory';
  env.notes[0].source_b64=b64u8(forgedNote);
  env.notes[0].source_blake3=hash(forgedNote);
  // An attacker with their own ephemeral key can re-sign and rehash everything.
  await ctx.spimSealCap2(env);
  const forgedJson=ctx.spimCanonicalJson(env);
  const forgedId=await ctx.spimCapsuleId(forgedJson);
  assert.notStrictEqual(forgedId,id);
  await rejects(()=>ctx.spimAuthenticateEnvelope(forgedJson,id,null), /capsule id mismatch/);
  // Without an external id, a CAP2 envelope cannot be authenticated at all.
  await rejects(()=>ctx.spimAuthenticateEnvelope(forgedJson,null,null), /bad capsule id/);
});

test('modified image and metadata with recomputed hashes are rejected', async () => {
  const ctx=loadClient();
  const {env,id}=await makeCap2(ctx);
  const bytes=Buffer.from('\x89PNG\r\n\x1a\nORIGINAL','binary').toString('base64');
  env.images.push({kind:'image',source_bytes_b64:bytes,mime:'image/png',filename:'a.png',source_blake3:hash(bytes)});
  await ctx.spimSealCap2(env);
  const sealedJson=ctx.spimCanonicalJson(env);
  const sealedId=await ctx.spimCapsuleId(sealedJson);
  assert.strictEqual((await ctx.spimAuthenticateEnvelope(sealedJson,sealedId,null)).trust,'authentic');
  const forgery=JSON.parse(sealedJson);
  const badBytes=Buffer.from('\x89PNG\r\n\x1a\nTAMPERED!!','binary').toString('base64');
  forgery.images[0].source_bytes_b64=badBytes;
  forgery.images[0].source_blake3=hash(badBytes);
  rehash(ctx,forgery);
  await rejects(()=>ctx.spimAuthenticateEnvelope(ctx.spimCanonicalJson(forgery),sealedId,null), /signature mismatch/);

  const meta=JSON.parse(sealedJson);
  meta.word_count=999;
  rehash(ctx,meta);
  await rejects(()=>ctx.spimAuthenticateEnvelope(ctx.spimCanonicalJson(meta),sealedId,null), /signature mismatch/);
});

test('missing, unknown or malformed authenticity metadata fails closed', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  const base=JSON.parse(json);

  const missing=JSON.parse(json); delete missing.auth; rehash(ctx,missing);
  assert.throws(()=>ctx.spimVerifyEnvelope(ctx.spimCanonicalJson(missing)), /auth missing/);

  const badAlg=JSON.parse(json); badAlg.auth.alg='HMAC-SHA256'; rehash(ctx,badAlg);
  assert.throws(()=>ctx.spimVerifyEnvelope(ctx.spimCanonicalJson(badAlg)), /auth algorithm unsupported/);

  const badSig=JSON.parse(json); badSig.auth.signature_b64='AAAA';
  assert.throws(()=>ctx.spimVerifyEnvelope(ctx.spimCanonicalJson(badSig)), /bad signature/);

  const malformedSig=JSON.parse(json); malformedSig.auth.signature_b64='!!!not-base64!!!';
  assert.throws(()=>ctx.spimVerifyEnvelope(ctx.spimCanonicalJson(malformedSig)), /bad signature/);

  const badKey=JSON.parse(json);
  badKey.auth.public_key_spki_b64=Buffer.from('not-a-spki','utf8').toString('base64');
  rehash(ctx,badKey);
  await rejects(()=>ctx.spimAuthenticateEnvelope(ctx.spimCanonicalJson(badKey),id,null), /signature mismatch/);

  const badMagic=JSON.parse(json); badMagic.magic='CAP3'; rehash(ctx,badMagic);
  assert.throws(()=>ctx.spimVerifyEnvelope(ctx.spimCanonicalJson(badMagic)), /bad magic/);
  assert.ok(base.auth.alg==='ECDSA-P256-SHA256');
});

test('CAP1 stays usable as integrity-only and is never labelled authentic', async () => {
  const ctx=loadClient();
  const text='legacy integrity payload';
  const env={
    magic:'CAP1', product_version:1, spim_version:1, tokenization_version:1,
    flags:0, created_at:'2026-11-25T00:00:00.000Z',
    notes:[note(ctx,text)], images:[], spim_b64:'', word_count:3, blake3:''
  };
  env.blake3=hash(JSON.stringify(Object.assign({},env,{blake3:''})));
  const out=await ctx.spimAuthenticateEnvelope(JSON.stringify(env),null,null);
  assert.strictEqual(out.trust,'integrity');
  assert.strictEqual(out.version,1);
});

test('CAP1 cannot inherit a CAP2 id or AAD state', async () => {
  const ctx=loadClient();
  const cap1=JSON.stringify(makeCap1(ctx));
  const cap2Id='a'.repeat(16);
  await rejects(()=>ctx.spimAuthenticateEnvelope(cap1,cap2Id,null), /CAP1 cannot use a CAP2 content address/);
  await rejects(()=>ctx.spimAuthenticateEnvelope(cap1,null,true), /CAP1 cannot use CAP2 binding/);
  // Legacy CAP1 links keep working only without a CAP2 id or binding claim.
  assert.strictEqual((await ctx.spimAuthenticateEnvelope(cap1,'Ab3x9Q',null)).trust,'integrity');
  assert.strictEqual((await ctx.spimAuthenticateEnvelope(cap1,null,false)).trust,'integrity');
});

test('CAP1 downgrade under a real CAP2 id is refused on the receiver path', async () => {
  const ctx=loadClient();
  const {id}=await makeCap2(ctx);
  const forged=JSON.stringify(makeCap1(ctx,'FORGED under the original CAP2 link'));
  await rejects(()=>ctx.spimAuthenticateEnvelope(forged,id,null), /CAP1 cannot use a CAP2 content address/);
  await rejects(()=>ctx.spimAuthenticateEnvelope(forged,id,false), /CAP1 cannot use a CAP2 content address/);
});

test('private CAP2 ciphertext is bound to its id with AES-GCM AAD', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  const key=await ctx.spimGenerateKey();
  const aad='SPIM-CAP2:'+id;
  const blob=await ctx.spimEncryptEnvelope(json,key,aad);
  const plain=await ctx.spimDecryptEnvelope(blob,key,aad);
  assert.strictEqual(plain,json);
  await rejects(()=>ctx.spimDecryptEnvelope(blob,key,'SPIM-CAP2:'+'0'.repeat(16)), /.*/);
  // A CAP2 envelope decrypted without AAD must be rejected even if bytes match.
  const noAad=await ctx.spimEncryptEnvelope(json,key);
  const noAadPlain=await ctx.spimDecryptEnvelope(noAad,key);
  await rejects(()=>ctx.spimAuthenticateEnvelope(noAadPlain,id,false), /CAP2 binding missing/);
  // Ciphertext swapped from a different capsule fails the AAD/decrypt check.
  const other=await ctx.spimEncryptEnvelope('{}',key,'SPIM-CAP2:'+'1'.repeat(16));
  await rejects(()=>ctx.spimDecryptEnvelope(other,key,aad), /.*/);
});

test('AES-GCM AAD is stable for the derived id and ciphertext mutation fails', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  const key=await ctx.spimGenerateKey();
  const aad='SPIM-CAP2:'+id;
  assert.strictEqual('SPIM-CAP2:'+(await ctx.spimCapsuleId(json)),aad);
  const blob=await ctx.spimEncryptEnvelope(json,key,aad);
  assert.strictEqual(await ctx.spimDecryptEnvelope(blob,key,aad),json);
  const ct=ctx.spimB64DecodeBytes(blob); ct[ct.length-1]^=1;
  await rejects(()=>ctx.spimDecryptEnvelope(ctx.spimB64EncodeBytes(ct),key,aad),/.*/);
  const iv=ctx.spimB64DecodeBytes(blob); iv[0]^=1;
  await rejects(()=>ctx.spimDecryptEnvelope(ctx.spimB64EncodeBytes(iv),key,aad),/.*/);
});

test('modified capsule id is rejected without changing the envelope', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  assert.notStrictEqual(id,'f'.repeat(16));
  await rejects(()=>ctx.spimAuthenticateEnvelope(json,'f'.repeat(16),null),/capsule id mismatch/);
  await rejects(()=>ctx.spimAuthenticateEnvelope(json,'0'.repeat(16),null),/capsule id mismatch/);
});

test('recomputed ids after tampering cannot rescue a forgery', async () => {
  const ctx=loadClient();
  const {env,id}=await makeCap2(ctx);
  const forged='recomputed id forgery';
  const tampered=JSON.parse(ctx.spimCanonicalJson(env));
  tampered.notes[0].source_b64=b64u8(forged);
  tampered.notes[0].source_blake3=hash(forged);
  rehash(ctx,tampered);
  const tamperedJson=ctx.spimCanonicalJson(tampered);
  const tamperedId=await ctx.spimCapsuleId(tamperedJson);
  assert.notStrictEqual(tamperedId,id);
  await rejects(()=>ctx.spimAuthenticateEnvelope(tamperedJson,tamperedId,null),/signature mismatch/);
  // A fresh key/signature makes a new authentic capsule, but not under the old id.
  await ctx.spimSealCap2(tampered);
  const resignedJson=ctx.spimCanonicalJson(tampered);
  const resignedId=await ctx.spimCapsuleId(resignedJson);
  assert.notStrictEqual(resignedId,id);
  await rejects(()=>ctx.spimAuthenticateEnvelope(resignedJson,id,null),/capsule id mismatch/);
  await rejects(()=>ctx.spimAuthenticateEnvelope(resignedJson,null,null),/bad capsule id/);
});

test('public/private mode crossing fails closed', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  const key=await ctx.spimGenerateKey();
  const privateBlob=await ctx.spimEncryptEnvelope(json,key,'SPIM-CAP2:'+id);
  // Presenting ciphertext as a public envelope yields unparsable JSON.
  assert.throws(()=>JSON.parse(ctx.spimB64DecodeStr(privateBlob)),/.*/);
  // Presenting a public plaintext envelope as a private blob fails AES-GCM.
  await rejects(()=>ctx.spimDecryptEnvelope(ctx.spimB64EncodeStr(json),key,'SPIM-CAP2:'+id),/.*/);
  assert.strictEqual(await ctx.spimDecryptEnvelope(privateBlob,key,'SPIM-CAP2:'+id),json);
});

test('noncanonical public bytes cannot be authenticated under a raw-byte id', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  const noncanonical=JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).reverse()));
  assert.notStrictEqual(noncanonical,json);
  // The server's publicContentId hashes stored bytes; the client hashes canonical bytes.
  const rawByteId=await ctx.spimCapsuleId(noncanonical);
  assert.notStrictEqual(rawByteId,id);
  await rejects(()=>ctx.spimAuthenticateEnvelope(noncanonical,rawByteId,null),/capsule id mismatch/);
  // Key order alone is semantically identical and still verifies under the canonical id.
  assert.strictEqual((await ctx.spimAuthenticateEnvelope(noncanonical,id,null)).trust,'authentic');
});

test('server refuses CAP1 downgrade, wrong ids and altered public blobs', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  const blob=Buffer.from(json,'utf8').toString('base64');
  const cap1Blob=Buffer.from(JSON.stringify(makeCap1(ctx)),'utf8').toString('base64');
  await withSite(async (site, base) => {
    assert.equal((await postCapsule(base,{blob, id, version:2})).status,201,'genuine CAP2 is accepted');
    assert.equal((await postCapsule(base,{blob:cap1Blob, id, version:1})).status,400,'CAP1 with a CAP2 id is refused');
    assert.equal((await postCapsule(base,{blob:cap1Blob, id})).status,400,'CAP1 downgrade cannot omit the version hint');
    assert.equal((await postCapsule(base,{blob, id:'b'.repeat(16), version:2})).status,400,'wrong id is refused');
    const altered=JSON.parse(json); altered.word_count=999;
    const alteredBlob=Buffer.from(JSON.stringify(altered),'utf8').toString('base64');
    assert.equal((await postCapsule(base,{blob:alteredBlob,id,version:2})).status,400,'altered envelope is refused');
    assert.equal((await postCapsule(base,{blob, id:'BADID!!'})).status,400);
  });
});

test('server rejects public and private id collisions atomically', async () => {
  const ctx=loadClient();
  const {json,id}=await makeCap2(ctx);
  const publicBlob=Buffer.from(json,'utf8').toString('base64');
  const key=await ctx.spimGenerateKey();
  const privateBlob=await ctx.spimEncryptEnvelope(json,key,'SPIM-CAP2:'+id);
  await withSite(async (site, base) => {
    assert.equal((await postCapsule(base,{blob:privateBlob,id,version:2,destroyable:false})).status,201);
    const original=await (await fetch(base+'/capsules/'+id)).json();
    assert.equal(original.blob,privateBlob,'original private blob is intact');
    const overwrite=await postCapsule(base,{blob:publicBlob,id,version:2,destroyable:false});
    assert.equal(overwrite.status,409,'a private capsule id cannot be overwritten');
    assert.equal((await (await fetch(base+'/capsules/'+id)).json()).blob,privateBlob);

    // Use a genuine second content address so the concurrent writers all pass
    // public-blob verification and only the D1 reservation decides the race.
    const race=await makeCap2(ctx,'concurrent collision payload');
    const raceBlob=Buffer.from(race.json,'utf8').toString('base64');
    const races=await Promise.all(Array.from({length:8},()=>postCapsule(base,{blob:raceBlob,id:race.id,version:2})));
    assert.equal(races.filter((r)=>r.status===201).length,1,'exactly one concurrent id wins');
    assert.equal(races.filter((r)=>r.status===409).length,7,'all other concurrent writers are refused');
    assert.equal(races.filter((r)=>r.status>=500).length,0);
    assert.equal((await (await fetch(base+'/capsules/'+race.id)).json()).blob,raceBlob,'the winning concurrent blob is intact');
  });
});

test('handler source keeps the atomic reservation and no embedded secrets', () => {
  assert.match(capsulesSrc, /INSERT INTO capsule_reservation/);
  assert.match(capsulesSrc, /ON CONFLICT\(id\) DO NOTHING/);
  assert.match(capsulesSrc, /publicContentId\(blob\)/);
  assert.match(capsulesSrc, /actual !== supplied/);
  assert.doesNotMatch(capsulesSrc, /private[_-]?key|signing[_-]?key|secret/i);
});

test('display paths use the async authenticator and avoid false authenticity claims', () => {
  assert.ok(indexHtml.includes('await spimAuthenticateEnvelope(jsonStr, expectedId, aadState)'));
  assert.ok(receiveHtml.includes('await spimAuthenticateEnvelope(jsonStr, expectedId, aadState)'));
  assert.ok(indexHtml.includes("'Signed · authentic CAP2'"));
  assert.ok(indexHtml.includes('trust === \'integrity\' ? \'integrity-only\''));
  assert.ok(indexHtml.includes('badge.classList.toggle(\'spim-pill--verified\', authentic)'));
  assert.ok(receiveHtml.includes('Integrity only · legacy CAP1'));
  assert.ok(!receiveHtml.includes('Verified · reconstructed'));
  assert.ok(!receiveHtml.includes('Verified · image'));
  // Beam/Catch transport remains unverified at the sound boundary.
  assert.ok(indexHtml.includes('showCaught(token, text, false, text)'));
});
