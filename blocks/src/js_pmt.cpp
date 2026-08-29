// Synchronous PMT bridge for the JavaScript Block. See docs/js-blocks.md.
#include "js_pmt.hpp"
#include "js_block.hpp"

#include <emscripten.h>

#include <algorithm>
#include <complex>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

thread_local std::vector<pmt::pmt_t> g_arena;
thread_local unsigned g_arena_depth = 0;
thread_local std::string g_last_error;

enum PmtKind {
    K_NIL = 0,
    K_BOOL = 1,
    K_SYMBOL = 2,
    K_LONG = 3,
    K_U64 = 4,
    K_REAL = 5,
    K_COMPLEX = 6,
    K_DICT = 7,
    K_PAIR = 8,
    K_VECTOR = 9,
    K_TUPLE = 10,
    K_U8 = 20,
    K_S8 = 21,
    K_U16 = 22,
    K_S16 = 23,
    K_U32 = 24,
    K_S32 = 25,
    K_U64V = 26,
    K_S64 = 27,
    K_F32 = 28,
    K_F64 = 29,
    K_C32 = 30,
    K_C64 = 31,
    K_BLOB = 32,
};

std::uint64_t words_to_u64(std::uint32_t lo, std::uint32_t hi)
{
    return static_cast<std::uint64_t>(lo) |
           (static_cast<std::uint64_t>(hi) << 32);
}

void u64_to_words(std::uint64_t value, std::uint32_t* out)
{
    if (!out) throw std::runtime_error("a two-word output pointer was null");
    out[0] = static_cast<std::uint32_t>(value);
    out[1] = static_cast<std::uint32_t>(value >> 32);
}

grworld::JsBlockWasm& block_from(int handle)
{
    if (!handle) throw std::runtime_error("the JavaScript block handle was null");
    return *reinterpret_cast<grworld::JsBlockWasm*>(
        static_cast<std::uintptr_t>(static_cast<std::uint32_t>(handle)));
}

template <typename F>
int guarded(F&& fn)
{
    try {
        g_last_error.clear();
        return fn();
    } catch (const std::exception& e) {
        g_last_error = e.what();
    } catch (...) {
        g_last_error = "an unrecognized C++ exception crossed the JavaScript PMT bridge";
    }
    return -1;
}

int type_of(const pmt::pmt_t& value)
{
    if (pmt::is_null(value)) return K_NIL;
    if (pmt::is_bool(value)) return K_BOOL;
    if (pmt::is_symbol(value)) return K_SYMBOL;
    if (pmt::is_integer(value)) return K_LONG;
    if (pmt::is_uint64(value)) return K_U64;
    if (pmt::is_real(value)) return K_REAL;
    if (pmt::is_complex(value)) return K_COMPLEX;
    // GNU Radio dictionaries are persistent pair lists, so this must precede
    // the generic pair check.
    if (pmt::is_dict(value)) return K_DICT;
    if (pmt::is_pair(value)) return K_PAIR;
    if (pmt::is_tuple(value)) return K_TUPLE;
    if (pmt::is_vector(value)) return K_VECTOR;
    if (pmt::is_u8vector(value)) return K_U8;
    if (pmt::is_s8vector(value)) return K_S8;
    if (pmt::is_u16vector(value)) return K_U16;
    if (pmt::is_s16vector(value)) return K_S16;
    if (pmt::is_u32vector(value)) return K_U32;
    if (pmt::is_s32vector(value)) return K_S32;
    if (pmt::is_u64vector(value)) return K_U64V;
    if (pmt::is_s64vector(value)) return K_S64;
    if (pmt::is_f32vector(value)) return K_F32;
    if (pmt::is_f64vector(value)) return K_F64;
    if (pmt::is_c32vector(value)) return K_C32;
    if (pmt::is_c64vector(value)) return K_C64;
    throw std::runtime_error("unsupported PMT type at the JavaScript boundary");
}

