// RTTI and standard-exception ABI surface for side modules.
//
// A side module resolves symbols against the main module at dlopen time, and the
// main module is linked MAIN_MODULE=2: only symbols it actually references are
// present, and only present symbols can be exported (EXPORT_ALL=1 exports what is
// there, it does not pull anything in). The GR category modules never notice,
// because they use the same corners of the standard library the runner already
// uses.
//
// The USRP B2xx module does not. It carries its own copy of libc++ (see the
// pic/libc++-mt.a on its link line), which covers containers and algorithms, but
// the pieces below must NOT be duplicated: typeinfo objects are compared by
// address, so a second copy in the side module would make an exception thrown
// there uncatchable here. They have to live in the main module and be shared.
//
// Without this the side module fails to load with
//
//     bad export type for '_ZTIi': undefined
//
// one symbol at a time. Exporting them is handled separately, by
// gen_side_exports.py; this file only makes them present.
//
// A third category needs the same treatment for a different reason: functions
// Emscripten implements in JavaScript. -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE puts
// such a function in runner.js, but the dynamic loader hands a side module only
// what is in `wasmImports`, and a function lands there when the main module's
// *compiled code* imports it. So referencing it from C++ here is what actually
// makes it reachable. UHD's core drags in the Boost.Asio UDP transports even with
// every network device disabled, and those want getaddrinfo.
//
// Nothing calls force_side_module_abi(). It exists to be linked, not run, which
// is why it needs EMSCRIPTEN_KEEPALIVE -- without it wasm-ld garbage-collects the
// function and everything it pulled in, silently undoing the whole point.
#include <emscripten.h>
#include <emscripten/val.h>

#include <cxxabi.h>
#include <netdb.h>
#include <exception>
#include <new>
#include <stdexcept>
#include <string>
#include <typeinfo>

// val.h declares these only under C++20, because they exist to back `co_await`
// on an emscripten::val. The runner is C++17 and cannot host a coroutine, but
// libusb's WebUSB backend is C++20 and its promiseThen() *is* a coroutine that
// runs on the worker path -- so the main module has to supply them. They are
// extern "C", so declaring them here is enough to import them and pull in
// Emscripten's JavaScript implementations.
extern "C" {
void _emval_coro_suspend(emscripten::EM_VAL promise, void* coro_ptr);
emscripten::EM_VAL _emval_coro_make_promise(emscripten::EM_VAL* resolve,
                                            emscripten::EM_VAL* reject);
}

namespace {
volatile std::size_t abi_sink = 0;
void keep(const std::type_info& info) {
    abi_sink += reinterpret_cast<std::size_t>(&info);
}
enum AbiEnum { kAbiEnum };
void abi_function() {}
struct AbiPolymorphic { virtual ~AbiPolymorphic() = default; };
struct AbiDerived : AbiPolymorphic {};
}  // namespace

extern "C" EMSCRIPTEN_KEEPALIVE void force_side_module_abi() {
    keep(typeid(bool));
    keep(typeid(double));
    keep(typeid(unsigned char));
    keep(typeid(int));
    keep(typeid(unsigned int));
    keep(typeid(unsigned long));
    keep(typeid(unsigned short));
    keep(typeid(unsigned long long));

    // The __cxxabiv1 type_info subclasses whose vtables a side module references
    // when its RTTI involves enums, pointers or function types.
    keep(typeid(AbiEnum));
    keep(typeid(int*));
    keep(typeid(void (*)()));
    abi_sink += reinterpret_cast<std::size_t>(&abi_function);

    // Standard exception hierarchy: vtables, destructors and what().
    try { throw std::runtime_error("abi"); }
    catch (const std::exception& e) { abi_sink += std::string(e.what()).size(); }
    try { throw std::logic_error("abi"); }
    catch (const std::exception& e) { abi_sink += std::string(e.what()).size(); }
    try { throw std::invalid_argument("abi"); }
    catch (const std::invalid_argument& e) { abi_sink += std::string(e.what()).size(); }
    try { throw std::bad_exception(); }
    catch (const std::bad_exception& e) { abi_sink += std::string(e.what()).size(); }
    try { throw std::bad_alloc(); }
    catch (const std::bad_alloc& e) { abi_sink += std::string(e.what()).size(); }
    AbiPolymorphic base;
    try { abi_sink += reinterpret_cast<std::size_t>(&dynamic_cast<AbiDerived&>(base)); }
    catch (const std::bad_cast& e) { abi_sink += std::string(e.what()).size(); }

    abi_sink += reinterpret_cast<std::size_t>(std::get_new_handler());

    // embind entry points a side module imports. --bind alone is not enough:
    // embind's JavaScript library only emits the pieces the main module's own
    // code uses, and the runner never iterates an emscripten::val. libusb's
    // WebUSB backend does -- `for (auto&& device : navigator.usb.getDevices())`
    // -- so without this the side module loads and then dies at device
    // enumeration with "TypeError: resolved is not a function", which is what an
    // unresolved dynamic-linking stub looks like when it is finally called.
    {
        emscripten::val array = emscripten::val::array();
        for (auto&& item : array)
            abi_sink += reinterpret_cast<std::size_t>(&item);
    }

    abi_sink += reinterpret_cast<std::size_t>(&_emval_coro_suspend);
    abi_sink += reinterpret_cast<std::size_t>(&_emval_coro_make_promise);

    // JS-library functions a side module imports (see the note above).
    struct addrinfo* info = nullptr;
    if (getaddrinfo(nullptr, nullptr, nullptr, &info) == 0 && info) {
        freeaddrinfo(info);
    }
    abi_sink += reinterpret_cast<std::size_t>(gai_strerror(0));

    int status = 0;
    char* demangled = abi::__cxa_demangle("v", nullptr, nullptr, &status);
    abi_sink += reinterpret_cast<std::size_t>(demangled);
    std::free(demangled);
}
