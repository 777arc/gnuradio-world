// Phase 6/7 foundation: prove the monolithic "everything is a builtin module"
// architecture — embed CPython and register a statically-linked extension via
// PyImport_AppendInittab (NO .so / no dynamic loading).
#include <Python.h>
extern "C" PyObject* PyInit_grtest(void);  // provided by the pybind PYBIND11_MODULE
int main(int argc, char** argv) {
    if (PyImport_AppendInittab("grtest", PyInit_grtest) != 0) return 2;
    Py_Initialize();
    int rc = PyRun_SimpleString(
        "import sys, grtest\n"
        "print('EMBED_OK', sys.version.split()[0], 'grtest.add(40,2)=', grtest.add(40,2))\n");
    Py_Finalize();
    return rc == 0 ? 0 : 1;
}
