// Phase 6: trivial pybind11 extension built as an Emscripten SIDE_MODULE against
// our from-source CPython — validates the exact path gnuradio.gr bindings use.
#include <pybind11/pybind11.h>
static int add(int a, int b) { return a + b; }
PYBIND11_MODULE(grtest, m) {
    m.doc() = "phase6 pybind side-module test";
    m.def("add", &add, "add two ints");
    m.attr("answer") = 42;
}