pmt::pmt_t make_uniform(int kind, std::size_t count)
{
    switch (kind) {
    case K_U8: return pmt::make_u8vector(count, 0);
    case K_S8: return pmt::make_s8vector(count, 0);
    case K_U16: return pmt::make_u16vector(count, 0);
    case K_S16: return pmt::make_s16vector(count, 0);
    case K_U32: return pmt::make_u32vector(count, 0);
    case K_S32: return pmt::make_s32vector(count, 0);
    case K_U64V: return pmt::make_u64vector(count, 0);
    case K_S64: return pmt::make_s64vector(count, 0);
    case K_F32: return pmt::make_f32vector(count, 0);
    case K_F64: return pmt::make_f64vector(count, 0);
    case K_C32: return pmt::make_c32vector(count, std::complex<float>());
    case K_C64: return pmt::make_c64vector(count, std::complex<double>());
    case K_BLOB: {
        std::vector<std::uint8_t> zeros(count);
        return pmt::make_blob(zeros.data(), zeros.size());
    }
    default: throw std::runtime_error("unknown uniform-vector PMT kind");
    }
}

} // namespace

namespace grworld {

JsPmtArenaScope::JsPmtArenaScope()
{
    if (g_arena_depth++ == 0) g_arena.clear();
}

JsPmtArenaScope::~JsPmtArenaScope()
{
    if (g_arena_depth && --g_arena_depth == 0) g_arena.clear();
}

int js_pmt_add(const pmt::pmt_t& value)
{
    if (!g_arena_depth)
        throw std::runtime_error("a PMT handle was created outside a JavaScript crossing");
    g_arena.push_back(value);
    return static_cast<int>(g_arena.size() - 1);
}

const pmt::pmt_t& js_pmt_get(int handle)
{
    if (handle < 0 || static_cast<std::size_t>(handle) >= g_arena.size())
        throw std::runtime_error("an invalid PMT handle reached the JavaScript bridge");
    return g_arena[static_cast<std::size_t>(handle)];
}

} // namespace grworld

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* gr_js_last_error()
{
    return g_last_error.c_str();
}

EMSCRIPTEN_KEEPALIVE int gr_js_pmt_type(int handle)
{
    return guarded([&] { return type_of(grworld::js_pmt_get(handle)); });
}

EMSCRIPTEN_KEEPALIVE double gr_js_pmt_real(int handle, int component)
{
    try {
        const auto& value = grworld::js_pmt_get(handle);
        g_last_error.clear();
        if (pmt::is_bool(value)) return pmt::to_bool(value) ? 1.0 : 0.0;
        if (pmt::is_integer(value)) return static_cast<double>(pmt::to_long(value));
        if (pmt::is_real(value)) return pmt::to_double(value);
        if (pmt::is_complex(value)) {
            const auto z = pmt::to_complex(value);
            return component ? z.imag() : z.real();
        }
        throw std::runtime_error("the PMT does not contain a numeric scalar");
    } catch (const std::exception& e) {
        g_last_error = e.what();
        return std::numeric_limits<double>::quiet_NaN();
    }
}

EMSCRIPTEN_KEEPALIVE int gr_js_pmt_u64(int handle, std::uint32_t* out)
{
    return guarded([&] {
        u64_to_words(pmt::to_uint64(grworld::js_pmt_get(handle)), out);
        return 0;
    });
}

EMSCRIPTEN_KEEPALIVE int gr_js_pmt_length(int handle)
{
    return guarded([&] {
        const auto& value = grworld::js_pmt_get(handle);
        if (pmt::is_dict(value)) return static_cast<int>(pmt::length(pmt::dict_keys(value)));
        return static_cast<int>(pmt::length(value));
    });
}

// op: 0 car, 1 cdr, 2 vector ref, 3 tuple ref, 4 dict key, 5 dict value.
EMSCRIPTEN_KEEPALIVE int gr_js_pmt_ref(int handle, int op, int index)
{
    return guarded([&] {
        const auto& value = grworld::js_pmt_get(handle);
        pmt::pmt_t result;
        switch (op) {
        case 0: result = pmt::car(value); break;
        case 1: result = pmt::cdr(value); break;
        case 2: result = pmt::vector_ref(value, static_cast<std::size_t>(index)); break;
        case 3: result = pmt::tuple_ref(value, static_cast<std::size_t>(index)); break;
        case 4: result = pmt::nth(static_cast<std::size_t>(index), pmt::dict_keys(value)); break;
        case 5: {
            const auto key = pmt::nth(static_cast<std::size_t>(index), pmt::dict_keys(value));
            result = pmt::dict_ref(value, key, pmt::PMT_NIL);
            break;
        }
        default: throw std::runtime_error("unknown PMT reference operation");
        }
        return grworld::js_pmt_add(result);
    });
}

