export class WasmIdentity {
    static __wrap(ptr) {
        const obj = Object.create(WasmIdentity.prototype);
        obj.__wbg_ptr = ptr;
        WasmIdentityFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmIdentityFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmidentity_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    ed_pub_b64() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmidentity_ed_pub_b64(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    fingerprint() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmidentity_fingerprint(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {string} s
     * @returns {WasmIdentity}
     */
    static from_secret_json(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmidentity_from_secret_json(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmIdentity.__wrap(ret[0]);
    }
    /**
     * @returns {string}
     */
    id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmidentity_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    constructor() {
        const ret = wasm.wasmidentity_new();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WasmIdentityFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Explicit secret export. The client must seal this before persisting it.
     * @returns {string}
     */
    to_secret_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmidentity_to_secret_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    x_pub_b64() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmidentity_x_pub_b64(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) WasmIdentity.prototype[Symbol.dispose] = WasmIdentity.prototype.free;

/**
 * Private prekey material. `seam_generate_prekeys` returns the matching signed
 * bundles for the relay.
 */
export class WasmPreKeyStore {
    static __wrap(ptr) {
        const obj = Object.create(WasmPreKeyStore.prototype);
        obj.__wbg_ptr = ptr;
        WasmPreKeyStoreFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmPreKeyStoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmprekeystore_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    expires_at() {
        const ret = wasm.wasmprekeystore_expires_at(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    remaining() {
        const ret = wasm.wasmprekeystore_remaining(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Mint more one-time prekeys. Returns a JSON array of signed bundles.
     * @param {WasmIdentity} identity
     * @param {number} count
     * @param {number} now
     * @param {number} ttl
     * @returns {string}
     */
    replenish(identity, count, now, ttl) {
        let deferred2_0;
        let deferred2_1;
        try {
            _assertClass(identity, WasmIdentity);
            const ret = wasm.wasmprekeystore_replenish(this.__wbg_ptr, identity.__wbg_ptr, count, now, ttl);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} s
     * @returns {WasmPreKeyStore}
     */
    static restore(s) {
        const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmprekeystore_restore(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmPreKeyStore.__wrap(ret[0]);
    }
    /**
     * @returns {string}
     */
    snapshot() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmprekeystore_snapshot(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    spk_pub_b64() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmprekeystore_spk_pub_b64(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) WasmPreKeyStore.prototype[Symbol.dispose] = WasmPreKeyStore.prototype.free;

/**
 * A live ratchet. The first `encrypt` carries the handshake.
 */
export class WasmSession {
    static __wrap(ptr) {
        const obj = Object.create(WasmSession.prototype);
        obj.__wbg_ptr = ptr;
        WasmSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmsession_free(ptr, 0);
    }
    /**
     * @param {WasmIdentity} identity
     * @param {WasmPreKeyStore} store
     * @param {string} envelope_b64
     * @returns {WasmSession}
     */
    static accept(identity, store, envelope_b64) {
        _assertClass(identity, WasmIdentity);
        _assertClass(store, WasmPreKeyStore);
        const ptr0 = passStringToWasm0(envelope_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmsession_accept(identity.__wbg_ptr, store.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmSession.__wrap(ret[0]);
    }
    /**
     * Decrypt one base64 `SMW1` frame.
     * @param {string} envelope_b64
     * @returns {string}
     */
    decrypt(envelope_b64) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(envelope_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmsession_decrypt(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Encrypt one message. Returns the base64 `SMW1` frame.
     * @param {string} body
     * @param {number} at
     * @returns {string}
     */
    encrypt(body, at) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(body, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmsession_encrypt(this.__wbg_ptr, ptr0, len0, at);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The body carried by the first capsule, for `accept`.
     * @returns {string | undefined}
     */
    first_body() {
        const ret = wasm.wasmsession_first_body(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @param {WasmIdentity} identity
     * @param {string} bundle_json
     * @param {number} now
     * @returns {WasmSession}
     */
    static initiate(identity, bundle_json, now) {
        _assertClass(identity, WasmIdentity);
        const ptr0 = passStringToWasm0(bundle_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmsession_initiate(identity.__wbg_ptr, ptr0, len0, now);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmSession.__wrap(ret[0]);
    }
    /**
     * @param {number} at
     * @returns {string}
     */
    mailbox(at) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.wasmsession_mailbox(this.__wbg_ptr, at);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    me_id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmsession_me_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    peer_id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmsession_peer_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} at
     * @returns {string}
     */
    rendezvous(at) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.wasmsession_rendezvous(this.__wbg_ptr, at);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {WasmIdentity} identity
     * @param {string} snapshot
     * @returns {WasmSession}
     */
    static restore(identity, snapshot) {
        _assertClass(identity, WasmIdentity);
        const ptr0 = passStringToWasm0(snapshot, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmsession_restore(identity.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WasmSession.__wrap(ret[0]);
    }
    /**
     * Plaintext ratchet snapshot. Seal it with `seam_seal` before storing.
     * @returns {string}
     */
    snapshot() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmsession_snapshot(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) WasmSession.prototype[Symbol.dispose] = WasmSession.prototype.free;

export class WasmSpim {
    static __wrap(ptr) {
        const obj = Object.create(WasmSpim.prototype);
        obj.__wbg_ptr = ptr;
        WasmSpimFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmSpimFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmspim_free(ptr, 0);
    }
    /**
     * BM25-ranked relevance (`k1=1.5`, `b=0.75`). Returns a JSON array of
     * `{"id": <u32>, "score": <f64>}` sorted by descending score.
     * @param {string} query
     * @returns {string}
     */
    ask_ranked(query) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(query, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmspim_ask_ranked(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * BLAKE3 of the base64-decoded bytes of `b64`, lowercase hex.
     * Invalid base64 degrades to the hash of empty bytes (never panics).
     * @param {string} b64
     * @returns {string}
     */
    blake3_bytes_hex(b64) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmspim_blake3_bytes_hex(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * BLAKE3 of the UTF-8 bytes of `data`, lowercase hex.
     * @param {string} data
     * @returns {string}
     */
    blake3_hex(data) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(data, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmspim_blake3_hex(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Base64 of the compact positional encoding (Golomb-Rice postings).
     * @returns {string}
     */
    encoded_bytes_b64() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmspim_encoded_bytes_b64(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Rebuild an engine from the base64 produced by `encoded_bytes_b64`.
     * Round-trips exactly (vocab, postings, mem_lengths). Returns `null` if the
     * base64 or the encoding is invalid. Enables zero-redundancy envelopes:
     * `receive.html` reconstructs notes purely from `spim_b64` with no raw
     * `notes[]` copy.
     * @param {string} b64
     * @returns {WasmSpim | undefined}
     */
    static from_encoded_bytes_b64(b64) {
        const ptr0 = passStringToWasm0(b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmspim_from_encoded_bytes_b64(ptr0, len0);
        return ret === 0 ? undefined : WasmSpim.__wrap(ret);
    }
    constructor() {
        const ret = wasm.wasmspim_new();
        this.__wbg_ptr = ret;
        WasmSpimFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    num_memories() {
        const ret = wasm.wasmspim_num_memories(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Phrase search. Returns a JSON array of `[memory_id, [start_positions]]`.
     * @param {string} query
     * @returns {string}
     */
    phrase_positions(query) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(query, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmspim_phrase_positions(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Exact contiguous phrase recall. Returns a JSON array of matching memory ids
     * (the candidate-locking C3 matcher result), e.g. `[1]` or `[]`.
     * @param {string} query
     * @returns {string}
     */
    recall_exact(query) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(query, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmspim_recall_exact(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Reconstruct one memory from its positional data (lossless, space-joined).
     * @param {number} id
     * @returns {string | undefined}
     */
    reconstruct(id) {
        const ret = wasm.wasmspim_reconstruct(this.__wbg_ptr, id);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Insert a memory's normalized token sequence. Returns the 0-based memory id.
     * @param {string} text
     * @returns {number}
     */
    remember(text) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmspim_remember(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * The normalized token sequence of one memory as a JSON array of strings,
     * or the literal `null` when the id is out of range.
     * @param {number} id
     * @returns {string}
     */
    tokens_of(id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmspim_tokens_of(this.__wbg_ptr, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Does `reconstruct(id)` equal the normalized `original`?
     * @param {number} id
     * @param {string} original
     * @returns {boolean}
     */
    verify_reconstruct(id, original) {
        const ptr0 = passStringToWasm0(original, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmspim_verify_reconstruct(this.__wbg_ptr, id, ptr0, len0);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    vocab_size() {
        const ret = wasm.wasmspim_vocab_size(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) WasmSpim.prototype[Symbol.dispose] = WasmSpim.prototype.free;

/**
 * Free-function BLAKE3 (no instance needed) — used at compose time before the
 * envelope exists, matching the live site's `blake3_hex_static` export.
 * @param {string} data
 * @returns {string}
 */
export function blake3_hex_static(data) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(data, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.blake3_hex_static(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Apply a base64 format delta (from `format_delta_encode`) to a normalized
 * string (== `reconstruct(id)`), returning the exact original. Returns `null`
 * if the delta is invalid or the token counts mismatch.
 * @param {string} norm
 * @param {string} delta_b64
 * @returns {string | undefined}
 */
export function format_delta_apply(norm, delta_b64) {
    const ptr0 = passStringToWasm0(norm, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(delta_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.format_delta_apply(ptr0, len0, ptr1, len1);
    let v3;
    if (ret[0] !== 0) {
        v3 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v3;
}

/**
 * Encode the case/whitespace format delta for raw text, base64. Together with
 * `reconstruct(id)` (the normalized stream), this restores the sender's exact
 * bytes — uppercase runs, newlines, tabs, indentation, multiple spaces.
 * @param {string} orig
 * @returns {string}
 */
export function format_delta_encode(orig) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(orig, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.format_delta_encode(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @param {string} bundle_json
 * @param {number} at
 * @returns {string}
 */
export function seam_bundle_mailbox(bundle_json, at) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(bundle_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.seam_bundle_mailbox(ptr0, len0, at);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {string} master_b64
 * @param {string} salt_b64
 * @param {string} info
 * @returns {string}
 */
export function seam_derive_device_key(master_b64, salt_b64, info) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(master_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(salt_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(info, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.seam_derive_device_key(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Create a signed prekey store and the bundles to publish.
 *
 * Returns `{ "store": <snapshot>, "bundles": [<bundle>, ...] }`. The client
 * keeps `store` sealed and publishes `bundles`; each bundle carries exactly one
 * one-time prekey.
 * @param {WasmIdentity} identity
 * @param {number} opk_count
 * @param {number} now
 * @param {number} ttl
 * @returns {string}
 */
export function seam_generate_prekeys(identity, opk_count, now, ttl) {
    let deferred2_0;
    let deferred2_1;
    try {
        _assertClass(identity, WasmIdentity);
        const ret = wasm.seam_generate_prekeys(identity.__wbg_ptr, opk_count, now, ttl);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * @param {string} x_pub_b64
 * @param {number} at
 * @returns {string}
 */
export function seam_mailbox(x_pub_b64, at) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(x_pub_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.seam_mailbox(ptr0, len0, at);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {string} device_key_b64
 * @param {string} aad
 * @param {string} sealed_b64
 * @returns {string}
 */
export function seam_open(device_key_b64, aad, sealed_b64) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(device_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(aad, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(sealed_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.seam_open(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Read-only header peek. Returns JSON `{ peer_id, ik, at }` when the capsule
 * carries a signed X3DH init, or `undefined` otherwise. It never touches a
 * session, so the client can route a first capsule without trial decryption.
 * `ik` is the sender's public agreement key, from which their mailbox for
 * `at` can be derived — the init carries no secret.
 * @param {string} envelope_b64
 * @returns {string | undefined}
 */
export function seam_peek_init(envelope_b64) {
    const ptr0 = passStringToWasm0(envelope_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.seam_peek_init(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    let v2;
    if (ret[0] !== 0) {
        v2 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}

/**
 * @param {string} device_key_b64
 * @param {string} aad
 * @param {string} plaintext
 * @returns {string}
 */
export function seam_seal(device_key_b64, aad, plaintext) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(device_key_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(aad, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(plaintext, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.seam_seal(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * @returns {number}
 */
export function seam_version() {
    const ret = wasm.seam_version();
    return ret >>> 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_5e4570eb24ffa122: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a2790eb24c211ea0: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_e6f02f0ea5f20a32: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_6cff064c44e0d823: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_35dba3c747ad7521: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_36bd29c6848c2144: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_with_length_3ffc1c56427c525c: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_de8e0d9553586985: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_THIS_466428f93b4eaa76: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_c7aea38d4de089bc: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_42d4fae05e59267a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_e0db14a0eba6a812: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_a4cc58201c7359fd: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./spim_wasm_bg.js": import0,
    };
}

const WasmIdentityFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmidentity_free(ptr, 1));
const WasmPreKeyStoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmprekeystore_free(ptr, 1));
const WasmSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmsession_free(ptr, 1));
const WasmSpimFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmspim_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('spim_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
