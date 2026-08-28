#include <cstdlib>

// libosmocore's embedded allocator deliberately leaves these three primitives to
// its host. WebAssembly has an ordinary process-local heap, so malloc/free are
// the correct implementation here.
extern "C" void* pseudotalloc_malloc(size_t size) { return std::malloc(size); }
extern "C" void pseudotalloc_free(void* ptr) { std::free(ptr); }
extern "C" void* pseudotalloc_realloc(void* ptr, size_t size) { return std::realloc(ptr, size); }