EMSCRIPTEN_KEEPALIVE int gr_js_pmt_text(int handle, char* out, int cap)
{
    return guarded([&] {
        if (!out || cap < 1) throw std::runtime_error("the PMT text buffer was invalid");
        const std::string text = pmt::symbol_to_string(grworld::js_pmt_get(handle));
        const int n = std::min<int>(static_cast<int>(text.size()), cap - 1);
        std::memcpy(out, text.data(), static_cast<std::size_t>(n));
        out[n] = '\0';
        return n;
    });
}

// out = {pointer, element count, item size, kind}. The pointer is borrowed only
// until the outer crossing returns; JavaScript copies it before exposing it.
EMSCRIPTEN_KEEPALIVE int gr_js_pmt_blob(int handle, std::uint32_t* out)
{
    return guarded([&] {
        const auto& value = grworld::js_pmt_get(handle);
        const int kind = type_of(value);
        if (kind < K_U8 || kind > K_C64)
            throw std::runtime_error("the PMT is not a uniform vector or blob");
        std::size_t bytes = 0;
        const void* ptr = pmt::uniform_vector_elements(value, bytes);
        const std::size_t item_size = pmt::uniform_vector_itemsize(value);
        out[0] = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(ptr));
        out[1] = static_cast<std::uint32_t>(item_size ? bytes / item_size : 0);
        out[2] = static_cast<std::uint32_t>(item_size);
        out[3] = static_cast<std::uint32_t>(kind);
        return 0;
    });
}

// Scalar constructors. lo/hi carry an exact uint64; x/y carry real/complex.
EMSCRIPTEN_KEEPALIVE int gr_js_pmt_make(int kind,
                                        std::uint32_t lo,
                                        std::uint32_t hi,
                                        double x,
                                        double y,
                                        const char* text)
{
    return guarded([&] {
        pmt::pmt_t value;
        switch (kind) {
        case K_NIL: value = pmt::PMT_NIL; break;
        case K_BOOL: value = x ? pmt::PMT_T : pmt::PMT_F; break;
        case K_SYMBOL:
            if (!text) throw std::runtime_error("a PMT symbol needs text");
            value = pmt::intern(text);
            break;
        case K_LONG: value = pmt::from_long(static_cast<std::int32_t>(lo)); break;
        case K_U64: value = pmt::from_uint64(words_to_u64(lo, hi)); break;
        case K_REAL: value = pmt::from_double(x); break;
        case K_COMPLEX: value = pmt::from_complex(x, y); break;
        default: throw std::runtime_error("unknown scalar PMT kind");
        }
        return grworld::js_pmt_add(value);
    });
}

// Sequence constructors. Pair takes exactly two handles; vector/tuple take any.
EMSCRIPTEN_KEEPALIVE int gr_js_pmt_seq(int kind, const std::int32_t* handles, int count)
{
    return guarded([&] {
        if (count < 0 || (count && !handles))
            throw std::runtime_error("the PMT sequence handle array was invalid");
        if (kind == K_PAIR) {
            if (count != 2) throw std::runtime_error("a PMT pair needs two values");
            return grworld::js_pmt_add(
                pmt::cons(grworld::js_pmt_get(handles[0]), grworld::js_pmt_get(handles[1])));
        }
        auto vector = pmt::make_vector(static_cast<std::size_t>(count), pmt::PMT_NIL);
        for (int i = 0; i < count; ++i)
            pmt::vector_set(vector, static_cast<std::size_t>(i), grworld::js_pmt_get(handles[i]));
        if (kind == K_VECTOR) return grworld::js_pmt_add(vector);
        if (kind == K_TUPLE) return grworld::js_pmt_add(pmt::to_tuple(vector));
        throw std::runtime_error("unknown PMT sequence kind");
    });
}

// Alternating key/value handles.
EMSCRIPTEN_KEEPALIVE int gr_js_pmt_dict(const std::int32_t* handles, int count)
{
    return guarded([&] {
        if (count < 0 || (count % 2) || (count && !handles))
            throw std::runtime_error("a PMT dictionary needs key/value handle pairs");
        pmt::pmt_t dict = pmt::make_dict();
        for (int i = 0; i < count; i += 2)
            dict = pmt::dict_add(dict,
                                 grworld::js_pmt_get(handles[i]),
                                 grworld::js_pmt_get(handles[i + 1]));
        return grworld::js_pmt_add(dict);
    });
}

// Allocate writable PMT storage. out = {pointer, bytes, item size, kind}.
EMSCRIPTEN_KEEPALIVE int gr_js_pmt_blob_new(int kind, int count, std::uint32_t* out)
{
    return guarded([&] {
        if (count < 0 || !out) throw std::runtime_error("the PMT vector size was invalid");
        auto value = make_uniform(kind, static_cast<std::size_t>(count));
        std::size_t bytes = 0;
        void* ptr = pmt::uniform_vector_writable_elements(value, bytes);
        const std::size_t item_size = pmt::uniform_vector_itemsize(value);
        out[0] = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(ptr));
        out[1] = static_cast<std::uint32_t>(bytes);
        out[2] = static_cast<std::uint32_t>(item_size);
        out[3] = static_cast<std::uint32_t>(kind);
        return grworld::js_pmt_add(value);
    });
}

EMSCRIPTEN_KEEPALIVE int gr_js_tags(int block_handle,
                                    int port,
                                    std::uint32_t start_lo,
                                    std::uint32_t start_hi,
                                    std::uint32_t end_lo,
                                    std::uint32_t end_hi,
                                    int key_handle)
{
    return guarded([&] {
        const pmt::pmt_t* key = key_handle < 0 ? nullptr : &grworld::js_pmt_get(key_handle);
        return block_from(block_handle).bridge_get_tags(
            port, words_to_u64(start_lo, start_hi), words_to_u64(end_lo, end_hi), key);
    });
}

EMSCRIPTEN_KEEPALIVE int gr_js_tag_offset(int block_handle, int index, std::uint32_t* out)
{
    return guarded([&] {
        u64_to_words(block_from(block_handle).bridge_tag(index).offset, out);
        return 0;
    });
}

// field: 0 key, 1 value, 2 srcid.
EMSCRIPTEN_KEEPALIVE int gr_js_tag_field(int block_handle, int index, int field)
{
    return guarded([&] {
        const auto& tag = block_from(block_handle).bridge_tag(index);
        if (field == 0) return grworld::js_pmt_add(tag.key);
        if (field == 1) return grworld::js_pmt_add(tag.value);
        if (field == 2) return grworld::js_pmt_add(tag.srcid);
        throw std::runtime_error("unknown JavaScript tag field");
    });
}

EMSCRIPTEN_KEEPALIVE int gr_js_add_tag(int block_handle,
                                      int port,
                                      std::uint32_t off_lo,
                                      std::uint32_t off_hi,
                                      int key,
                                      int value,
                                      int srcid)
{
    return guarded([&] {
        block_from(block_handle).bridge_add_tag(
            port,
            words_to_u64(off_lo, off_hi),
            grworld::js_pmt_get(key),
            grworld::js_pmt_get(value),
            srcid < 0 ? pmt::PMT_F : grworld::js_pmt_get(srcid));
        return 0;
    });
}

EMSCRIPTEN_KEEPALIVE int gr_js_nitems(int block_handle, int written, int port, std::uint32_t* out)
{
    return guarded([&] {
        u64_to_words(block_from(block_handle).bridge_nitems(written != 0, port), out);
        return 0;
    });
}

EMSCRIPTEN_KEEPALIVE int gr_js_publish(int block_handle, int port_index, int message)
{
    return guarded([&] {
        block_from(block_handle).bridge_publish(port_index, grworld::js_pmt_get(message));
        return 0;
    });
}

} // extern "C"
